"use strict";

/**
 * PersistentBridge
 * ----------------
 * Architecture:
 *
 *   BOOT (persistent):
 *     • Discord gateway
 *     • Matrix sync loop
 *     • PresenceTracker (text always, TTS per-call)
 *
 *   PER-CALL:
 *     • Get LiveKit token via OpenID → lk-jwt-service (or self-sign fallback)
 *     • Connect LiveKit
 *     • Connect Discord voice
 *     • AudioRelay + TTS
 */

const MatrixClient        = require("../matrix/client");
const LiveKitClient       = require("../matrix/livekitClient");
const { AudioRelay }      = require("./audioRelay");
const { PresenceTracker } = require("./presenceTracker");
const { createLogger }    = require("../utils/logger");
const { sleep }           = require("../utils/retry");
const { retryWithBackoff } = require("../utils/retry");
const config              = require("../../config");

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
    this.presence = null;

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

    await this.discord.startGateway();

    this._pendingCall = null;
    this.matrix.on("callStarted", (info) => {
      log.debug("callStarted buffered:", info.callId);
      this._pendingCall = info;
      this._onCallStarted(info);
    });
    this.matrix.on("callEnded", () => {
      this._pendingCall = null;
      this._onCallEnded();
    });

    await this.matrix.joinRoom();
    await this.matrix.cleanupStaleCallMemberships();
    await this.matrix.startSync();

    this.presence = new PresenceTracker({
      discord: this.discord,
      matrix:  this.matrix,
    });
    this.presence.start();

    log.info("✓ Persistent services running (gateway + sync + presence)");

    await this._runCallLoop();
  }

  // ─── Main loop ───────────────────────────────────────────────────────────

  async _runCallLoop() {
    while (!this._stopping) {
      try {
        this._setState(STATE.WAITING_FOR_CALL);

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
        await this._teardownCall();
        await sleep(config.reconnect.delayMs);
      }
    }

    log.info("Call loop exited.");
  }

  // ─── Per-call bridging ────────────────────────────────────────────────

  async _bridge(callInfo) {
    const { callId, livekitUrl } = callInfo;
    log.info(`Bridging call: ${callId} @ ${livekitUrl}`);

    this._setState(STATE.CONNECTING_LIVEKIT);

    // Verify there's at least one real participant before connecting.
    // Don't join if the bot would be the only one in the call.
    const participantCount = await this.matrix.countActiveParticipants();
    if (participantCount === 0) {
      log.info("No active participants in call — skipping (will wait for next event)");
      return;
    }
    log.info(`${participantCount} active participant(s) in call — joining`);

    // Clean up stale memberships from previous call cycles
    await this.matrix.cleanupStaleCallMemberships();

    const deviceId = `bridge_${Date.now()}`;

    // Get LiveKit token via OpenID → lk-jwt-service.
    // The auth service knows the correct opaque LiveKit room name —
    // no need to query the LiveKit API or guess room names.
    const { token: tkn, url: lkUrl } = await this.matrix.getLiveKitToken(livekitUrl, callId, deviceId);

    // Create a fresh LiveKit client each call
    this.livekit = new LiveKitClient();

    // Connect with retry — the lk-jwt-service may have created the room
    // but it takes a moment to be ready on the SFU
    await retryWithBackoff(
      () => this.livekit.connect(lkUrl, tkn),
      {
        name:   "LiveKit connect",
        baseMs: 3000,
        maxMs:  10000,
        max:    5,
        signal: () => this._stopping,
      }
    );

    this.callId   = callId;
    this.deviceId = deviceId;

    // Publish MatrixRTC membership
    await this.matrix.publishCallMembership(callId, lkUrl, deviceId);
    this._membershipPublished = true;

    // Connect Discord voice (gateway already running)
    this._setState(STATE.CONNECTING_DISCORD);
    log.info("Connecting Discord to voice channel...");
    await this.discord.startVoice();
    log.info("✓ Discord voice channel connected");

    // Start audio relay
    this.relay = new AudioRelay(this.discord, this.livekit);
    this.relay.start();

    // Enable TTS on the already-running presence tracker
    this.presence.enableTTS(this.relay);

    this._setState(STATE.BRIDGING);
    this.startedAt = new Date();

    await this.matrix.sendMessage(
      `✅ Voice bridge active: Discord ↔ Element Call (${callId})`
    ).catch(() => {});

    log.info("✓ Bridge is ACTIVE — audio flowing in both directions");

    // Wait until the call ends
    await new Promise((resolve) => {
      this._resolveCurrentCall = resolve;
    });

    await this._teardownCall();
  }

  /**
   * Tear down per-call resources. Gateway, sync, and presence tracker stay alive.
   */
  async _teardownCall() {
    if (this.presence) this.presence.disableTTS();
    if (this.relay) { this.relay.stop(); this.relay = null; }

    if (this.deviceId && this._membershipPublished) {
      await this.matrix.removeCallMembership(this.deviceId).catch(() => {});
      this._membershipPublished = false;
    }

    await this.livekit.disconnect().catch(() => {});
    await this.discord.stopVoice().catch(() => {});

    this.callId    = null;
    this.deviceId  = null;
    this.startedAt = null;
    log.info("Per-call teardown complete (gateway + presence still active)");
  }

  // ─── Event handlers ──────────────────────────────────────────────────────

  _onCallStarted(info) {
    if (this.state === STATE.BRIDGING && this.callId === info.callId) return;
    log.debug("callStarted event received:", info.callId);
  }

  _onCallEnded() {
    const activeStates = [STATE.BRIDGING, STATE.CONNECTING_LIVEKIT, STATE.CONNECTING_DISCORD];
    if (!activeStates.includes(this.state)) {
      log.debug(`Ignoring callEnded in state: ${this.state}`);
      return;
    }

    log.info("Element Call ended — tearing down bridge");
    this._setState(STATE.RECOVERING);

    this.matrix.sendMessage("🔇 Element Call ended. Waiting for next call...").catch(() => {});

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
      gatewayReady:   this.discord.gatewayReady,
      livekitReady:   this.livekit.isReady,
      relayActive:    this.relay?.isRunning ?? false,
      callId:         this.callId,
      startedAt:      this.startedAt,
      matrixRoom:     config.matrix.roomId,
      discordChannel: config.discord.channelId,
      roster:         this.presence ? this.presence.getRoster() : { discord: [], matrix: [] },
    };
  }

  async stop() {
    this._stopping = true;
    log.info("Stopping persistent bridge...");

    if (this._resolveCurrentCall) {
      this._resolveCurrentCall();
      this._resolveCurrentCall = null;
    }

    await this._teardownCall().catch(() => {});
    if (this.presence) { this.presence.stop(); this.presence = null; }
    this.matrix.stopSync();
    await this.discord.stopAll().catch(() => {});

    this._setState(STATE.STOPPED);
    log.info("Bridge fully stopped.");
  }
}

module.exports = { PersistentBridge, STATE };