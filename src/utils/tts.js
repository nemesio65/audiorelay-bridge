"use strict";

/**
 * TTS Utility
 * -----------
 * Generates 48kHz stereo 16-bit PCM audio from text.
 *
 * Strategy:
 *   1. Try espeak-ng (commonly available on Linux)
 *   2. Try pico2wave (better quality, less common)
 *   3. Fallback: a short notification tone (still useful as an audible cue)
 *
 * All outputs are normalised to 48000Hz, stereo, s16le — ready to push
 * directly into the PCMMixer or Discord audio pipeline.
 */

const { spawn, execSync } = require("child_process");
const { createLogger }    = require("./logger");
const fs                   = require("fs");
const path                 = require("path");
const os                   = require("os");

const log = createLogger("TTS");

let _ttsEngine = null;

function detectEngine() {
  if (_ttsEngine !== null) return _ttsEngine;

  try { execSync("which espeak-ng", { stdio: "ignore" }); _ttsEngine = "espeak-ng"; log.info("TTS engine: espeak-ng"); return _ttsEngine; } catch {}
  try { execSync("which espeak",    { stdio: "ignore" }); _ttsEngine = "espeak";    log.info("TTS engine: espeak");    return _ttsEngine; } catch {}
  try { execSync("which pico2wave", { stdio: "ignore" }); _ttsEngine = "pico2wave"; log.info("TTS engine: pico2wave"); return _ttsEngine; } catch {}

  _ttsEngine = "tone";
  log.warn("No TTS engine found (espeak-ng, espeak, pico2wave) — using notification tone fallback");
  return _ttsEngine;
}

/**
 * Generate PCM audio (48kHz, stereo, s16le) from text.
 * Returns a Buffer of raw PCM data with volume applied.
 *
 * @param {string} text - Text to speak
 * @param {object} opts
 * @param {number} opts.speed  - Words per minute (default: 160)
 * @param {number} opts.volume - Volume multiplier 0.0–1.0 (default: 0.20 = 20%)
 * @returns {Promise<Buffer>} Raw PCM buffer (48kHz stereo s16le)
 */
async function textToSpeech(text, opts = {}) {
  const engine = detectEngine();
  const speed  = opts.speed  || 160;
  const volume = opts.volume ?? 0.20;

  let pcm;
  try {
    switch (engine) {
      case "espeak-ng":
      case "espeak":
        pcm = await _espeakToPCM(engine, text, speed);
        break;
      case "pico2wave":
        pcm = await _picoToPCM(text);
        break;
      default:
        pcm = _generateTone(0.5);
        break;
    }
  } catch (err) {
    log.warn(`TTS failed (${engine}): ${err.message} — using tone fallback`);
    pcm = _generateTone(0.5);
  }

  // Apply volume scaling
  if (pcm && volume < 1.0) {
    pcm = _applyVolume(pcm, volume);
  }

  return pcm;
}

/**
 * Scale PCM samples by a volume multiplier.
 * @param {Buffer} pcm - s16le PCM buffer
 * @param {number} vol - 0.0 to 1.0
 * @returns {Buffer}
 */
function _applyVolume(pcm, vol) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * vol)));
    out.writeInt16LE(scaled, i);
  }
  return out;
}

/**
 * espeak/espeak-ng → stdout as raw audio → ffmpeg resample to 48kHz stereo
 */
function _espeakToPCM(bin, text, speed) {
  return new Promise((resolve, reject) => {
    const ffmpegBin = _ffmpegPath();

    const espeak = spawn(bin, [
      "--stdout",
      "-s", String(speed),
      "-v", "en",
      text,
    ]);

    const ff = spawn(ffmpegBin, [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "s16le", "-ar", "48000", "-ac", "2",
      "pipe:1",
    ]);

    espeak.stdout.pipe(ff.stdin);
    espeak.stderr.on("data", () => {});

    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", () => {});

    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`));
      resolve(Buffer.concat(chunks));
    });
    ff.on("error", reject);
    espeak.on("error", reject);
  });
}

/**
 * pico2wave → temp WAV file → ffmpeg resample to 48kHz stereo
 */
function _picoToPCM(text) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `tts_${Date.now()}.wav`);
    const ffmpegBin = _ffmpegPath();

    const pico = spawn("pico2wave", ["-w", tmpFile, "-l", "en-US", text]);
    pico.on("error", reject);
    pico.on("close", (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(tmpFile); } catch {}
        return reject(new Error(`pico2wave exited ${code}`));
      }

      const ff = spawn(ffmpegBin, [
        "-hide_banner", "-loglevel", "error",
        "-i", tmpFile,
        "-f", "s16le", "-ar", "48000", "-ac", "2",
        "pipe:1",
      ]);

      const chunks = [];
      ff.stdout.on("data", (d) => chunks.push(d));
      ff.on("close", (ffCode) => {
        try { fs.unlinkSync(tmpFile); } catch {}
        if (ffCode !== 0) return reject(new Error(`ffmpeg exited ${ffCode}`));
        resolve(Buffer.concat(chunks));
      });
      ff.on("error", (err) => {
        try { fs.unlinkSync(tmpFile); } catch {}
        reject(err);
      });
    });
  });
}

/**
 * Generate a simple notification tone as PCM.
 */
function _generateTone(durationSec) {
  const sampleRate = 48000;
  const channels   = 2;
  const totalSamples = Math.floor(sampleRate * durationSec);
  const buf = Buffer.alloc(totalSamples * channels * 2);
  const half = Math.floor(totalSamples / 2);

  for (let i = 0; i < totalSamples; i++) {
    const freq = i < half ? 880 : 1100;
    const env = Math.min(1, Math.min(i, totalSamples - i) / (sampleRate * 0.01));
    const sample = Math.floor(Math.sin(2 * Math.PI * freq * i / sampleRate) * 8000 * env);
    const offset = i * channels * 2;
    buf.writeInt16LE(sample, offset);
    buf.writeInt16LE(sample, offset + 2);
  }

  return buf;
}

function _ffmpegPath() {
  try { return require("ffmpeg-static"); }
  catch { return "ffmpeg"; }
}

module.exports = { textToSpeech, detectEngine };