"use strict";
require("dotenv").config();
function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
function optional(name, fallback = "") { return process.env[name] ?? fallback; }
function optionalInt(name, fallback) { const v = process.env[name]; return v ? parseInt(v, 10) : fallback; }
module.exports = {
  discord: {
    token:         required("DISCORD_BOT_TOKEN"),
    clientId:      required("DISCORD_CLIENT_ID"),
    guildId:       required("DISCORD_GUILD_ID"),
    channelId:     required("DISCORD_CHANNEL_ID"),
    // Optional: separate text channel for announcements.
    // If not set, announcements go to the voice channel's built-in text chat.
    textChannelId: optional("DISCORD_TEXT_CHANNEL_ID"),
  },
  matrix: {
    homeserverUrl: required("MATRIX_HOMESERVER_URL"),
    botUserId:     required("MATRIX_BOT_USER_ID"),
    accessToken:   required("MATRIX_BOT_ACCESS_TOKEN"),
    roomId:        required("MATRIX_ROOM_ID"),
  },
  livekit: {
    apiKey:    optional("LIVEKIT_API_KEY"),
    apiSecret: optional("LIVEKIT_API_SECRET"),
  },
  reconnect: {
    delayMs:     optionalInt("RECONNECT_DELAY_MS",     5000),
    maxAttempts: optionalInt("MAX_RECONNECT_ATTEMPTS", 0),
    callWaitMs:  optionalInt("CALL_WAIT_TIMEOUT_MS",   0),
  },
  logLevel: optional("LOG_LEVEL", "info"),
  httpPort:  optionalInt("HTTP_PORT", 3000),
};