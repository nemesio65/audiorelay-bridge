"use strict";

/**
 * PersistentBridge
 * ----------------
 * The top-level state machine. Keeps the Discord↔Matrix audio relay alive
 * indefinitely, recovering from any failure automatically.
 *
 * Lifecycle per call:
 *
 *   WAITING_FOR_CALL ──► (callStarted event from Matrix sync)
 *    │
 *    ▼
 *   CONNECTING_LIVEKIT ──► (LiveKit connected + membership published)
 *    │
 *    ▼
 *   CONNECTING_DISCORD ──► (Discord voice channel joined)
 *    │
 *    ▼
 *   BRIDGING ◄──────────── (steady state — audio flowing both ways)
 *    │
 *    │  Call ends (no participants)
 *    ▼
 *   RECOVERING ──► tear down Discord + LiveKit + relay → back to WAITING
 *
 * Discord voice is only connected while an Element Call is active.
 * This avoids holding an idle voice connection when nobody is calling.
 */

const MatrixClient     = require("../matrix/client");
const LiveKitClient    = require("../matrix/livekitClient");
const { AudioRelay }   = require("./audioRelay");
const { createLogger } = require("../utils/logger");
const { sleep }        = require("../utils/retry");
const config           = require("../../config");

const log = createLogger("Bridge");

const STATE = {
  IDLE:               "idle",
  WAITING_FOR_CALL:   "waiting_for_call",
  CONNECTING_LIVEKIT: "connecting_livekit",
  CONNECTING_DISCORD: "connecting_discord",
  BRIDGING:           "bridging",
  RECOVERING:         "recovering",
  STOPPED:            "stopped",
};

class PersistentBridge {
  constructor(discordClient) {
    this.discord  = discordClient;
    this.matrix   = new MatrixClient();
    this.livekit  = new LiveKitClient();
    this.relay    = null;

    this.state      = STATE.IDLE;
    this.startedAt  = null;
    this.callId     = null;
    this.deviceId   = null;
    this._stopping  = false;
    this._membershipPublished = false;
  }

  // ─── Startup ─────────────────────────────────────────────────────────────

  async start() {
    log.info("═══════════════════════════════════════════");
    log.info("  Persistent Matrix ↔ Discord Voice Bridge");
    log.info("═══════════════════════════════════════════");
    log.info(`  Discord channel : ${config.discord.channelId}`);
    log.info(`  Matrix room     : ${config.matrix.roomId}`);
    log.info("═══════════════════════════════════════════");

    // Attach listeners BEFORE starting sync to avoid race condition where
    // callStarted fires during the initial full sync before waitForCall()
    // has registered its listener. We buffer the latest call info here.
    this._pendingCall = null;
    this.matrix.on("callStarted", (info) => {
      log.debug("callStarted buffered:", info.callId);
      this._pendingCall = info; // overwrite with latest
      this._onCallStarted(info);
    });
    this.matrix.on("callEnded", () => {
      this._pendingCall = null;
      this._onCallEnded();
    });

    // Join Matrix room and start sync AFTER listeners are wired
    await this.matrix.joinRoom();
    // Clean up stale state keys from previous bridge runs
    await this.matrix.cleanupStaleCallMemberships();
    await this.matrix.startSync();

    // Discord is NOT started here — it connects per-call in _bridge()

    // Now run the call loop
    await this._runCallLoop();
  }

  // ─── Main loop ───────────────────────────────────────────────────────────

  /**
   * The outer loop: wait for a call, bridge it, wait for it to end, repeat.
   */
  async _runCallLoop() {
    while (!this._stopping) {
      try {
        this._setState(STATE.WAITING_FOR_CALL);

        // If a callStarted event arrived before we got here (race condition
        // during initial sync), use it immediately instead of waiting.
        let callInfo = this._pendingCall;
        this._pendingCall = null;

        if (callInfo) {
          log.info(`Using buffered call: ${callInfo.callId}`);
        } else {
          log.info("Waiting for an Element Call to start in the Matrix room...");
          await this.matrix.sendMessage(
            "🎙️ Voice bridge bot is online and waiting for an Element Call to start."
          ).catch(() => {});

          callInfo = await this.matrix.waitForCall(config.reconnect.callWaitMs);
        }

        await this._bridge(callInfo);

      } catch (err) {
        if (this._stopping) break;
        log.error("Error in call loop:", err.message);
        this._setState(STATE.RECOVERING);
        // Make sure everything is torn down before retrying
        await this._teardownAll();
        await sleep(config.reconnect.delayMs);
      }
    }

    log.info("Call loop exited.");
  }

  // ─── Bridging lifecycle ──────────────────────────────────────────────────

