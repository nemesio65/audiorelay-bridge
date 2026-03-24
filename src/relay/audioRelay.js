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
  /** Start with internal 20ms clock (used when an active clock is needed) */
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
   * Used when an external clock drives the output (e.g. LiveKit or Discord output loop).
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
    n = n - (n % 2); // ensure 16-bit sample alignment
    let got = 0; const parts = [];
    while (q.length && got < n) {
      const c = q[0], take = Math.min(c.length, n - got);
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

    // Matrix → Discord mixer (passive — Discord output loop pulls from it)
    // Previously this used an active 20ms clock, but that created a second
    // independent timer that drifted against the Discord output loop's timer,
    // causing latency to accumulate over ~10 minutes.
    this._m2dMixer = new PCMMixer("M→D", null);

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
      if ((!sampleRate || sampleRate === SAMPLE_RATE) && (!channels || channels === CHANNELS)) {
        this._m2dMixer.push(userId, pcm);
      } else {
        this._resample(pcm, sampleRate || SAMPLE_RATE, channels || CHANNELS)
          .then((normalized) => this._m2dMixer.push(userId, normalized))
          .catch((err) => log.warn("Resample failed for " + userId + ":", err.message));
      }
    };
    this.livekit.on("audioPacket", this._matrixHandler);

    // Both mixers are passive — no internal timers
    this._d2mMixer.startPassive();
    this._m2dMixer.startPassive();

    // D→M: LiveKit output loop pulls from d2mMixer on its own 20ms clock
    this.livekit.setAudioSource(this._d2mMixer);

    // M→D: Discord output loop pulls from m2dMixer on its own 20ms clock
    this.discord.setAudioSource(this._m2dMixer);

    log.info("Audio relay started ✓ (single-clock per direction, zero drift)");
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