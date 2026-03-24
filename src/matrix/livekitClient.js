"use strict";

const { EventEmitter }   = require("events");
const { createLogger }   = require("../utils/logger");
const { retryWithBackoff } = require("../utils/retry");

const log = createLogger("LiveKit");

class LiveKitClient extends EventEmitter {
  constructor() {
    super();
    this.room        = null;
    this._audioSrc   = null;
    this._audioTrack = null;
    this._lk         = null;
    this.isReady     = false;
    this._stopping   = false;
  }

  async connect(livekitUrl, token) {
    // Reset stopping flag — critical for reconnects after teardown,
    // otherwise the retry loop aborts immediately
    this._stopping = false;

    let lk;
    try { lk = require("@livekit/rtc-node"); }
    catch { throw new Error("@livekit/rtc-node not installed."); }
    this._lk = lk;
    await retryWithBackoff(
      () => this._connect(lk, livekitUrl, token),
      {
        name:   "LiveKit connect",
        baseMs: 5000,
        maxMs:  15000, // cap backoff at 15s — don't wait too long for room to appear
        max:    0,
        signal: () => this._stopping,
      }
    );
  }

  async _connect(lk, url, token) {
    if (this.room) { try { await this.room.disconnect(); } catch {} this.room = null; }
    this.room = new lk.Room();

    this.room.on(lk.RoomEvent.ParticipantConnected, (p) => {
      log.info("Matrix participant joined: " + p.identity);
      this._subscribeAll(p, lk);
      this.emit("participantJoined", p);
    });
    this.room.on(lk.RoomEvent.ParticipantDisconnected, (p) => {
      log.info("Matrix participant left: " + p.identity);
      this.emit("participantLeft", p);
    });
    this.room.on(lk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== lk.TrackKind.KIND_AUDIO) return;
      log.debug("Subscribed to audio from: " + participant.identity);
      let _frameCount = 0;
      const stream = (() => {
        try { return new lk.AudioStream(track, 48000, 2); }
        catch { return new lk.AudioStream(track); }
      })();
      (async () => {
        for await (const frame of stream) {
          _frameCount++;
          if (_frameCount === 1) {
            // frame.channels is the correct property in @livekit/rtc-node v0.9.x
            log.info(`LiveKit audio: ${frame.sampleRate}Hz ${frame.channels}ch ${frame.samplesPerChannel} samples/frame (${frame.data.byteLength} bytes) from ${participant.identity}`);
          }
          const pcm = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
          this.emit("audioPacket", {
            userId:     participant.identity,
            pcm,
            sampleRate: frame.sampleRate,
            channels:   frame.channels,   // ← correct property name
          });
        }
      })().catch((err) => { if (!this._stopping) log.warn("AudioStream error:", err.message); });
    });
    this.room.on(lk.RoomEvent.Disconnected, async (reason) => {
      if (this._stopping) return;
      log.warn("LiveKit disconnected (" + reason + ") — reconnecting...");
      this.isReady = false;
      this.emit("disconnected");
      await this._connect(lk, url, token);
    });

    log.info("Connecting to LiveKit at " + url);
    await this.room.connect(url, token, { autoSubscribe: true });
    for (const p of this.room.remoteParticipants.values()) this._subscribeAll(p, lk);

    this._audioSrc   = new lk.AudioSource(48000, 2);
    this._audioTrack = lk.LocalAudioTrack.createAudioTrack("discord-relay", this._audioSrc);
    const pubOptions = new lk.TrackPublishOptions();
    // Element Call requires MICROPHONE source to display the participant correctly
    if (lk.TrackSource) {
      try { pubOptions.source = lk.TrackSource.SOURCE_MICROPHONE; } catch {}
    }
    await this.room.localParticipant.publishTrack(this._audioTrack, pubOptions);
    log.info("Published audio track — waiting for output loop to confirm frames flow");

    // Note: setMetadata not available in @livekit/rtc-node v0.9.x

    this.isReady = true;
    log.info("✓ Connected to LiveKit room and published audio track");

    // Single clock-driven output loop: sends real audio when available,
    // silence when not. Keeps the track alive for Element Call.
    this._startOutputLoop();

    this.emit("ready");
  }

  /**
   * Single clock-driven output loop.
   * Pulls mixed audio directly from the D→M mixer — one clock, zero drift.
   * Sends silence when no audio is available to keep the track alive.
   */
  _startOutputLoop() {
    if (this._outputTimer) clearInterval(this._outputTimer);
    this._outputBusy    = false;
    this._silenceCount  = 0;
    this._audioMixer    = null; // set by setAudioSource()
    this._skipCount     = 0;
    this._framesSent    = 0;
    this._lastStatLog   = 0;

    const FRAME_SAMPLES = 960; // 20ms at 48kHz
    const silence = new Int16Array(FRAME_SAMPLES * 2); // stereo zeros

    this._outputTimer = setInterval(async () => {
      if (!this._audioSrc || !this.isReady || this._stopping) return;
      if (this._outputBusy) {
        this._skipCount++;
        return;
      }
      this._outputBusy = true;
      try {
        // Pull mixed audio directly from the relay mixer (if attached)
        const pcmBuffer = this._audioMixer ? this._audioMixer.pull() : null;

        if (pcmBuffer) {
          // Copy into a properly aligned Int16Array to avoid byteOffset alignment issues
          // Buffer.concat can return buffers with odd byteOffset which corrupts Int16Array views
          const samples = new Int16Array(pcmBuffer.length / 2);
          for (let i = 0; i < samples.length; i++) {
            samples[i] = pcmBuffer.readInt16LE(i * 2);
          }
          const frame = new this._lk.AudioFrame(samples, 48000, 2, samples.length / 2);
          await this._audioSrc.captureFrame(frame);
          this._framesSent++;
          this._silenceCount = 0; // reset so we can track silence gaps
        } else {
          // No real audio — send silence to keep track alive
          const frame = new this._lk.AudioFrame(silence, 48000, 2, FRAME_SAMPLES);
          await this._audioSrc.captureFrame(frame);
          this._silenceCount++;
          if (this._silenceCount === 1)  log.info("✓ First silence frame sent to LiveKit");
          if (this._silenceCount === 50) log.info("✓ 50 silence frames sent — track is live");
        }

        // Periodic stats (every 10s) to diagnose quality issues
        const now = Date.now();
        if (now - this._lastStatLog > 10000) {
          if (this._framesSent > 0 || this._skipCount > 0) {
            log.debug(`LiveKit output: ${this._framesSent} audio frames, ${this._skipCount} skipped ticks in last 10s`);
          }
          this._framesSent = 0;
          this._skipCount  = 0;
          this._lastStatLog = now;
        }
      } catch (err) {
        if (this._silenceCount < 5) log.warn("captureFrame error:", err.message);
      } finally {
        this._outputBusy = false;
      }
    }, 20);

    log.debug("LiveKit output loop started");
  }

  _subscribeAll(participant, lk) {
    for (const pub of participant.trackPublications.values()) {
      if (pub.kind === lk.TrackKind.KIND_AUDIO && !pub.isSubscribed) pub.setSubscribed(true);
    }
  }

  /**
   * Attach a PCMMixer as the audio source. The output loop will call
   * mixer.pull() each tick instead of using an internal queue.
   */
  setAudioSource(mixer) {
    this._audioMixer = mixer;
    log.debug("Audio source attached — pulling from mixer");
  }

  /**
   * Legacy queue-based sendAudio (unused when mixer is attached, but kept
   * as fallback for direct frame injection if needed).
   */
  sendAudio(pcmBuffer) {
    if (!this._audioSrc || !this.isReady) return;
    // If mixer is attached, this shouldn't be called — log a warning
    if (this._audioMixer) {
      log.warn("sendAudio called while mixer is attached — ignoring");
      return;
    }
  }

  async disconnect() {
    this._stopping = true;
    this.isReady   = false;
    this._audioMixer = null;
    if (this._outputTimer) { clearInterval(this._outputTimer); this._outputTimer = null; }
    if (this.room) { try { await this.room.disconnect(); } catch {} this.room = null; }
    this._audioSrc = null; this._audioTrack = null;
  }
}

module.exports = LiveKitClient;