
#THIS IS SLOP GENERATED! 
there is physical review happening but not enough and not confidently skilled enough to be trusted without your own due diligence 
---

# Persistent Matrix ↔ Discord Voice Bridge

A single always-on bot that bridges audio between a Discord voice channel and an Element Call (Matrix/LiveKit) room. Each instance watches one Discord channel and one Matrix room — deploy multiple instances for multiple rooms.

---

## How It Works

```
Discord Voice Channel            Element Call (Matrix room)
     #general-voice                  !roomid:example.com
          │                                │
          ▼                                ▼
 PersistentDiscordClient          LiveKitClient
 (@discordjs/voice)               (@livekit/rtc-node)
          │                                │
          └────────── AudioRelay ──────────┘
                     PCMMixer × 2
               (single clock per direction)
```

### Architecture

The bridge has two layers: **persistent services** that run from boot, and **per-call resources** that connect and disconnect each call cycle.

**Always running (boot → shutdown):**

- **Discord gateway** — logged in to Discord, handles `/status` command, `voiceStateUpdate` events, and text announcements via embeds. Does NOT sit in the voice channel between calls.
- **Matrix sync loop** — watches the configured room for `org.matrix.msc3401.call.member` state events. Detects call start/end and individual participant join/leave.
- **Presence tracker** — monitors who is in each side and posts announcements. Text messages always active; TTS audio only while bridging.

**Connected per-call:**

- **LiveKit** — connects to the SFU when an Element Call is detected with at least one real participant. Token obtained via OpenID → lk-jwt-service (the same auth flow Element Call clients use).
- **Discord voice** — joins the configured voice channel only during active calls.
- **Audio relay** — two passive PCMMixers, each driven by a single clock (LiveKit output loop or Discord output loop). No dual-clock drift.

### Lifecycle

1. **Boot** — Discord gateway logs in, Matrix sync starts, presence tracker begins monitoring
2. **Waiting** — Bot watches for Element Call activity. Text announcements work (Discord embeds + Matrix messages)
3. **Call detected** — Someone starts an Element Call in the Matrix room. Bot verifies there is at least one non-bot participant before joining.
4. **Connecting** — Bot gets a LiveKit token via lk-jwt-service, connects to LiveKit, joins the Discord voice channel, starts the audio relay and TTS
5. **Bridging** — Audio flows bidirectionally. TTS announces join/leave events in both directions.
6. **Call ends** — Per-call resources tear down (LiveKit, Discord voice, relay, TTS). Gateway, sync, and text announcements continue.
7. **Repeat** — Back to step 2, waiting for the next call

### Presence Announcements

When users join or leave either side:

- **Discord → Matrix:** Text message in the Matrix room + TTS into LiveKit audio (when bridging)
- **Matrix → Discord:** Embed in the Discord text channel + TTS into Discord audio (when bridging)
- **`/status` command:** Shows a roster of who is on each side, available anytime (even between calls)

---

## Setup

### 1. Prerequisites

- Node.js ≥ 18
- FFmpeg on PATH (`apt install ffmpeg`)
- Build tools for native modules (`apt install build-essential python3`)
- espeak-ng for TTS announcements (`apt install espeak-ng`) — optional, falls back to a notification tone

### 2. Install

```bash
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

```env
# ─── Discord ──────────────────────────────────────────────────────────────
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_GUILD_ID=your_server_id
DISCORD_CHANNEL_ID=your_voice_channel_id

# Optional: send embeds to a specific text channel instead of the voice channel's text chat
# DISCORD_TEXT_CHANNEL_ID=your_text_channel_id

# ─── Matrix / Element ────────────────────────────────────────────────────
MATRIX_HOMESERVER_URL=https://matrix.example.com
MATRIX_BOT_USER_ID=@bridge-bot:example.com
MATRIX_BOT_ACCESS_TOKEN=syt_...
MATRIX_ROOM_ID=!abc123:example.com

# ─── LiveKit (optional) ──────────────────────────────────────────────────
# Leave blank to use OpenID → lk-jwt-service (recommended).
# Only set these if you need self-signed tokens as a fallback.
# LIVEKIT_API_KEY=
# LIVEKIT_API_SECRET=

# ─── Behaviour ───────────────────────────────────────────────────────────
RECONNECT_DELAY_MS=5000
MAX_RECONNECT_ATTEMPTS=0
CALL_WAIT_TIMEOUT_MS=0
LOG_LEVEL=info
HTTP_PORT=3000
```

### 4. LiveKit Token Strategy

The bridge obtains LiveKit tokens the same way Element Call clients do:

1. Requests an **OpenID token** from the Matrix homeserver
2. Sends it to the **lk-jwt-service** (MatrixRTC Authorization Service) at the `livekit_service_url` advertised in the room's call member state events
3. Receives a JWT scoped to the correct LiveKit room — including the opaque room name that ESS v2.3.0+ uses

This means **no `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET` is required** in most setups. The lk-jwt-service handles room name derivation, room creation for full-access users, and proper token scoping.

**Requirements:**
- Your Matrix homeserver must have an OpenID listener configured (Synapse does by default)
- The lk-jwt-service must be reachable at the URL path `/sfu/get` relative to the `livekit_service_url` in your `.well-known/matrix/client` config
- Your bot's homeserver should be listed in `LIVEKIT_FULL_ACCESS_HOMESERVERS` on the lk-jwt-service so it can trigger room creation

**Fallback:** If `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are set in `.env`, the bridge will attempt self-signed tokens if the lk-jwt-service call fails.

