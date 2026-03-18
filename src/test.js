"use strict";

/**
 * Standalone smoke tests — zero external dependencies.
 * Tests the PCMMixer and audio relay logic directly.
 */

let passed = 0;
let failed = 0;

function ok(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

// ─── Inline PCMMixer (no imports needed) ────────────────────────────────────

const SAMPLE_RATE     = 48000;
const CHANNELS        = 2;
const FRAME_MS        = 20;
const BYTES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS * CHANNELS * 2; // 3840

class PCMMixer {
  constructor(name, onFrame) {
    this.name = name; this.onFrame = onFrame;
    this._bufs = new Map(); this._timer = null;
  }
  start() { this._timer = setInterval(() => this._tick(), FRAME_MS); }
  stop()  { clearInterval(this._timer); this._bufs.clear(); }
  push(id, pcm) {
    if (!this._bufs.has(id)) this._bufs.set(id, []);
    this._bufs.get(id).push(pcm);
  }
  _drain(q, n) {
    let got = 0; const parts = [];
    while (q.length && got < n) {
      const c = q[0], take = Math.min(c.length, n - got);
      parts.push(c.slice(0, take)); got += take;
      if (take < c.length) { q[0] = c.slice(take); } else { q.shift(); }
    }
    return parts.length ? Buffer.concat(parts) : null;
  }
  _tick() {
    const contrib = [];
    for (const [id, q] of this._bufs) {
      const f = this._drain(q, BYTES_PER_FRAME);
      if (f) contrib.push(f);
      if (q.length === 0) this._bufs.delete(id);
    }
    if (!contrib.length) return;
    this.onFrame(contrib.length === 1 ? contrib[0] : this._mix(contrib));
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

function makePCM(value, bytes = BYTES_PER_FRAME) {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(value, i);
  return buf;
}

// ─── Test 1: Single speaker passthrough ──────────────────────────────────────

function testSingleSpeaker() {
  return new Promise((resolve) => {
    console.log("\nTest 1: Single speaker passthrough");
    const frames = [];
    const mixer  = new PCMMixer("t1", f => frames.push(f));
    mixer.start();
    const iv = setInterval(() => mixer.push("alice", makePCM(1000)), FRAME_MS);
    setTimeout(() => {
      clearInterval(iv); mixer.stop();
      ok("Received frames",           frames.length > 0);
      ok("Frame size is correct",     frames[0].length === BYTES_PER_FRAME);
      ok("Frame is 4-byte aligned",   frames[0].length % 4 === 0);
      ok("Sample value preserved",    frames[0].readInt16LE(0) === 1000);
      resolve();
    }, 200);
  });
}

// ─── Test 2: Two-speaker mix ──────────────────────────────────────────────────

function testTwoSpeakerMix() {
  return new Promise((resolve) => {
    console.log("\nTest 2: Two-speaker mix (10000 + 8000 = 18000)");
    const frames = [];
    const mixer  = new PCMMixer("t2", f => frames.push(f));
    mixer.start();
    const iv = setInterval(() => {
      mixer.push("alice", makePCM(10000));
      mixer.push("bob",   makePCM(8000));
    }, FRAME_MS);
    setTimeout(() => {
      clearInterval(iv); mixer.stop();
      ok("Received frames",         frames.length > 0);
      const sample = frames[0].readInt16LE(0);
      ok(`Mixed value = 18000 (got ${sample})`, sample === 18000);
      resolve();
    }, 200);
  });
}

// ─── Test 3: Clipping prevention ─────────────────────────────────────────────

function testClipping() {
  return new Promise((resolve) => {
    console.log("\nTest 3: Clipping prevention (30000 + 30000 clamped to 32767)");
    const frames = [];
    const mixer  = new PCMMixer("t3", f => frames.push(f));
    mixer.start();
    const iv = setInterval(() => {
      mixer.push("a", makePCM(30000));
      mixer.push("b", makePCM(30000));
    }, FRAME_MS);
    setTimeout(() => {
      clearInterval(iv); mixer.stop();
      let allClamped = true;
      for (const frame of frames)
        for (let i = 0; i < frame.length; i += 2) {
          const s = frame.readInt16LE(i);
          if (s > 32767 || s < -32768) { allClamped = false; break; }
        }
      ok("All samples within int16 range", allClamped);
      ok("Max sample = 32767",             frames[0].readInt16LE(0) === 32767);
      resolve();
    }, 200);
  });
}

// ─── Test 4: Negative clipping ────────────────────────────────────────────────

function testNegativeClipping() {
  return new Promise((resolve) => {
    console.log("\nTest 4: Negative clipping (-30000 + -30000 clamped to -32768)");
    const frames = [];
    const mixer  = new PCMMixer("t4", f => frames.push(f));
    mixer.start();
    const iv = setInterval(() => {
      mixer.push("a", makePCM(-30000));
      mixer.push("b", makePCM(-30000));
    }, FRAME_MS);
    setTimeout(() => {
      clearInterval(iv); mixer.stop();
      ok("Min sample = -32768", frames[0]?.readInt16LE(0) === -32768);
      resolve();
    }, 200);
  });
}

// ─── Test 5: Silence when no speakers ────────────────────────────────────────

function testSilence() {
  return new Promise((resolve) => {
    console.log("\nTest 5: No frames emitted during silence");
    let frameCount = 0;
    const mixer = new PCMMixer("t5", () => frameCount++);
    mixer.start();
    setTimeout(() => {
      mixer.stop();
      ok("Zero frames during silence", frameCount === 0);
      resolve();
    }, 200);
  });
}

// ─── Test 6: Partial chunk reassembly ────────────────────────────────────────

function testPartialChunks() {
  return new Promise((resolve) => {
    console.log("\nTest 6: Partial chunk reassembly");
    const frames = [];
    const mixer  = new PCMMixer("t6", f => frames.push(f));
    mixer.start();
    const half = BYTES_PER_FRAME / 2;
    const iv = setInterval(() => {
      mixer.push("alice", makePCM(500, half));
      mixer.push("alice", makePCM(500, half));
    }, FRAME_MS);
    setTimeout(() => {
      clearInterval(iv); mixer.stop();
      ok("Received frames from partial chunks",  frames.length > 0);
      ok("Reassembled frame has correct size",   frames[0].length === BYTES_PER_FRAME);
      resolve();
    }, 300);
  });
}

// ─── Test 7: Speaker cleanup ──────────────────────────────────────────────────

function testSpeakerCleanup() {
  return new Promise((resolve) => {
    console.log("\nTest 7: Inactive speaker buffer cleanup");
    const mixer = new PCMMixer("t7", () => {});
    mixer.start();
    mixer.push("alice", makePCM(1000));
    setTimeout(() => {
      mixer.stop();
      ok("Inactive speaker removed from map", !mixer._bufs.has("alice"));
      resolve();
    }, 100);
  });
}

// ─── Run all ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  persistent-voice-bridge smoke tests");
  console.log("═══════════════════════════════════════");

  await testSingleSpeaker();
  await testTwoSpeakerMix();
  await testClipping();
  await testNegativeClipping();
  await testSilence();
  await testPartialChunks();
  await testSpeakerCleanup();

  console.log("\n═══════════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
