"use strict";

/**
 * MatrixClient
 * ------------
 * Lightweight Matrix HTTP client. No SDK dependency.
 *
 * Key responsibilities for the persistent bridge:
 *  - Join the configured room on startup
 *  - Run the /sync loop
 *  - Detect active Element Call sessions (MSC4143 / MatrixRTC)
 *  - Fetch LiveKit tokens from the homeserver (for hosted Element Call)
 *  - Emit "callStarted" and "callEnded" events
 *  - Wait indefinitely for a call to appear if none is active
 */

const https        = require("https");
const http         = require("http");
const { EventEmitter } = require("events");
const { createLogger } = require("../utils/logger");
const config       = require("../../config");

const log = createLogger("Matrix");

class MatrixClient extends EventEmitter {
  constructor() {
    super();
    this.baseUrl     = config.matrix.homeserverUrl.replace(/\/$/, "");
    this.token       = config.matrix.accessToken;
    this.userId      = config.matrix.botUserId;
    this.roomId      = config.matrix.roomId;
    this.syncToken   = null;
    this._stopping   = false;
    this._syncActive = false;
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url    = new URL(`${this.baseUrl}${path}`);
      const isHttps = url.protocol === "https:";
      const lib    = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
      };

      const req = lib.request(options, (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          try {
            const json = JSON.parse(raw);
            if (res.statusCode >= 400) {
              const err = new Error(`Matrix ${res.statusCode}: ${json.error || raw}`);
              err.statusCode = res.statusCode;
              return reject(err);
            }
            resolve(json);
          } catch {
            reject(new Error(`Non-JSON Matrix response: ${raw.slice(0, 200)}`));
          }
        });
      });

      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  _get(path)        { return this._request("GET",  path); }
  _post(path, body) { return this._request("POST", path, body); }
  _put(path, body)  { return this._request("PUT",  path, body); }

  // ─── Room management ─────────────────────────────────────────────────────

  async joinRoom() {
    log.info(`Joining Matrix room: ${this.roomId}`);
    try {
      await this._post(`/_matrix/client/v3/join/${encodeURIComponent(this.roomId)}`);
      log.info("✓ Joined Matrix room");
    } catch (err) {
      // 403 = already joined or no permission; 200 = joined; ignore "already in room"
      if (err.statusCode === 403) {
        log.warn("Could not join room (forbidden) — bot may already be a member or lacks invite");
      } else {
        throw err;
      }
    }
  }

  async sendMessage(text) {
    const txnId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const path  = `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/send/m.room.message/${txnId}`;
    return this._put(path, { msgtype: "m.text", body: text });
  }

  // ─── LiveKit token ───────────────────────────────────────────────────────

  /**
   * Get a LiveKit JWT for the bridge bot to join a call.
   *
   * Strategy:
   *   1. If LIVEKIT_API_KEY + LIVEKIT_API_SECRET are set → self-sign a token
   *   2. Otherwise → ask the Matrix homeserver for one via the openid/call endpoint
   */
  async getLiveKitToken(livekitUrl, callId, deviceId) {
    // Normalise URL: convert https:// → wss://, http:// → ws://
    livekitUrl = livekitUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");

    if (!config.livekit.apiKey || !config.livekit.apiSecret) {
      throw new Error("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in .env");
    }

    const { AccessToken } = require("livekit-server-sdk");

    // Use the provided deviceId so token identity matches membership state event
    // Identity format: @user:server:deviceId — confirmed from auth service logs
    if (!deviceId) throw new Error("deviceId is required for getLiveKitToken");
    const identity = `${this.userId}:${deviceId}`;

    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity,
      name: "Voice Bridge",
      ttl:  7200, // 2 hours in seconds — prevents TimeoutNegativeWarning
    });

    at.addGrant({
      roomJoin:     true,
      room:         callId,   // use the alias directly — e.g. !KfcOTI...:bhsnw.com
      canPublish:   true,
      canSubscribe: true,
    });

    const token = await at.toJwt();
    log.info(`Generated LiveKit token — room: "${callId}", identity: "${identity}"`);
    return { token, url: livekitUrl };
  }

  // ─── Call detection ──────────────────────────────────────────────────────

  /**
   * Scan current room state for an active Element Call session.
   * Returns { callId, livekitUrl } or null.
   */
  async getActiveCall() {
    try {
      const state = await this._get(
        `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/state`
      );
      const callEvents = state.filter(e => e.type === "org.matrix.msc3401.call.member");
      log.debug(`getActiveCall: found ${callEvents.length} call member events`);
      for (const e of callEvents) {
        log.debug(`  state_key="${e.state_key}" content keys: ${Object.keys(e.content || {}).join(", ")}`);
        const foci = e.content?.foci_preferred ?? e.content?.foci_active ?? [];
        log.debug(`  foci: ${JSON.stringify(foci)}`);
      }
      return this._extractCall(state);
    } catch (err) {
      log.warn("Could not read room state:", err.message);
      return null;
    }
  }

  /**
   * Wait for an Element Call to appear in the room.
   * If timeoutMs is 0, waits forever.
   * Resolves with { callId, livekitUrl }.
   */
  async waitForCall(timeoutMs = 0) {
    // First check if one is already active
    const existing = await this.getActiveCall();
    if (existing) {
      log.info(`Found existing call: ${existing.callId}`);
      return existing;
    }

    log.info(
      timeoutMs
        ? `Waiting up to ${timeoutMs / 1000}s for an Element Call to start...`
        : "Waiting for an Element Call to start (no timeout)..."
    );

    return new Promise((resolve, reject) => {
      let timer = null;

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.removeListener("callStarted", handler);
          reject(new Error("Timed out waiting for Element Call"));
        }, timeoutMs);
      }

      const handler = (callInfo) => {
        if (timer) clearTimeout(timer);
        resolve(callInfo);
      };

      this.once("callStarted", handler);
    });
  }

  _extractCall(stateEvents) {
    for (const event of stateEvents) {
      if (event.type !== "org.matrix.msc3401.call.member") continue;
      const info = this._parseCallEvent(event);
      if (info) return info;
    }
    return null;
  }

  /**
   * Parse a call member event in either known format:
   *
   * Format A — old "memberships array" style:
   *   content.memberships = [{ application, call_id, foci_active: [{type:"livekit", livekit_service_url}] }]
   *
   * Format B — new flat MSC4143 style (used by bhsnw.com / Element Call):
   *   content = { application:"m.call", call_id:"", foci_preferred: [{type:"livekit", livekit_service_url, livekit_alias}] }
   *
   * Returns { callId, livekitUrl } or null.
   */
  _parseCallEvent(event) {
    const c = event.content;
    if (!c || !Object.keys(c).length) return null;

    // ── Format B: flat MSC4143 (ESS / modern Element Call) ────────────────
    if (c.application === "m.call") {
      // Try foci_preferred first (array of focus objects), then foci_active
      // ESS uses foci_preferred for the list and focus_active (singular) for selection
      const fociList = Array.isArray(c.foci_preferred) ? c.foci_preferred
                     : Array.isArray(c.foci_active)    ? c.foci_active
                     : [];

      const lk = fociList.find((f) => f.type === "livekit" && f.livekit_service_url);

      if (lk) {
        const callId     = c.call_id || lk.livekit_alias || this.roomId;
        const livekitUrl = lk.livekit_service_url;
        log.debug(`_parseCallEvent: callId="${callId}" livekitUrl="${livekitUrl}"`);
        return { callId, livekitUrl };
      }

      // ESS edge case: focus_active is an object (not array) with livekit_service_url
      if (c.focus_active?.type === "livekit" && c.focus_active?.livekit_service_url) {
        const callId     = c.call_id || this.roomId;
        const livekitUrl = c.focus_active.livekit_service_url;
        log.debug(`_parseCallEvent (focus_active): callId="${callId}" livekitUrl="${livekitUrl}"`);
        return { callId, livekitUrl };
      }

      log.debug(`_parseCallEvent: m.call event but no livekit focus found. foci_preferred=${JSON.stringify(c.foci_preferred)}`);
    }

    // ── Format A: memberships array (older homeservers) ────────────────────
    const memberships = c.memberships ?? [];
    const active = memberships.find((m) => m.application === "m.call");
    if (!active) return null;

    const foci = active.foci_active ?? active.foci_preferred ?? [];
    const lk   = foci.find((f) => f.type === "livekit" && f.livekit_service_url);
    if (!lk) return null;

    return {
      callId:     active.call_id || lk.livekit_alias || this.roomId,
      livekitUrl: lk.livekit_service_url,
    };
  }

  // ─── Sync loop ───────────────────────────────────────────────────────────

  async startSync() {
    if (this._syncActive) return;
    this._syncActive  = true;
    this._stopping    = false;
    this._initialSync = true; // first response is a full state snapshot
    log.info("Matrix sync loop started");
    this._syncLoop().catch((err) => log.error("Sync loop fatal:", err.message));
  }

  stopSync() {
    this._stopping   = true;
    this._syncActive = false;
  }

  async _syncLoop() {
    while (!this._stopping) {
      try {
        const qs = new URLSearchParams({ timeout: "15000" });
        if (this.syncToken) {
          qs.set("since", this.syncToken);
          qs.set("full_state", "false");
        } else {
          qs.set("full_state", "true");
        }

        const resp = await this._get(`/_matrix/client/v3/sync?${qs}`);
        this.syncToken = resp.next_batch;
        this._processSyncResponse(resp);
      } catch (err) {
        if (this._stopping) break;
        log.warn("Sync error (will retry):", err.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    log.info("Matrix sync loop stopped");
  }

  _processSyncResponse(resp) {
    const joined = resp.rooms?.join ?? {};

    for (const [roomId, data] of Object.entries(joined)) {
      if (roomId !== this.roomId) continue;

      const events = [
        ...(data.timeline?.events ?? []),
        ...(data.state?.events   ?? []),
      ];

      if (this._initialSync) {
        // On the first sync we get a full state snapshot — it contains ALL
        // historical call member events including stale ones. Instead of
        // replaying every start/end/start/end, find the current net state
        // by looking at the LATEST call member event per state_key.
        this._initialSync = false;
        const latestByKey = new Map();
        for (const event of events) {
          if (event.type === "org.matrix.msc3401.call.member") {
            latestByKey.set(event.state_key ?? "", event);
          }
        }
        // Emit a single callStarted if ANY latest event is an active call
        for (const event of latestByKey.values()) {
          const info = this._parseCallEvent(event);
          if (info) {
            log.info(`Initial sync: active call found → ${info.callId}`);
            this.emit("callStarted", info);
            return; // found one, done
          }
        }
        log.info("Initial sync: no active call in room");
        return;
      }

      // Normal incremental sync — process events in order
      for (const event of events) {
        this._checkCallEvent(event);
      }
    }
  }

  _checkCallEvent(event) {
    if (event.type !== "org.matrix.msc3401.call.member") return;

    const c = event.content;
    const isOurEvent = event.state_key?.includes(this.userId);

    // If this is our own bot's state key changing, ignore it entirely —
    // we manage our own state; don't let it trigger callEnded/callStarted loops
    if (isOurEvent) {
      log.debug(`Ignoring own call membership event (state_key: ${event.state_key})`);
      return;
    }

    // Empty content = this participant left
    const isEmpty = !c || !Object.keys(c).length ||
                    (Array.isArray(c.memberships) && c.memberships.length === 0);

    if (isEmpty) {
      // Only emit callEnded if there are no other active (non-bot) participants
      // We check by querying current room state via getActiveCall()
      log.debug(`Participant left (state_key: ${event.state_key}) — checking if call is truly over`);
      this._checkIfCallOver();
      return;
    }

    const callInfo = this._parseCallEvent(event);
    if (!callInfo) return;

    log.info(`Element Call detected: callId="${callInfo.callId}" url="${callInfo.livekitUrl}"`);
    this.emit("callStarted", callInfo);
  }

  async _checkIfCallOver() {
    // Wait a short moment for any in-flight state updates to settle
    await new Promise(r => setTimeout(r, 1000));
    try {
      const state = await this._get(
        `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/state`
      );
      // Look for any active call member that is NOT our own bot
      const activeOthers = state.filter(e => {
        if (e.type !== "org.matrix.msc3401.call.member") return false;
        if (e.state_key?.includes(this.userId)) return false; // skip our own
        if (!e.content || !Object.keys(e.content).length) return false; // skip empty
        return this._parseCallEvent(e) !== null; // must be a valid call event
      });

      if (activeOthers.length === 0) {
        log.info("Element Call ended — no active participants remaining");
        this.emit("callEnded");
      } else {
        log.debug(`Call still active — ${activeOthers.length} other participant(s) present`);
      }
    } catch (err) {
      log.warn("Could not check call state:", err.message);
    }
  }
  /**
   * Clean up all stale call membership state events left by previous bridge runs.
   * Finds all state keys matching our bot's pattern and empties them.
   */
  async cleanupStaleCallMemberships() {
    try {
      const state = await this._get(
        `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/state`
      );
      const stale = state.filter(e =>
        e.type === "org.matrix.msc3401.call.member" &&
        e.state_key.startsWith(`_${this.userId}_`) &&
        Object.keys(e.content || {}).length > 0 // has content = not yet cleaned
      );
      if (stale.length === 0) {
        log.debug("No stale call memberships to clean up");
        return;
      }
      log.info(`Cleaning up ${stale.length} stale call membership(s)...`);
      for (const e of stale) {
        const path = `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(e.state_key)}`;
        await this._put(path, {}).catch(() => {});
        log.debug(`Cleared stale state key: ${e.state_key}`);
      }
    } catch (err) {
      log.warn("Could not clean up stale memberships:", err.message);
    }
  }

  /**
   * Publish a MatrixRTC membership state event so the bridge bot
   * appears as a visible participant in Element Call.
   * Must be called after connecting to LiveKit.
   */
  async publishCallMembership(callId, livekitUrl, deviceId) {
    const stateKey = `_${this.userId}_${deviceId}_m.call`;
    const content = {
      application:  "m.call",
      call_id:      callId === this.roomId ? "" : callId,
      scope:        "m.room",
      device_id:    deviceId,
              expires_ts:   Date.now() + 7200000,
      focus_active: { type: "livekit", focus_selection: "oldest_membership" },
      foci_preferred: [{
        livekit_service_url: livekitUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://"),
        type:          "livekit",
        livekit_alias: this.roomId,
      }],
      "m.call.intent": "audio",
      created_ts:    Date.now(),
    };

    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(stateKey)}`;
    try {
      await this._put(path, content);
      log.info(`Published call membership state (device: ${deviceId})`);
    } catch (err) {
      log.warn("Could not publish call membership:", err.message);
    }
  }

  /**
   * Remove the bridge bot's membership state event when leaving a call.
   */
  async removeCallMembership(deviceId) {
    const stateKey = `_${this.userId}_${deviceId}_m.call`;
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(stateKey)}`;
    try {
      await this._put(path, {}); // empty content = leave
      log.info("Removed call membership state");
    } catch (err) {
      log.warn("Could not remove call membership:", err.message);
    }
  }

}

module.exports = MatrixClient;