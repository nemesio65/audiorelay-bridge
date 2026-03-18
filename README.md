# Persistent Matrix ↔ Discord Voice Bridge

A single always-on bot that permanently occupies one Discord voice channel and one Matrix/Element Call room, relaying audio between them indefinitely. No slash commands needed — just configure it and run it.

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
                     (20ms frames)
```

### Lifecycle

1. **Boot** — Both Discord and Matrix clients start in parallel
2. **Discord** — Bot immediately joins the configured voice channel, auto-reconnects forever on drop
3. **Matrix** — Sync loop starts. Bot joins the Matrix room and watches for Element Call sessions
4. **Waiting** — If no call is active, bot sits idle in the Discord channel and waits (sends a message in Matrix saying it's ready)
5. **Call detected** — As soon as someone starts an Element Call in the Matrix room, the bot connects to LiveKit and the audio relay starts
6. **Bridging** — Audio flows bidirectionally. Discord users hear Matrix users and vice versa
7. **Call ends** — Relay tears down, bot goes back to step 4 waiting for the next call
8. **Any failure** — Each component retries independently with exponential backoff. The bridge never gives up.

---

## Setup

### 1. Install

```bash
npm install
```

**System requirements:**
- Node.js ≥ 18
- FFmpeg on PATH (`apt install ffmpeg` / `brew install ffmpeg`)
- Build tools for native modules (`apt install build-essential` on Linux)

### 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

```env
# Discord bot credentials
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id

# The SPECIFIC channel to sit in permanently
DISCORD_GUILD_ID=your_server_id
DISCORD_CHANNEL_ID=your_voice_channel_id

# Matrix bot credentials
MATRIX_HOMESERVER_URL=https://matrix.example.com
MATRIX_BOT_USER_ID=@bridge-bot:example.com
MATRIX_BOT_ACCESS_TOKEN=syt_...

# The SPECIFIC Matrix room to watch
MATRIX_ROOM_ID=!abc123:example.com

# LiveKit credentials (if you run your own LiveKit server)
# Leave blank to use homeserver-issued tokens (for hosted Element Call)
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

#### Getting IDs

**Discord Guild/Channel IDs:** Enable Developer Mode in Discord Settings → Appearance, then right-click any server or channel and select "Copy ID".

**Matrix Room ID:** In Element, go to Room Settings → Advanced. The room ID looks like `!abc123:example.com`.

**Matrix Access Token:**
```bash
curl -XPOST -d '{
  "type": "m.login.password",
  "identifier": {"type": "m.id.user", "user": "bridge-bot"},
  "password": "your_password"
}' https://matrix.example.com/_matrix/client/v3/login
# Copy the access_token field
```

#### LiveKit: two scenarios

**You run your own LiveKit** (self-hosted or LiveKit Cloud):
Set `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. The bot self-signs tokens.

**You use hosted Element Call** (matrix.org, element.io, etc.):
Leave both blank. The bot asks the Matrix homeserver for tokens via the `/_matrix/client/v3/rooms/{roomId}/call/jwt` endpoint. This requires your homeserver to support that endpoint (Synapse does with the right config).

### 3. Discord bot permissions

In the Discord Developer Portal, your bot needs:
- **Scopes:** `bot`
- **Permissions:** `Connect`, `Speak`, `Use Voice Activity`
- **Intents:** `Server Members Intent` + `Voice State Intent` (under Privileged Gateway Intents)

### 4. Run

```bash
# Test the audio mixer in isolation first
npm test

# Start the bridge
npm start
```

---

## Status API

The bridge exposes a simple HTTP status endpoint:

```bash
curl http://localhost:3000/status
```

Example response:

```json
{
  "state": "bridging",
  "discordReady": true,
  "livekitReady": true,
  "relayActive": true,
  "callId": "some-uuid-1234",
  "startedAt": "2026-03-16T12:00:00.000Z",
  "matrixRoom": "!abc123:example.com",
  "discordChannel": "123456789012345678"
}
```

States: `idle` → `connecting_discord` → `waiting_for_call` → `connecting_livekit` → `bridging` → `recovering` → (loop)

```bash
curl http://localhost:3000/health
```

---

## Running as a Service

### systemd (Linux)

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
RUN apt-get update && apt-get install -y ffmpeg build-essential python3 && rm -rf /var/lib/apt/lists/*
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
| Element Call ends | Relay stops, bot waits for next call to start |
| Matrix sync fails | Retries with 5s delay, never stops |
| Any startup failure | Exponential backoff, retries indefinitely (unless MAX_RECONNECT_ATTEMPTS is set) |

---

## Troubleshooting

**Bot joins Discord but no audio from Matrix:**
Make sure Element Call is actually running in the Matrix room. Check `/status` — state should be `bridging`, not `waiting_for_call`.

**"No LiveKit credentials" error:**
Either set `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`, or ensure your homeserver supports `/_matrix/client/v3/rooms/{id}/call/jwt`.

**`@livekit/rtc-node` fails to install:**
```bash
apt install build-essential python3  # Ubuntu/Debian
npm install                           # retry
```

**Audio is one-sided:**
Check that `selfDeaf: false` is set (it is by default in this code). Also verify the bot has `Speak` permission in Discord.
