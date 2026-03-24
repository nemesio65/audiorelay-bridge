"use strict";

/**
 * PersistentDiscordClient
 * -----------------------
 * Two-layer architecture:
 *   1. Gateway layer — persists forever. Handles voiceStateUpdate, slash
 *      commands, and text channel messaging even when not in a voice call.
 *   2. Voice layer — connects/disconnects per call cycle. Handles audio
 *      send/receive.
 *
 * startGateway() is called once at boot.
 * startVoice() / stopVoice() are called per-call.
 * stopAll() tears down everything on shutdown.
 */

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
} = require("@discordjs/voice");

const prism         = require("prism-media");
const { EventEmitter } = require("events");
const { createLogger } = require("../utils/logger");
const { retryWithBackoff } = require("../utils/retry");
const config        = require("../../config");

const log = createLogger("Discord");

class PersistentDiscordClient extends EventEmitter {
  constructor() {
    super();

    this.client        = null;
    this.connection    = null;
    this.player        = null;
    this.subscriptions = new Map();
    this.isReady       = false;  // voice ready
    this.gatewayReady  = false;  // gateway ready
    this._stopping     = false;
    this._reconnecting = false;

    this._rosterCallback = null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GATEWAY LAYER — persistent, started once at boot
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Start the Discord gateway (login, register commands, listen for events).
   * Does NOT join voice — that happens in startVoice().
   */
  async startGateway() {
    if (this.gatewayReady) return;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.client.on("error", (err) => {
      log.error("Discord client error:", err.message);
    });

    // /status command handler
    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "status") return;
      await this._handleStatusCommand(interaction);
    });

    log.info("Starting Discord gateway...");
    await this.client.login(config.discord.token);

    await new Promise((resolve) => {
      if (this.client.isReady()) return resolve();
      this.client.once("clientReady", resolve);
    });

    this.gatewayReady = true;
    log.info(`Discord gateway ready as: ${this.client.user.tag}`);

    // Register slash commands (idempotent)
    await this._registerCommands();
  }

  async _registerCommands() {
    try {
      const rest = new REST({ version: "10" }).setToken(config.discord.token);
      const commands = [
        new SlashCommandBuilder()
          .setName("status")
          .setDescription("Show who is in the voice bridge on each side")
          .toJSON(),
      ];
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
        { body: commands }
      );
      log.info("Registered /status slash command");
    } catch (err) {
      log.warn("Could not register slash command:", err.message);
    }
  }

  async _handleStatusCommand(interaction) {
    try {
      const roster = this._rosterCallback ? this._rosterCallback() : { discord: [], matrix: [] };
      const bridgeState = this.isReady ? "🟢 Voice bridge active" : "🟡 Monitoring (no active call)";

      const discordList = roster.discord.length > 0
        ? roster.discord.map(n => `• ${n}`).join("\n")
        : "_No one_";

      const matrixList = roster.matrix.length > 0
        ? roster.matrix.map(n => `• ${n}`).join("\n")
        : "_No one_";

      await interaction.reply({
        embeds: [{
          color: 0x5865F2,
          title: "🌉 Voice Bridge Status",
          description: bridgeState,
          fields: [
            { name: `🎮 Discord Voice (${roster.discord.length})`, value: discordList, inline: true },
            { name: `📱 Element Call (${roster.matrix.length})`, value: matrixList, inline: true },
          ],
          timestamp: new Date().toISOString(),
        }],
        ephemeral: false,
      });
    } catch (err) {
      log.warn("Failed to respond to /status:", err.message);
      try { await interaction.reply({ content: "Could not fetch bridge status.", ephemeral: true }); } catch {}
    }
  }

  setRosterCallback(fn) { this._rosterCallback = fn; }

  /**
   * Send an embed to the announcement channel. Works without voice.
   */
  async sendEmbed(embed) {
    try {
      const channelId = config.discord.textChannelId || config.discord.channelId;
      const channel   = await this.client?.channels?.fetch(channelId);
      if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
    } catch (err) {
      log.warn("Could not send Discord embed:", err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VOICE LAYER — per-call, started/stopped by the bridge
  // ═══════════════════════════════════════════════════════════════════════

  async startVoice() {
    if (!this.gatewayReady) throw new Error("Gateway not started — call startGateway() first");
    this._stopping = false;
    this._reconnecting = false;

    log.info("Waiting 3s for gateway session to stabilise...");
    await new Promise((r) => setTimeout(r, 3000));

    await this._connectVoiceWithRetry();
  }

  async _connectVoiceWithRetry() {
    await retryWithBackoff(
      () => this._connectVoice(),
      {
        name:   "Discord voice connect",
        baseMs: config.reconnect.delayMs,
        max:    config.reconnect.maxAttempts,
        signal: () => this._stopping,
      }
    );
  }

  async _connectVoice() {
    const guild = await this.client.guilds.fetch(config.discord.guildId);
    await guild.channels.fetch();
    const channel = guild.channels.cache.get(config.discord.channelId);

    if (!channel)              throw new Error(`Channel ${config.discord.channelId} not found`);
    if (!channel.isVoiceBased()) throw new Error(`Channel is not a voice channel`);

    log.info(`Joining Discord voice channel: ${channel.name}`);

    if (this.connection) {
      log.debug("Cleaning up zombie connection before new attempt...");
      this._cleanupVoice();
    }

    this.connection = joinVoiceChannel({
      channelId:      channel.id,
      guildId:        guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf:       false,
      selfMute:       false,
      group:          this.client.user.id,
    });

    this.connection.on("error", (err) => log.error("Voice connection error:", err.message));

    log.info("Waiting for Discord voice connection to become Ready...");

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
      log.info(`✓ Connected to Discord voice channel: ${channel.name}`);
    } catch (err) {
      log.error(`Voice handshake failed: ${err.message}`);
      this._cleanupVoice();
      throw err;
    }

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.connection.subscribe(this.player);
    this.player.on("error", (err) => log.warn("Audio player error:", err.message));

    this._startAudioPipeline();
    this._attachReceiver();

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this._stopping || this._reconnecting) return;
      this._reconnecting = true;
      log.warn("Discord voice disconnected — attempting reconnect...");
      this.isReady = false;
      this.emit("disconnected");
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 3_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 3_000),
        ]);
        log.info("Discord voice self-healed");
        this._reconnecting = false;
        this.isReady = true;
        this.emit("ready");
      } catch {
        this._cleanupVoice();
        this._reconnecting = false;
        await this._connectVoiceWithRetry();
      }
    });

    this.isReady = true;
    this._reconnecting = false;
    this.emit("ready");
  }

  _attachReceiver() {
    const receiver = this.connection.receiver;
    this._daveTransitioning = false;
    this._daveEpoch = 0;

    try {
      const networking = this.connection.state?.networking;
      if (networking) {
        const origOnWs = networking.onWsPacket?.bind(networking);
        if (origOnWs) {
          networking.onWsPacket = (packet) => {
            origOnWs(packet);
            if (packet.op === 24) { this._daveTransitioning = true; log.debug(`DAVE: preparing epoch ${packet.d?.epoch ?? "?"}`); }
            else if (packet.op === 22) { this._daveTransitioning = false; this._daveEpoch = packet.d?.epoch ?? this._daveEpoch + 1; log.info(`DAVE: epoch ${this._daveEpoch} active`); }
          };
        }
      }
    } catch (err) { log.debug("Could not hook DAVE networking layer:", err.message); }

    this._pendingSubscribe = new Set();

    receiver.speaking.on("start", async (userId) => {
      if (this.subscriptions.has(userId)) {
        const sub = this.subscriptions.get(userId);
        if (sub.silenceTimer) { clearTimeout(sub.silenceTimer); sub.silenceTimer = null; }
        return;
      }
      if (this._pendingSubscribe.has(userId)) return;
      this._pendingSubscribe.add(userId);
      log.debug(`User ${userId} speaking — subscribing (120ms DAVE SSRC delay)`);
      await new Promise(r => setTimeout(r, 120));
      this._pendingSubscribe.delete(userId);
      if (this.subscriptions.has(userId)) return;

      const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
      const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
      opusStream.pipe(decoder);

      const WARMUP_FRAMES = 3;
      let _consecutive_ok = 0, _consecutive_fail = 0, _warmedUp = false, _totalFails = 0, _lastFailLog = 0;

      decoder.on("data", (pcm) => {
        _consecutive_fail = 0; _consecutive_ok++;
        if (!_warmedUp) { if (_consecutive_ok >= WARMUP_FRAMES) { _warmedUp = true; log.debug(`DAVE warm-up complete for ${userId}`); } else return; }
        if (this._daveTransitioning) return;
        this.emit("audioPacket", { userId, pcm });
      });

      decoder.on("error", () => {
        _consecutive_ok = 0; _consecutive_fail++; _totalFails++;
        if (_warmedUp) { _warmedUp = false; log.debug(`DAVE: re-warming for ${userId}`); }
        const now = Date.now();
        if (now - _lastFailLog > 5000) { log.debug(`DAVE: ${userId} — ${_totalFails} total failures, ${_consecutive_fail} consecutive`); _lastFailLog = now; }
      });

      const cleanup = () => {
        const sub = this.subscriptions.get(userId);
        if (sub?.silenceTimer) clearTimeout(sub.silenceTimer);
        this.subscriptions.delete(userId);
        try { opusStream.destroy(); } catch {}
        try { decoder.destroy(); } catch {}
        log.debug(`Cleaned up stream for user ${userId}`);
      };
      opusStream.on("close", cleanup);
      opusStream.on("error", cleanup);
      this.subscriptions.set(userId, { opusStream, decoder, silenceTimer: null });
    });

    receiver.speaking.on("end", (userId) => {
      const sub = this.subscriptions.get(userId);
      if (!sub) return;
      if (sub.silenceTimer) clearTimeout(sub.silenceTimer);
      sub.silenceTimer = setTimeout(() => {
        log.debug(`User ${userId} silent for 5s — releasing subscription`);
        const s = this.subscriptions.get(userId);
        if (s) { this.subscriptions.delete(userId); try { s.opusStream.destroy(); } catch {} try { s.decoder.destroy(); } catch {} }
      }, 5000);
    });
  }

  /**
   * Queue a PCM buffer for direct injection (used by TTS).
   * When a mixer is attached via setAudioSource(), relay audio goes
   * through the mixer instead and this method is only used for TTS.
   */
  sendAudio(pcmBuffer) {
    if (!this.isReady) return;
    if (!this._audioQueue) this._audioQueue = [];
    this._audioQueue.push(pcmBuffer);
  }

  /**
   * Attach a PCMMixer as the audio source. The output loop will call
   * mixer.pull() each tick instead of only draining the queue.
   * This ensures a single clock drives both the mixer and the output,
   * preventing drift that accumulates over minutes.
   */
  setAudioSource(mixer) {
    this._audioMixer = mixer;
    log.debug("Audio source (mixer) attached to Discord output");
  }

  _startAudioPipeline() {
    const { PassThrough } = require("stream");
    this._audioQueue = [];
    if (!this._audioMixer) this._audioMixer = null; // preserve across restarts
    this._outStream = new PassThrough({ highWaterMark: 3840 * 50 });
    const resource = createAudioResource(this._outStream, { inputType: StreamType.Raw });
    this.player.play(resource);
    const SILENCE = Buffer.alloc(3840);
    this._silenceInterval = setInterval(() => {
      if (!this._outStream || this._outStream.destroyed) return;

      // Priority 1: Direct queue (TTS injection)
      if (this._audioQueue?.length > 0) {
        this._outStream.push(this._audioQueue.shift());
        return;
      }

      // Priority 2: Pull from mixer (relay audio — single clock, no drift)
      if (this._audioMixer) {
        const mixed = this._audioMixer.pull();
        if (mixed) {
          this._outStream.push(mixed);
          return;
        }
      }

      // No audio — send silence to keep player alive
      this._outStream.push(SILENCE);
    }, 20);
    this.player.on(AudioPlayerStatus.Idle, () => { log.warn("Discord audio player idle — restarting"); this._restartAudioPipeline(); });
    log.debug("Discord audio pipeline started");
  }

  _restartAudioPipeline() {
    if (this._silenceInterval) { clearInterval(this._silenceInterval); this._silenceInterval = null; }
    if (this._outStream) { try { this._outStream.destroy(); } catch {} this._outStream = null; }
    this._audioQueue = [];
    // Preserve _audioMixer reference across restarts
    if (this.player) this._startAudioPipeline();
  }

  _cleanupVoice() {
    for (const { opusStream, decoder } of this.subscriptions.values()) {
      try { opusStream.destroy(); } catch {}
      try { decoder.destroy(); } catch {}
    }
    this.subscriptions.clear();
    if (this.player) { try { this.player.stop(); } catch {} this.player = null; }
    if (this.connection) { try { this.connection.destroy(); } catch {} this.connection = null; }
    if (this._silenceInterval) { clearInterval(this._silenceInterval); this._silenceInterval = null; }
    if (this._outStream) { try { this._outStream.destroy(); } catch {} this._outStream = null; }
    this._audioMixer = null;
    this.isReady = false;
  }

  /** Disconnect voice only — gateway stays alive. */
  async stopVoice() {
    this._stopping = true;
    log.info("Disconnecting Discord voice...");
    this._cleanupVoice();
    log.info("Discord voice disconnected (gateway still active)");
  }

  /** Full shutdown — voice + gateway. */
  async stopAll() {
    this._stopping = true;
    log.info("Stopping Discord client completely...");
    this._cleanupVoice();
    if (this.client) { try { this.client.destroy(); } catch {} this.client = null; }
    this.isReady = false;
    this.gatewayReady = false;
    log.info("Discord client fully stopped");
  }

  // Legacy compat — bridge calls start()/stop() for voice lifecycle
  async start() { return this.startVoice(); }
  async stop()  { return this.stopVoice(); }
}

module.exports = PersistentDiscordClient;