"use strict";

/**
 * PresenceTracker
 * ---------------
 * PERSISTENT presence monitoring — runs from boot, not just during calls.
 *
 * Text announcements (always active):
 *   - Discord voiceStateUpdate → Matrix chat message
 *   - Matrix callMemberJoined/Left (from sync) → Discord embed
 *
 * TTS announcements (only when voice bridge is active):
 *   - Discord user join/leave → TTS into LiveKit (Matrix hears it)
 *   - Matrix user join/leave → TTS into Discord (Discord hears it)
 *
 * The bridge calls enableTTS() / disableTTS() when connecting/disconnecting
 * voice, passing the relay instance needed for audio injection.
 */

const { EventEmitter } = require("events");
const { createLogger } = require("../utils/logger");
const { textToSpeech } = require("../utils/tts");
const config           = require("../../config");

const log = createLogger("Presence");

const FRAME_BYTES = 3840; // 20ms at 48kHz stereo 16-bit
const FRAME_MS    = 20;

class PresenceTracker extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.discord - PersistentDiscordClient (gateway must be started)
   * @param {object} opts.matrix  - MatrixClient (sync must be running)
   */
  constructor({ discord, matrix }) {
    super();
    this.discord = discord;
    this.matrix  = matrix;

    // Current rosters
    this.discordUsers = new Map(); // userId → { username, joinedAt }
    this.matrixUsers  = new Map(); // stateKey → { displayName, joinedAt }

    // TTS state — only set when voice bridge is active
    this._ttsEnabled    = false;
    this._relay         = null;
    this._ttsQueue      = [];
    this._ttsProcessing = false;

    this._handlers = [];
    this._running  = false;
  }

  /**
   * Start persistent monitoring. Call once at boot after gateway + sync are up.
   */
  start() {
    if (this._running) return;
    this._running = true;

    // ─── Discord voice state changes (persistent via gateway) ────────────
    const vsHandler = async (oldState, newState) => {
      const targetChannel = config.discord.channelId;

      const joined = (!oldState.channelId || oldState.channelId !== targetChannel) &&
                     newState.channelId === targetChannel;

      const left = oldState.channelId === targetChannel &&
                   newState.channelId !== targetChannel;

      if (!joined && !left) return;

      const member = newState.member || oldState.member;
      if (!member) return;

      // Ignore our bot
      if (member.user?.bot && member.id === this.discord.client?.user?.id) return;

      const username = member.displayName || member.user?.username || member.id;

      if (joined) {
        this.discordUsers.set(member.id, { username, joinedAt: new Date() });
        log.info(`Discord: ${username} joined voice`);
        await this._announceToMatrix("join", username, "Discord");
      }
      if (left) {
        this.discordUsers.delete(member.id);
        log.info(`Discord: ${username} left voice`);
        await this._announceToMatrix("leave", username, "Discord");
      }
    };

    if (this.discord.client) {
      this.discord.client.on("voiceStateUpdate", vsHandler);
      this._handlers.push({ target: this.discord.client, event: "voiceStateUpdate", fn: vsHandler });
    }

    // ─── Matrix call member changes (persistent via sync) ────────────────
    const matrixJoinHandler = async ({ stateKey, displayName }) => {
      this.matrixUsers.set(stateKey, { displayName, joinedAt: new Date() });
      log.info(`Matrix: ${displayName} joined Element Call`);
      await this._announceToDiscord("join", displayName, "Element Call");
    };

    const matrixLeaveHandler = async ({ stateKey, displayName }) => {
      this.matrixUsers.delete(stateKey);
      log.info(`Matrix: ${displayName} left Element Call`);
      await this._announceToDiscord("leave", displayName, "Element Call");
    };

    this.matrix.on("callMemberJoined", matrixJoinHandler);
    this.matrix.on("callMemberLeft", matrixLeaveHandler);
    this._handlers.push({ target: this.matrix, event: "callMemberJoined", fn: matrixJoinHandler });
    this._handlers.push({ target: this.matrix, event: "callMemberLeft", fn: matrixLeaveHandler });

    // ─── Snapshot existing members ───────────────────────────────────────
    this._snapshotDiscordMembers().catch((err) =>
      log.debug("Could not snapshot Discord members:", err.message)
    );
    this._snapshotMatrixMembers();

    // Wire up roster for /status command
    this.discord.setRosterCallback(() => this.getRoster());

    log.info("Presence tracker started (persistent mode)");
  }

  enableTTS(relay) {
    this._ttsEnabled = true;
    this._relay      = relay;
    log.info("TTS announcements enabled (voice bridge active)");
  }

  disableTTS() {
    this._ttsEnabled = false;
    this._relay      = null;
    this._ttsQueue   = [];
    log.info("TTS announcements disabled (voice bridge inactive)");
  }

  stop() {
    if (!this._running) return;
    this._running = false;

    for (const { target, event, fn } of this._handlers) {
      try { target.removeListener(event, fn); } catch {}
    }
    this._handlers = [];
    this.discordUsers.clear();
    this.matrixUsers.clear();
    this._ttsEnabled = false;
    this._relay = null;

    log.info("Presence tracker stopped");
  }

  getRoster() {
    return {
      discord: [...this.discordUsers.values()].map(u => u.username),
      matrix:  [...this.matrixUsers.values()].map(u => u.displayName),
    };
  }

  // ─── Text Announcements (always active) ────────────────────────────────

  async _announceToMatrix(action, username, source) {
    const emoji = action === "join" ? "🟢" : "🔴";
    const verb  = action === "join" ? "joined" : "left";
    const text  = `${emoji} **${username}** ${verb} ${source}`;

    try {
      await this.matrix.sendMessage(text);
    } catch (err) {
      log.warn("Could not send Matrix announcement:", err.message);
    }

    if (this._ttsEnabled) {
      this._queueTTS(`${username} ${verb} ${source}`, "livekit");
    }
  }

  async _announceToDiscord(action, displayName, source) {
    const emoji  = action === "join" ? "🟢" : "🔴";
    const verb   = action === "join" ? "joined" : "left";
    const colour = action === "join" ? 0x57F287 : 0xED4245;

    await this.discord.sendEmbed({
      color: colour,
      description: `${emoji} **${displayName}** ${verb} ${source}`,
      timestamp: new Date().toISOString(),
    });

    if (this._ttsEnabled) {
      this._queueTTS(`${displayName} ${verb} ${source}`, "discord");
    }
  }

  // ─── TTS (only when voice-connected) ──────────────────────────────────

  _queueTTS(text, target) {
    if (!this._ttsEnabled) return;
    this._ttsQueue.push({ text, target });
    if (!this._ttsProcessing) this._processTTSQueue();
  }

  async _processTTSQueue() {
    this._ttsProcessing = true;

    while (this._ttsQueue.length > 0 && this._ttsEnabled) {
      const { text, target } = this._ttsQueue.shift();
      try {
        const pcm = await textToSpeech(text);
        if (!pcm || pcm.length === 0) continue;

        // Split PCM into 20ms frames
        const frames = [];
        for (let offset = 0; offset + FRAME_BYTES <= pcm.length; offset += FRAME_BYTES) {
          frames.push(pcm.slice(offset, offset + FRAME_BYTES));
        }

        if (target === "discord") {
          // Discord pipeline has a large buffer — safe to push all at once
          for (const frame of frames) {
            this.discord.sendAudio(frame);
          }
          log.debug(`Injected ${frames.length} TTS frames into Discord`);
        } else if (target === "livekit") {
          // LiveKit mixer has a small queue (5 frames) — drip-feed at real-time
          // rate to prevent overflow/drops
          await this._dripFeedToLiveKit(frames);
        }

        // Wait for TTS to finish playing before next message
        const durationMs = frames.length * FRAME_MS;
        // For LiveKit we already waited during drip-feed, just add padding
        const waitMs = target === "livekit" ? 200 : durationMs + 200;
        await new Promise(r => setTimeout(r, waitMs));

      } catch (err) {
        log.warn(`TTS playback failed (${target}):`, err.message);
      }
    }

    this._ttsProcessing = false;
  }

  /**
   * Feed TTS frames into the LiveKit D→M mixer one frame at a time,
   * at real-time rate (20ms intervals). This prevents the mixer's
   * queue depth limit (5 frames) from dropping most of the audio.
   */
  async _dripFeedToLiveKit(frames) {
    if (!this._relay?._d2mMixer) {
      log.debug("Cannot inject TTS to LiveKit — relay mixer not available");
      return;
    }

    const mixer = this._relay._d2mMixer;
    let fed = 0;

    for (const frame of frames) {
      if (!this._ttsEnabled) break; // bail if voice disconnected mid-TTS
      mixer.push("__tts__", frame);
      fed++;
      // Wait ~20ms between frames to match the LiveKit output loop's pull rate
      await new Promise(r => setTimeout(r, FRAME_MS));
    }

    log.debug(`Drip-fed ${fed} TTS frames into LiveKit`);
  }

  // ─── Snapshots ─────────────────────────────────────────────────────────

  async _snapshotDiscordMembers() {
    try {
      const guild = await this.discord.client?.guilds?.fetch(config.discord.guildId);
      if (!guild) return;
      const channel = await guild.channels.fetch(config.discord.channelId);
      if (!channel?.members) return;

      for (const [id, member] of channel.members) {
        if (member.user?.bot && id === this.discord.client?.user?.id) continue;
        const username = member.displayName || member.user?.username || id;
        this.discordUsers.set(id, { username, joinedAt: new Date() });
      }

      if (this.discordUsers.size > 0) {
        log.info(`Snapshot: ${this.discordUsers.size} user(s) in Discord voice`);
      }
    } catch (err) {
      log.debug("Discord member snapshot failed:", err.message);
    }
  }

  _snapshotMatrixMembers() {
    const members = this.matrix.getActiveMembers();
    for (const [stateKey, displayName] of members) {
      this.matrixUsers.set(stateKey, { displayName, joinedAt: new Date() });
    }
    if (this.matrixUsers.size > 0) {
      log.info(`Snapshot: ${this.matrixUsers.size} user(s) in Element Call`);
    }
  }
}

module.exports = { PresenceTracker };