  async _bridge(callInfo) {
    const { callId, livekitUrl } = callInfo;
    log.info(`Bridging call: ${callId} @ ${livekitUrl}`);

    this._setState(STATE.CONNECTING_LIVEKIT);

    // Wait for the LiveKit room to exist and have participants.
    // auto_create:false means the room only exists when someone is in the call.
    await this._waitForParticipant(callId, livekitUrl);

    // Generate deviceId ONCE — used in both the LiveKit token identity
    // AND the Matrix membership state event so Element Call can match them
    const deviceId = `bridge_${Date.now()}`;

    // Get token with this specific deviceId baked into the identity
    const { token: tkn, url: lkUrl } = await this.matrix.getLiveKitToken(livekitUrl, callId, deviceId);

    // Connect LiveKit
    await this.livekit.connect(lkUrl, tkn);
    this.callId   = callId;
    this.deviceId = deviceId;

    // Publish MatrixRTC membership with matching device_id
    await this.matrix.publishCallMembership(callId, lkUrl, deviceId);
    this._membershipPublished = true;

    // NOW connect Discord voice — only when we have an active call
    this._setState(STATE.CONNECTING_DISCORD);
    log.info("Connecting Discord to voice channel...");
    await this.discord.start();
    log.info("✓ Discord voice channel connected");

    // Start audio relay
    this.relay = new AudioRelay(this.discord, this.livekit);
    this.relay.start();

    this._setState(STATE.BRIDGING);
    this.startedAt = new Date();

    await this.matrix.sendMessage(
      `✅ Voice bridge active: Discord ↔ Element Call (${callId})`
    ).catch(() => {});

    log.info("✓ Bridge is ACTIVE — audio flowing in both directions");

    // Wait until the call ends (resolved by _onCallEnded via event)
    await new Promise((resolve) => {
      this._resolveCurrentCall = resolve;
    });

    // Tear down everything — Discord, LiveKit, relay
    await this._teardownAll();
  }

  /**
   * Wait until the LiveKit room actually exists and has participants.
   * Matrix membership state can be stale — verify with LiveKit API directly.
   */
  async _waitForParticipant(callId, livekitUrl) {
    const { RoomServiceClient } = require("livekit-server-sdk");

    const httpUrl = livekitUrl
      .replace(/^wss:\/\//, "https://")
      .replace(/^ws:\/\//, "http://");

    log.info(`Waiting for LiveKit room to be active at ${httpUrl}...`);

    while (!this._stopping) {
      try {
        const svc   = new RoomServiceClient(httpUrl, config.livekit.apiKey, config.livekit.apiSecret);
        const rooms = await svc.listRooms();
        const room  = rooms.find(r => r.name === callId || r.sid === callId);

        if (room && room.numParticipants > 0) {
          log.info(`LiveKit room active — ${room.numParticipants} participant(s) present`);
          return;
        }

        if (room) {
          log.info("LiveKit room exists but is empty — waiting 3s...");
        } else {
          log.info("LiveKit room does not exist yet — waiting 3s...");
        }
      } catch (err) {
        log.debug(`LiveKit room check failed (${err.message}) — waiting 3s...`);
      }

      await new Promise(r => setTimeout(r, 3000));
    }
  }

  /**
   * Full teardown: relay + LiveKit membership + LiveKit + Discord voice.
   * Safe to call multiple times or when partially connected.
   */
  async _teardownAll() {
    // Stop audio relay
    if (this.relay) {
      this.relay.stop();
      this.relay = null;
    }

    // Remove MatrixRTC membership state so bot disappears from Element Call UI
    if (this.deviceId && this._membershipPublished) {
      await this.matrix.removeCallMembership(this.deviceId).catch(() => {});
      this._membershipPublished = false;
    }

    // Disconnect LiveKit
    await this.livekit.disconnect().catch(() => {});

    // Disconnect Discord voice — it will rejoin next call
    log.info("Disconnecting Discord voice...");
    await this.discord.stop().catch(() => {});
    log.info("✓ Discord voice disconnected");

    this.callId    = null;
    this.deviceId  = null;
    this.startedAt = null;
    log.info("Full teardown complete");
  }

  // ─── Event handlers ──────────────────────────────────────────────────────

  _onCallStarted(info) {
    // If we're already bridging this exact call, ignore
    if (this.state === STATE.BRIDGING && this.callId === info.callId) return;

    // If we're waiting, this resolves the waitForCall() promise via the event
    // (already handled in MatrixClient). This handler is for re-joins while bridging.
    log.debug("callStarted event received:", info.callId);
  }

  _onCallEnded() {
    // Only act on callEnded if we're actively bridging or connecting to a call
    const activeStates = [STATE.BRIDGING, STATE.CONNECTING_LIVEKIT, STATE.CONNECTING_DISCORD];
    if (!activeStates.includes(this.state)) {
      log.debug(`Ignoring callEnded in state: ${this.state}`);
      return;
    }

    log.info("Element Call ended — tearing down bridge");
    this._setState(STATE.RECOVERING);

    this.matrix.sendMessage("🔇 Element Call ended. Waiting for next call...").catch(() => {});

    // Resolve the promise in _bridge() so _runCallLoop continues
    if (this._resolveCurrentCall) {
      this._resolveCurrentCall();
      this._resolveCurrentCall = null;
    }
  }

  // ─── State ───────────────────────────────────────────────────────────────

  _setState(state) {
    this.state = state;
    log.info(`Bridge state: ${state}`);
    this.emit?.("stateChange", state);
  }

  status() {
    return {
      state:          this.state,
      discordReady:   this.discord.isReady,
      livekitReady:   this.livekit.isReady,
      relayActive:    this.relay?.isRunning ?? false,
      callId:         this.callId,
      startedAt:      this.startedAt,
      matrixRoom:     config.matrix.roomId,
      discordChannel: config.discord.channelId,
    };
  }

  async stop() {
    this._stopping = true;
    log.info("Stopping persistent bridge...");

    if (this._resolveCurrentCall) {
      this._resolveCurrentCall();
      this._resolveCurrentCall = null;
    }

    await this._teardownAll().catch(() => {});
    this.matrix.stopSync();

    this._setState(STATE.STOPPED);
    log.info("Bridge stopped.");
  }
}

module.exports = { PersistentBridge, STATE };