"use strict";

const { createLogger } = require("../utils/logger");
const log = createLogger("Relay");

const SAMPLE_RATE     = 48000;
const CHANNELS        = 2;
const FRAME_MS        = 20;
const BYTES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS * CHANNELS * 2; // 3840

class PCMMixer {
  constructor(name, onFrame) {
    this.name = name; this.onFrame = onFrame;
    this._bufs = new Map(); this._timer = null;
  }
  /** Start with internal 20ms clock (used for M→D direction) */
  start() { this._timer = setInterval(() => this._tick(), FRAME_MS); }
  /** Start without internal clock — caller uses pull() instead */
  startPassive() { /* no timer — pull() is called externally */ }
  stop()  { if (this._timer) clearInterval(this._timer); this._timer = null; this._bufs.clear(); }
  push(id, pcm) {
    if (!this._bufs.has(id)) this._bufs.set(id, []);
    const q = this._bufs.get(id);
    // Drop oldest if queue gets too deep (>5 frames = 100ms) to prevent stale audio buildup
    while (q.length > 5) q.shift();
    q.push(pcm);
  }
  /**
   * Pull one mixed frame. Returns a Buffer or null if no audio is buffered.
   * Used when an external clock drives the output (e.g. LiveKit output loop).
   */
  pull() {
    const contrib = [];
    for (const [id, q] of this._bufs) {
      const f = this._drain(q, BYTES_PER_FRAME);
      if (f) contrib.push(f);
      if (q.length === 0) this._bufs.delete(id);
    }
    if (!contrib.length) return null;
    return contrib.length === 1 ? contrib[0] : this._mix(contrib);
  }
  _drain(q, n) {
    n = n - (n % 2); // ensure 16-bit sample alignment — never split a sample
    let got = 0; const parts = [];
    while (q.length && got < n) {
      const c = q[0], take = Math.min(c.length, n - got);
      // Ensure take is also 16-bit aligned
      const alignedTake = take - (take % 2);
      if (alignedTake <= 0) { q.shift(); continue; }
      parts.push(c.slice(0, alignedTake)); got += alignedTake;
      if (alignedTake < c.length) { q[0] = c.slice(alignedTake); } else { q.shift(); }
    }
    return parts.length ? Buffer.concat(parts) : null;
  }
  _tick() {
    const frame = this.pull();
    if (frame) this.onFrame(frame);
  }
  _mix(bufs) {
    const len = Math.min(...bufs.map(b => b.length));
    const al  = len - (len % 4);
    const out = Buffer.alloc(al);
    for (let i = 0; i < al; i += 2) {
      let s = 0;
      for (const b of bufs) { if (i + 1 < b.length) s += b.readInt16LE(i); }
      out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i);
    }
    return out;
  }
}

class AudioRelay {
  constructor(discord, livekit) {
    this.discord  = discord;
    this.livekit  = livekit;
    this.isRunning = false;

    // Discord → Matrix mixer (passive — LiveKit output loop pulls from it)
    this._d2mMixer = new PCMMixer("D→M", null);

    // Matrix → Discord mixer (active — its own 20ms clock pushes to Discord)
    this._m2dMixer = new PCMMixer("M→D", (frame) => {
      this.discord.sendAudio(frame);
    });

    this._discordHandler = null;
    this._matrixHandler  = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Discord audio → Matrix
    let _dFrameCount = 0;
    this._discordHandler = ({ userId, pcm }) => {
      _dFrameCount++;
      if (_dFrameCount <= 3) log.debug(`Discord audio frame: ${pcm.length} bytes from ${userId}`);
      this._d2mMixer.push(userId, pcm);
    };
    this.discord.on("audioPacket", this._discordHandler);

    // Matrix audio → Discord (resample if needed)
    this._matrixHandler = ({ userId, pcm, sampleRate, channels }) => {
      // If already 48kHz stereo, use directly
      if ((!sampleRate || sampleRate === SAMPLE_RATE) && (!channels || channels === CHANNELS)) {
        this._m2dMixer.push(userId, pcm);
      } else {
        // Resample via ffmpeg
        this._resample(pcm, sampleRate || SAMPLE_RATE, channels || CHANNELS)
          .then((normalized) => this._m2dMixer.push(userId, normalized))
          .catch((err) => log.warn("Resample failed for " + userId + ":", err.message));
      }
    };
    this.livekit.on("audioPacket", this._matrixHandler);

    this._d2mMixer.startPassive();
    this._m2dMixer.start();

    // Tell LiveKit to pull mixed D→M audio directly from the mixer
    // on its own 20ms output clock — single clock, zero drift
    this.livekit.setAudioSource(this._d2mMixer);

    log.info("Audio relay started ✓");
  }

  /**
   * Normalise a PCM buffer to 48kHz stereo 16-bit synchronously.
   * Handles mono→stereo upmix and sample rate differences.
   * For already-correct format, returns the buffer directly (zero copy).
   */
  _normalise(pcm, srcRate, srcChannels) {
    // Fast path: already stereo 48kHz
    if (srcRate === SAMPLE_RATE && srcChannels === CHANNELS) return pcm;

    // Mono → stereo upmix (synchronous, no subprocess needed)
    if (srcRate === SAMPLE_RATE && srcChannels === 1) {
      const samples = pcm.length / 2; // number of mono samples
      const out = Buffer.alloc(samples * 4); // stereo = 2x samples * 2 bytes
      for (let i = 0; i < samples; i++) {
        const val = pcm.readInt16LE(i * 2);
        out.writeInt16LE(val, i * 4);     // left
        out.writeInt16LE(val, i * 4 + 2); // right (duplicate)
      }
      return out;
    }

    // Different sample rate — use async FFmpeg (queued, not blocking)
    this._resample(pcm, srcRate, srcChannels)
      .then((out) => {
        // Re-normalise in case FFmpeg output is still mono
        const final = (srcChannels === 1)
          ? this._normalise(out, SAMPLE_RATE, 1)
          : out;
        // Push directly — bypasses this._normalise to avoid recursion
        if (final) this._m2dMixer.push("__resampled__", final);
      })
      .catch((err) => log.warn("Resample error:", err.message));

    return null; // async path handles it
  }

  _resample(input, srcRate, srcChannels) {
    const { spawn } = require("child_process");
    const ffmpeg = (() => { try { return require("ffmpeg-static"); } catch { return "ffmpeg"; } })();
    return new Promise((resolve, reject) => {
      const ff = spawn(ffmpeg, [
        "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", String(srcRate), "-ac", String(srcChannels), "-i", "pipe:0",
        "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "pipe:1",
      ]);
      const chunks = [];
      ff.stdout.on("data", (d) => chunks.push(d));
      ff.on("close", (code) => {
        if (code !== 0) return reject(new Error("ffmpeg exited " + code));
        resolve(Buffer.concat(chunks));
      });
      ff.on("error", reject);
      ff.stdin.write(input);
      ff.stdin.end();
    });
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this._discordHandler) {
      this.discord.removeListener("audioPacket", this._discordHandler);
      this._discordHandler = null;
    }
    if (this._matrixHandler) {
      this.livekit.removeListener("audioPacket", this._matrixHandler);
      this._matrixHandler = null;
    }
    this._d2mMixer.stop();
    this._m2dMixer.stop();
    log.info("Audio relay stopped");
  }
}

module.exports = { AudioRelay, PCMMixer };