### 5. Getting IDs

**Discord Guild/Channel IDs:** Enable Developer Mode in Discord Settings → Appearance, then right-click any server or channel → "Copy ID".

**Matrix Room ID:** In Element, go to Room Settings → Advanced. Looks like `!abc123:example.com`.

**Matrix Access Token:**
```bash
curl -XPOST -d '{
  "type": "m.login.password",
  "identifier": {"type": "m.id.user", "user": "bridge-bot"},
  "password": "your_password"
}' https://matrix.example.com/_matrix/client/v3/login
```

### 6. Discord Bot Permissions

In the Discord Developer Portal:
- **Scopes:** `bot`, `applications.commands`
- **Permissions:** `Connect`, `Speak`, `Use Voice Activity`, `Send Messages`, `Embed Links`
- **Privileged Gateway Intents:** `Server Members Intent`, `Voice State Intent`

### 7. Run

```bash
npm test    # Test the audio mixer in isolation
npm start   # Start the bridge
```

---

## Multiple Instances

Each bridge instance handles one Discord channel ↔ one Matrix room. For multiple rooms, run multiple instances with different `.env` files.

**Important:** Each instance needs its own:
- **Discord bot application** (separate token) — Discord bots share a single gateway session per token
- **Matrix bot account** (separate user + access token) — prevents sync cross-contamination
- **Matrix room** — each bot should only be a member of its assigned room

Example with Docker Compose:

```yaml
services:
  bridge-general:
    build: .
    env_file: .env.general
    restart: unless-stopped

  bridge-gaming:
    build: .
    env_file: .env.gaming
    restart: unless-stopped
```

---

## Status API

```bash
curl http://localhost:3000/status
```

```json
{
  "state": "bridging",
  "discordReady": true,
  "gatewayReady": true,
  "livekitReady": true,
  "relayActive": true,
  "callId": "!abc123:example.com",
  "startedAt": "2026-03-20T12:00:00.000Z",
  "matrixRoom": "!abc123:example.com",
  "discordChannel": "123456789012345678",
  "roster": {
    "discord": ["Alice", "Bob"],
    "matrix": ["charlie", "dana"]
  }
}
```

States: `idle` → `waiting_for_call` → `connecting_livekit` → `connecting_discord` → `bridging` → `recovering` → (loop)

```bash
curl http://localhost:3000/health
# {"status":"ok","uptime":12345}
```

---

## Discord `/status` Command

When the bridge is running, users can type `/status` in Discord to see an embed showing who is on each side of the bridge and whether the voice bridge is active.

---

## Running as a Service

### systemd

```ini
# /etc/systemd/system/voice-bridge.service
[Unit]
Description=Matrix Discord Voice Bridge
After=network.target

[Service]
Type=simple
User=bridge
WorkingDirectory=/opt/voice-bridge
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/voice-bridge/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now voice-bridge
sudo journalctl -u voice-bridge -f
```

### Docker

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg build-essential python3 espeak-ng && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "src/index.js"]
```

```bash
docker build -t voice-bridge .
docker run -d --env-file .env --restart unless-stopped voice-bridge
```

---

## Reconnection Behaviour

| Scenario | Recovery |
|---|---|
| Discord voice drops | Tries self-heal (3s), then full rejoin with backoff |
| LiveKit disconnects | Automatic reconnect inside LiveKitClient |
| Element Call ends | Per-call resources tear down, bot waits for next call |
| Matrix sync fails | Retries with 5s delay, never stops |
| Discord gateway drops | Discord.js handles automatic reconnection |
| lk-jwt-service unreachable | Retries with backoff; falls back to self-signed tokens if API key is configured |

---

## Troubleshooting

**Bot joins Discord but no audio from Matrix:**
Check `/status` — state should be `bridging`. If `waiting_for_call`, no Element Call is active in the Matrix room.

**"Could not obtain LiveKit token" error:**
The lk-jwt-service at your `livekit_service_url` is not reachable, or the bot's homeserver is not in `LIVEKIT_FULL_ACCESS_HOMESERVERS`. Check that `{livekit_service_url}/sfu/get` is accessible.

**Bot connects but Element Call shows "waiting for media":**
This usually means stale state from a previous connection. The bridge cleans up stale memberships automatically, but you can restart the bridge to force cleanup.

**Multiple bots joining the wrong calls:**
Each instance must have its own Discord bot token AND its own Matrix bot account. Bots should only be members of their assigned Matrix room — remove them from other rooms.

**Audio delay builds up over time:**
This was fixed with single-clock-per-direction audio routing. If you still experience drift, check that you're running the latest version of `audioRelay.js` and `persistentClient.js`.

**TTS not audible on Matrix side:**
Ensure `espeak-ng` is installed (`apt install espeak-ng`). Check logs for `TTS engine: espeak-ng` at startup. TTS only plays while the voice bridge is active (state `bridging`).

**`@livekit/rtc-node` fails to install:**
```bash
apt install build-essential python3
npm install
```
