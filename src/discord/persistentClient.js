"use strict";

/**
 * PersistentDiscordClient
 * -----------------------
 * Upgraded to use clientReady and improved voice handshake logic.
 */

const {
  Client,
  GatewayIntentBits,
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
const { Readable }  = require("stream");
const { EventEmitter } = require("events");
const { createLogger } = require("../utils/logger");
const { retryWithBackoff } = require("../utils/retry");
const config        = require("../../config");

const log = createLogger("Discord");

class PersistentDiscordClient extends EventEmitter {
  constructor() {
    super();

    this.client      = null; // created fresh in start()
    this.connection    = null;
    this.player        = null;
    this.subscriptions = new Map();
    this.isReady       = false;
    this._stopping     = false;
    this._reconnecting = false;
  }

  async start() {
    this._stopping = false;
    this._reconnecting = false;

    // Create a fresh Discord.js Client for each call cycle
    // (previous client was destroyed in stop())
    if (!this.client || this.client.destroyed) {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates,
        ],
      });
      this.client.on("error", (err) => {
        log.error("Discord client error:", err.message);
      });
    }

    log.info("Starting Discord client...");

    await this.client.login(config.discord.token);

    await new Promise((resolve) => {
      if (this.client.isReady()) return resolve();
      this.client.once("clientReady", resolve);
    });

    log.info(`Discord logged in as: ${this.client.user.tag}`);

    log.info("Waiting 3s for gateway session to stabilise...");
    await new Promise((r) => setTimeout(r, 3000));

    await this._connectWithRetry();
  }

  async _connectWithRetry() {
    await retryWithBackoff(
      () => this._connect(),
      {
        name:   "Discord voice connect",
        baseMs: config.reconnect.delayMs,
        max:    config.reconnect.maxAttempts,
        signal: () => this._stopping,
      }
    );
  }

  async _connect() {
    const guild = await this.client.guilds.fetch(config.discord.guildId);
    await guild.channels.fetch(); 
    const channel = guild.channels.cache.get(config.discord.channelId);
    
    if (!channel)         throw new Error(`Channel ${config.discord.channelId} not found`);
    if (!channel.isVoiceBased()) throw new Error(`Channel is not a voice channel`);

    log.info(`Joining Discord voice channel: ${channel.name}`);

    if (this.connection) {
      log.debug("Cleaning up zombie connection before new attempt...");
      this._cleanupConnection();
    }

    this.connection = joinVoiceChannel({
      channelId:      channel.id,
      guildId:        guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf:       false,
      selfMute:       false,
      // debug: true removed — was surfacing every DAVE packet failure as a log line
      // Our decoder error handler tracks failures at the application level instead
      group:          this.client.user.id
    });

    // Internal debug logging removed — set debug:true above to re-enable
    this.connection.on("error", (err) => log.error("Voice connection error:", err.message));

    log.info("Waiting for Discord voice connection to become Ready...");
    
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
      log.info(`✓ Connected to Discord voice channel: ${channel.name}`);
    } catch (err) {
      log.error(`Voice handshake failed: ${err.message}`);
      this._cleanupConnection();
      throw err; 
    }

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    this.connection.subscribe(this.player);

    this.player.on("error", (err) => {
      log.warn("Audio player error:", err.message);
    });

    // Start the persistent audio pipeline immediately
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
        this._cleanupConnection();
        this._reconnecting = false;
        await this._connectWithRetry();
      }
    });

    this.isReady = true;
    this._reconnecting = false;
    this.emit("ready");
  }

  _attachReceiver() {
    const receiver = this.connection.receiver;

    // DAVE epoch state machine
    // op 24 = dave_protocol_prepare_epoch  (transition starting — keys rotating)
    // op 22 = dave_protocol_execute_transition (new epoch live — keys valid)
    // op 23 = dave_protocol_ready_for_transition (we are ready)
    this._daveTransitioning = false;
    this._daveEpoch = 0;

    // Intercept raw WS packets to track DAVE epoch transitions
    // @discordjs/voice logs these as [NW] [WS] << {op:XX,...}
    // We hook the networking layer's onWsPacket if available
    try {
      const networking = this.connection.state?.networking;
      if (networking) {
        const origOnWs = networking.onWsPacket?.bind(networking);
        if (origOnWs) {
          networking.onWsPacket = (packet) => {
            origOnWs(packet);
            if (packet.op === 24) {
              // Prepare epoch — transition starting, decryption may fail
              this._daveTransitioning = true;
              log.debug(`DAVE: preparing epoch ${packet.d?.epoch ?? "?"} — gating new decodes`);
            } else if (packet.op === 22) {
              // Execute transition — new epoch live, decryption should work
              this._daveTransitioning = false;
              this._daveEpoch = packet.d?.epoch ?? this._daveEpoch + 1;
              log.info(`DAVE: epoch ${this._daveEpoch} active — decryption restored`);
            }
          };
        }
      }
    } catch (err) {
      log.debug("Could not hook DAVE networking layer:", err.message);
    }

    // Track users currently in the 120ms DAVE delay to prevent duplicate subscribes
    this._pendingSubscribe = new Set();

    receiver.speaking.on("start", async (userId) => {
      // If already subscribed, just clear any pending silence timeout
      if (this.subscriptions.has(userId)) {
        const sub = this.subscriptions.get(userId);
        if (sub.silenceTimer) { clearTimeout(sub.silenceTimer); sub.silenceTimer = null; }
        return;
      }

      // If already in the 120ms delay, don't start another
      if (this._pendingSubscribe.has(userId)) return;
      this._pendingSubscribe.add(userId);

      log.debug(`User ${userId} speaking — subscribing (120ms DAVE SSRC delay)`);

      // Small delay lets @discordjs/voice register the SSRC→key mapping
      // in davey before we start consuming packets, avoiding initial decrypt failures
      await new Promise(r => setTimeout(r, 120));

      this._pendingSubscribe.delete(userId);

      // Check user didn't stop speaking during the delay or already subscribed
      if (this.subscriptions.has(userId)) return;

      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
      });

      const decoder = new prism.opus.Decoder({
        frameSize: 960,
        channels:  2,
        rate:      48000,
      });

      opusStream.pipe(decoder);

      // DAVE warm-up: discard frames until we see WARMUP_FRAMES consecutive
      // successful decodes. This makes DAVE key-setup failures completely silent.
      const WARMUP_FRAMES    = 3;   // need 3 clean frames before forwarding
      let _consecutive_ok    = 0;
      let _consecutive_fail  = 0;
      let _warmedUp          = false;
      let _totalFails        = 0;
      let _lastFailLog       = 0;

      decoder.on("data", (pcm) => {
        _consecutive_fail = 0;
        _consecutive_ok++;

        if (!_warmedUp) {
          if (_consecutive_ok >= WARMUP_FRAMES) {
            _warmedUp = true;
            log.debug(`DAVE warm-up complete for ${userId} — forwarding audio`);
          } else {
            return; // still warming up — discard
          }
        }

        // During epoch transition, pause forwarding but stay warmed up
        if (this._daveTransitioning) return;

        this.emit("audioPacket", { userId, pcm });
      });

      decoder.on("error", () => {
        _consecutive_ok  = 0;
        _consecutive_fail++;
        _totalFails++;

        if (_warmedUp) {
          // Was working, now failing — epoch transition or SSRC change
          // Just pause forwarding; DON'T destroy the subscription.
          // The subscription/stream is fine — it's just the decryption keys rotating.
          _warmedUp = false;
          log.debug(`DAVE: re-warming for ${userId} (key change?)`);
        }

        // Periodic failure logging (every 5s max) so we can diagnose without spamming
        const now = Date.now();
        if (now - _lastFailLog > 5000) {
          log.debug(`DAVE: ${userId} — ${_totalFails} total decrypt failures, ${_consecutive_fail} consecutive`);
          _lastFailLog = now;
        }
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
      // Clean up after 2s of silence — long enough to cover natural speech gaps
      if (sub.silenceTimer) clearTimeout(sub.silenceTimer);
      sub.silenceTimer = setTimeout(() => {
        log.debug(`User ${userId} silent for 5s — releasing subscription`);
        const s = this.subscriptions.get(userId);
        if (s) {
          this.subscriptions.delete(userId);
          try { s.opusStream.destroy(); } catch {}
          try { s.decoder.destroy(); } catch {}
        }
      }, 5000);
    });
  }

  /**
   * Queue a PCM buffer to be sent to Discord on the next 20ms tick.
   * Audio is consumed by a single clock-driven loop — never mixed with silence.
   */
  sendAudio(pcmBuffer) {
    if (!this.isReady) return;
    if (!this._audioQueue) this._audioQueue = [];
    this._audioQueue.push(pcmBuffer);
  }

  /**
   * Start the persistent outgoing audio pipeline.
   * A single 20ms interval drives the stream — it outputs real audio when
   * available, or silence when not. This ensures exactly one frame per tick,
   * preventing the doubled-data-rate issue that causes high-pitched audio.
   */
  _startAudioPipeline() {
    const { PassThrough } = require("stream");

    this._audioQueue = [];
    this._outStream  = new PassThrough({ highWaterMark: 3840 * 50 }); // ~1s buffer

    const resource = createAudioResource(this._outStream, {
      inputType: StreamType.Raw,
    });
    this.player.play(resource);

    // 20ms of silence at 48kHz stereo 16-bit = 960 samples * 2ch * 2bytes
    const SILENCE    = Buffer.alloc(3840);
    const FRAME_MS   = 20;

    this._silenceInterval = setInterval(() => {
      if (!this._outStream || this._outStream.destroyed) return;

      // Drain the queue: send all buffered frames that cover this tick
      if (this._audioQueue && this._audioQueue.length > 0) {
        // Send one frame per tick to maintain timing
        const frame = this._audioQueue.shift();
        this._outStream.push(frame);
      } else {
        // No real audio — fill with silence to keep player alive
        this._outStream.push(SILENCE);
      }
    }, FRAME_MS);

    this.player.on(AudioPlayerStatus.Idle, () => {
      log.warn("Discord audio player went idle — restarting pipeline");
      this._restartAudioPipeline();
    });

    log.debug("Discord audio pipeline started");
  }

  _restartAudioPipeline() {
    if (this._silenceInterval) { clearInterval(this._silenceInterval); this._silenceInterval = null; }
    if (this._outStream) { try { this._outStream.destroy(); } catch {} this._outStream = null; }
    this._audioQueue = [];
    if (this.player) this._startAudioPipeline();
  }

  _cleanupConnection() {
    for (const { opusStream, decoder } of this.subscriptions.values()) {
      try { opusStream.destroy(); } catch {}
      try { decoder.destroy();    } catch {}
    }
    this.subscriptions.clear();

    if (this.player) {
      try { this.player.stop(); } catch {}
      this.player = null;
    }

    if (this.connection) {
      try { this.connection.destroy(); } catch {}
      this.connection = null;
    }

    if (this._silenceInterval) { clearInterval(this._silenceInterval); this._silenceInterval = null; }
    if (this._outStream) { try { this._outStream.destroy(); } catch {} this._outStream = null; }
    this.isReady = false;
  }

  async stop() {
    this._stopping = true;
    log.info("Stopping Discord client...");
    this._cleanupConnection();
    if (this.client) {
      try { this.client.destroy(); } catch {}
    }
    this.isReady = false;
    log.info("Discord client stopped");
  }
}

module.exports = PersistentDiscordClient;