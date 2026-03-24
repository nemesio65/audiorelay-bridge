"use strict";

/**
 * MatrixClient
 * ------------
 * Lightweight Matrix HTTP client. No SDK dependency.
 *
 * Token strategy:
 *   1. (Preferred) OpenID token → lk-jwt-service at the livekit_service_url
 *      The auth service derives the correct opaque LiveKit room name from the
 *      Matrix room ID, eliminating any room-matching guesswork.
 *   2. (Fallback) Self-sign JWT with LIVEKIT_API_KEY/SECRET — only works if
 *      the LiveKit room name matches the Matrix room ID (pre-ESS v2.3.0).
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

    this._activeMembers = new Map();
    this._callActive = false;
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

  /**
   * Generic HTTP request to an EXTERNAL URL (not the homeserver).
   * Used for lk-jwt-service requests.
   */
  _externalRequest(method, urlStr, body = null) {
    return new Promise((resolve, reject) => {
      const url     = new URL(urlStr);
      const isHttps = url.protocol === "https:";
      const lib     = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + url.search,
        method,
        headers: { "Content-Type": "application/json" },
      };

      const req = lib.request(options, (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          try {
            const json = JSON.parse(raw);
            if (res.statusCode >= 400) {
              return reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
            }
            resolve(json);
          } catch {
            reject(new Error(`Non-JSON response from ${urlStr}: ${raw.slice(0, 200)}`));
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

  // ─── OpenID token ────────────────────────────────────────────────────────

  /**
   * Get an OpenID token from the homeserver for the bot user.
   * Used to authenticate with the lk-jwt-service.
   */
  async _getOpenIDToken() {
    const path = `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/openid/request_token`;
    const resp = await this._post(path, {});
    log.debug(`Got OpenID token (expires in ${resp.expires_in}s)`);
    return resp; // { access_token, token_type, matrix_server_name, expires_in }
  }

  // ─── LiveKit token ───────────────────────────────────────────────────────

  /**
   * Get a LiveKit JWT for the bridge bot to join a call.
   *
   * Strategy:
   *   1. (Preferred) Use OpenID token → lk-jwt-service at livekitUrl/sfu/get
   *      This lets the auth service derive the correct opaque LiveKit room name.
   *      No LIVEKIT_API_KEY/SECRET needed.
   *
   *   2. (Fallback) Self-sign with LIVEKIT_API_KEY/SECRET if set and
   *      lk-jwt-service fails. Only works if room names match Matrix room IDs.
   *
   * @returns {{ token: string, url: string }}
   */
  async getLiveKitToken(livekitUrl, callId, deviceId) {
    if (!deviceId) throw new Error("deviceId is required for getLiveKitToken");

    // Normalise URL to https for the auth service endpoint
    const httpUrl = livekitUrl
      .replace(/^wss:\/\//, "https://")
      .replace(/^ws:\/\//, "http://");

    // ── Strategy 1: OpenID → lk-jwt-service ─────────────────────────────
    try {
      const openIdToken = await this._getOpenIDToken();

      // The legacy /sfu/get endpoint format
      const reqBody = {
        room:         callId,
        openid_token: openIdToken,
        device_id:    deviceId,
      };

      log.info(`Requesting LiveKit token from ${httpUrl}/sfu/get for room ${callId}`);
      const resp = await this._externalRequest("POST", `${httpUrl}/sfu/get`, reqBody);

      if (resp.jwt && resp.url) {
        log.info(`✓ Got LiveKit token from auth service — url: ${resp.url}`);
        return { token: resp.jwt, url: resp.url };
      }

      log.warn("lk-jwt-service response missing jwt/url fields:", JSON.stringify(resp));
    } catch (err) {
      log.warn(`lk-jwt-service failed: ${err.message}`);
    }

    // ── Strategy 2: Self-sign fallback ──────────────────────────────────
    if (config.livekit.apiKey && config.livekit.apiSecret) {
      log.info("Falling back to self-signed LiveKit token");
      const { AccessToken } = require("livekit-server-sdk");

      const wsUrl = livekitUrl
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://");

      const identity = `${this.userId}:${deviceId}`;
      const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
        identity,
        name: "Voice Bridge",
        ttl:  7200,
      });

      at.addGrant({
        roomJoin: true,
        room: callId,
        canPublish: true,
        canSubscribe: true,
      });

      const token = await at.toJwt();
      log.info(`Self-signed LiveKit token — room: "${callId}", identity: "${identity}"`);
      return { token, url: wsUrl };
    }

    throw new Error("Could not obtain LiveKit token: lk-jwt-service failed and no LIVEKIT_API_KEY/SECRET configured");
  }

  // ─── Call detection ──────────────────────────────────────────────────────

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

  async waitForCall(timeoutMs = 0) {
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

  _parseCallEvent(event) {
    const c = event.content;
    if (!c || !Object.keys(c).length) return null;

    if (c.application === "m.call") {
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
      if (c.focus_active?.type === "livekit" && c.focus_active?.livekit_service_url) {
        const callId     = c.call_id || this.roomId;
        const livekitUrl = c.focus_active.livekit_service_url;
        log.debug(`_parseCallEvent (focus_active): callId="${callId}" livekitUrl="${livekitUrl}"`);
        return { callId, livekitUrl };
      }
      log.debug(`_parseCallEvent: m.call event but no livekit focus found`);
    }

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
    this._initialSync = true;
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
      const allEvents = [
        ...(data.timeline?.events ?? []),
        ...(data.state?.events   ?? []),
      ];
      const callEventsInRoom = allEvents.filter(e => e.type === "org.matrix.msc3401.call.member");
      if (callEventsInRoom.length > 0 && roomId !== this.roomId) {
        log.debug(`Sync: ignoring ${callEventsInRoom.length} call event(s) from room ${roomId} (watching ${this.roomId})`);
      }

      if (roomId !== this.roomId) continue;

      const events = allEvents;

      if (this._initialSync) {
        this._initialSync = false;
        const latestByKey = new Map();
        for (const event of events) {
          if (event.type === "org.matrix.msc3401.call.member") {
            latestByKey.set(event.state_key ?? "", event);
          }
        }
        for (const [stateKey, event] of latestByKey) {
          if (stateKey.includes(this.userId)) continue;
          const info = this._parseCallEvent(event);
          if (info) {
            const displayName = this._extractDisplayName(stateKey);
            this._activeMembers.set(stateKey, displayName);
          }
        }
        if (this._activeMembers.size > 0) {
          log.info(`Initial sync: ${this._activeMembers.size} active call member(s)`);
        }
        for (const event of latestByKey.values()) {
          const info = this._parseCallEvent(event);
          if (info) {
            log.info(`Initial sync: active call found → ${info.callId}`);
            this._callActive = true;
            this.emit("callStarted", info);
            return;
          }
        }
        log.info("Initial sync: no active call in room");
        return;
      }

      for (const event of events) {
        this._checkCallEvent(event);
      }
    }
  }

  _checkCallEvent(event) {
    if (event.type !== "org.matrix.msc3401.call.member") return;

    const c = event.content;
    const stateKey = event.state_key ?? "";
    const isOurEvent = stateKey.includes(this.userId);

    if (isOurEvent) {
      log.debug(`Ignoring own call membership event (state_key: ${stateKey})`);
      return;
    }

    const isEmpty = !c || !Object.keys(c).length ||
                    (Array.isArray(c.memberships) && c.memberships.length === 0);

    const displayName = this._extractDisplayName(stateKey);

    if (isEmpty) {
      if (this._activeMembers.has(stateKey)) {
        this._activeMembers.delete(stateKey);
        log.info(`Call member left: ${displayName}`);
        this.emit("callMemberLeft", { stateKey, displayName });
      }
      log.debug(`Participant left (state_key: ${stateKey}) — checking if call is truly over`);
      this._checkIfCallOver();
      return;
    }

    const callInfo = this._parseCallEvent(event);
    if (!callInfo) return;

    if (!this._activeMembers.has(stateKey)) {
      this._activeMembers.set(stateKey, displayName);
      log.info(`Call member joined: ${displayName}`);
      this.emit("callMemberJoined", { stateKey, displayName, callInfo });
    }

    if (!this._callActive) {
      this._callActive = true;
      log.info(`Element Call detected: callId="${callInfo.callId}" url="${callInfo.livekitUrl}"`);
      this.emit("callStarted", callInfo);
    } else {
      log.debug(`Call already active — ignoring duplicate callStarted for ${callInfo.callId}`);
    }
  }

  _extractDisplayName(stateKey) {
    const match = stateKey.match(/@([^:]+):/);
    return match ? match[1] : stateKey;
  }

  getActiveMembers() {
    return new Map(this._activeMembers);
  }

  /**
   * Check if there are real (non-bot) participants in the call.
   * Queries current room state to get an accurate count.
   * @returns {Promise<number>} Number of active non-bot call members
   */
  async countActiveParticipants() {
    try {
      const state = await this._get(
        `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/state`
      );
      const active = state.filter(e => {
        if (e.type !== "org.matrix.msc3401.call.member") return false;
        if (e.state_key?.includes(this.userId)) return false; // skip our own bot
        if (!e.content || !Object.keys(e.content).length) return false;
        return this._parseCallEvent(e) !== null;
      });
      return active.length;
    } catch (err) {
      log.warn("Could not count active participants:", err.message);
      // Fall back to in-memory tracking
      return this._activeMembers.size;
    }
  }

  async _checkIfCallOver() {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const state = await this._get(
        `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/state`
      );
      const activeOthers = state.filter(e => {
        if (e.type !== "org.matrix.msc3401.call.member") return false;
        if (e.state_key?.includes(this.userId)) return false;
        if (!e.content || !Object.keys(e.content).length) return false;
        return this._parseCallEvent(e) !== null;
      });

      if (activeOthers.length === 0) {
        log.info("Element Call ended — no active participants remaining");
        this._activeMembers.clear();
        this._callActive = false;
        this.emit("callEnded");
      } else {
        log.debug(`Call still active — ${activeOthers.length} other participant(s) present`);
      }
    } catch (err) {
      log.warn("Could not check call state:", err.message);
    }
  }

  async cleanupStaleCallMemberships() {
    try {
      const state = await this._get(
        `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/state`
      );
      const stale = state.filter(e =>
        e.type === "org.matrix.msc3401.call.member" &&
        e.state_key.startsWith(`_${this.userId}_`) &&
        Object.keys(e.content || {}).length > 0
      );
      if (stale.length === 0) { log.debug("No stale call memberships to clean up"); return; }
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

  async removeCallMembership(deviceId) {
    const stateKey = `_${this.userId}_${deviceId}_m.call`;
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(stateKey)}`;
    try {
      await this._put(path, {});
      log.info("Removed call membership state");
    } catch (err) {
      log.warn("Could not remove call membership:", err.message);
    }
  }
}

module.exports = MatrixClient;