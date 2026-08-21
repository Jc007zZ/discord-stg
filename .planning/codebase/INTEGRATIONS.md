# External Integrations

**Analysis Date:** 2026-08-20

## APIs & External Services

**Discord APIs:**
- **OAuth 2.0** - User authentication and authorization
  - Endpoint: `https://discord.com/api/oauth2/token` (`server/index.js` lines 214-239, 717-727)
  - Endpoint: `https://discord.com/oauth2/authorize` (`server/index.js` line 683)
  - Auth: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` (posted in request body)
  - Used in: Login flow for web users and admin panel

- **Discord User API** - Identity verification
  - Endpoint: `https://discord.com/api/users/@me` (`server/index.js` lines 255-257, 733-735)
  - Auth: Bearer token from OAuth flow
  - Used in: Retrieving user profile (ID, name, avatar) after OAuth

- **Discord Guild API** - Server information (requires bot token)
  - Endpoint: `https://discord.com/api/v10/guilds/{guildId}` (`server/index.js` line 386)
  - Auth: `Bot ${DISCORD_BOT_TOKEN}` header
  - Used in: Resolving server names for admin panel (cached 1 hour)
  - Required for: Admin panel metrics display

- **Discord Voice State API** - User presence in voice channels (requires bot token)
  - Endpoint: `https://discord.com/api/v10/guilds/{guildId}/voice-states/{userId}` (`server/index.js` line 416)
  - Auth: `Bot ${DISCORD_BOT_TOKEN}` header
  - Used in: Verifying user is in voice channel before allowing Activity access
  - Returns: User's channel_id if in voice, 404 if not, 10004 if bot not in guild

**CDN APIs:**
- **Discord Avatar CDN** - User profile pictures
  - Endpoint: `https://cdn.discordapp.com/avatars/{id}/{hash}.png` (`server/index.js` line 489)
  - No auth required
  - Used in: Mirroring avatars at `/api/avatar/:id/:hash` to bypass CSP restrictions
  - Caching: In-memory LRU cache (max 200 images, ~few KB each)

**Google Public STUN Server:**
- **STUN (Session Traversal Utilities for NAT)** - NAT/firewall detection for WebRTC
  - Server: `stun:stun.l.google.com:19302` (hardcoded as fallback, `shared/rtc.js` line 19)
  - No auth required
  - Used in: `RTCPeerConnection` ICE candidate gathering for P2P direct connection
  - Fallback: Always available at `/api/ice`

## Data Storage

**Databases:**
- Not applicable - No persistent database
- In-memory room state management (`server/rooms.js`):
  - Rooms and participants stored in memory during session
  - Rooms are ephemeral (destroyed when all participants leave)
  - Guild/server name cache (1 hour TTL) in `server/index.js` line 367-400

**File Storage:**
- Local filesystem only
- `server/public/` - Static files served for capture page (share.html, terms, privacy)
- `client/dist/` - Built Activity bundle (generated at build time)
- `shared/` - Shared media pipeline code served at `/shared` (`server/index.js` lines 176-180)
- `.env` - Environment configuration (local only, never committed)

**Caching:**
- **In-memory caches:**
  - Guild name cache - Map with 1-hour expiration (`server/index.js` lines 367-400)
  - Avatar image cache - LRU Map (max 200 images, `server/index.js` lines 472-500)
  - ICE servers - Fetched once per browser session, reused (`shared/rtc.js` lines 30-37)

## Authentication & Identity

**Auth Provider:**
- Discord OAuth 2.0 (for Discord users)
- Custom JWT-like tokens (unsigned but HMAC-signed) for session/room access

**Auth Implementation:**
- **Token Signing:** `server/tokens.js` - Symmetric HMAC-SHA256 signing
  - Format: `<base64url_payload>.<base64url_hmac>`
  - Secret: `SESSION_SECRET` env var, development default: `dev-insecuro-troque-isto`
  - TTL: Optional (identity tokens: 8 hours; room tokens: no expiration)
  - Scopes: `identity` (user session), room tokens (broadcaster/viewer), `admin` (admin panel), `oauth-state` (OAuth CSRF protection)

- **Discord Login Flow:**
  1. POST `/api/token` - Client sends OAuth code
  2. Server exchanges code for access_token via Discord API
  3. POST `/api/session` - Server verifies access_token with Discord
  4. Server issues identity token with user info + guild context
  5. Identity token authorizes all subsequent room operations

- **Guest Login:** POST `/api/session-guest` - No auth, generates random guest ID
  
- **Admin Panel:** Cookie-based auth
  - Cookie name: `discord_screen_admin` (set in `/auth/callback`)
  - Value: Signed identity token with `scope: admin`
  - Verified in `server/index.js` lines 820-835
  - Required: `DISCORD_ADMIN_ID` env var to enable, `SESSION_SECRET` for cookie signing

**Activity Integration:**
- Discord Activity runs in iframe sandbox at `https://<id>.discordsays.com`
- CSP header prevents access to Discord CDN, so avatars proxied via `/api/avatar`
- X-Frame-Options and frame-ancestors CSP allow embedding in Discord only (`server/index.js` lines 151-158)

## Monitoring & Observability

**Error Tracking:**
- None configured - Errors logged to console only

**Logs:**
- Console logging throughout (`server/index.js`, `shared/broadcaster.js`)
- No persistent log storage
- Logged events:
  - OAuth flow start/failure (`[oauth]` prefix)
  - Room creation/closure (`[room {id}]` prefix)
  - WebRTC P2P state changes (`[p2p]` prefix)
  - Voice channel verification (`[voz]` prefix)
  - Ambient/diagnostic info from clients (`[ambiente]`, `[saidas]` prefixes)

**Admin Metrics:**
- `/api/admin/metrics` endpoint provides real-time dashboard data (`server/index.js` lines 858-873)
- Metrics include:
  - Room state (active rooms, participants, streams)
  - WebSocket connections and RTT measurements
  - System stats (CPU, memory, uptime)
  - Configuration state

## CI/CD & Deployment

**Hosting:**
- Square Cloud (primary) - Configured via `squarecloud.app` file
- Docker-compatible (Dockerfile present for local deployment)
- Can run locally or on any Node 22 host

**Deployment Process:**
1. Git push to repository
2. Square Cloud detects `squarecloud.app` configuration
3. Builds Docker container using `Dockerfile` (multi-stage)
4. Runs health check: `GET /api/health`
5. Routes traffic through Traefik reverse proxy

**Continuous Integration:**
- Not detected (no GitHub Actions workflows in `.github/` beyond pull request templates)
- Smoke tests available manually: `npm run smoke` (controls), `npm run smoke:controle` (broadcaster tab)

**Development Tunneling:**
- Cloudflare tunnel support via `npm run tunel` (temporary) or `npm run tunel:criar` (persistent)
- `cloudflared` binary downloaded on first use (~50 MB, cached in `.cache/`)
- Exposes `http://localhost:3001` to internet via `https://<subdomain>.cfargotunnel.com`

## Environment Configuration

**Required Environment Variables:**
- `DISCORD_CLIENT_ID` - OAuth client ID from Discord Developer Portal
- `DISCORD_CLIENT_SECRET` - OAuth secret (production only)
- `SESSION_SECRET` - HMAC signing key (production mandatory, 32+ chars recommended)

**Optional Environment Variables:**
- `DISCORD_BOT_TOKEN` - Bot token (enables voice channel verification and server name resolution)
- `DISCORD_ADMIN_ID` - Comma/space/semicolon-separated Discord user IDs (enables admin panel)
- `PUBLIC_ORIGIN` - Public URL (default: `http://localhost:3001`, must not end with `/`)
- `PORT` - HTTP listen port (default: 3001)
- `NODE_ENV` - `production` (required for release), `development` (default, relaxes constraints)
- `P2P_ONLY` - Set to non-empty/non-zero to force WebRTC-only (disables relay fallback)
- `TURN_URL` - TURN server URL (e.g., `turn:turnserver.example.com:3478`)
- `TURN_USER` - TURN server username
- `TURN_PASS` - TURN server password

**Secrets Location:**
- `.env` file in project root (not committed)
- Environment variables passed at runtime (Docker `ENV`, Square Cloud dashboard)
- Never hardcoded in source code except development defaults in `server/tokens.js`

## Webhooks & Callbacks

**Incoming:**
- POST `/api/token` - OAuth callback (code exchange)
- POST `/api/session` - Session establishment (identity token creation)
- GET `/auth/callback` - OAuth redirect from Discord (state validation, cookie setting)
- GET `/admin/auth/login` - Admin login initiation
- WebSocket `/ws` - Media streaming and signaling (upgraded from HTTP)

**Outgoing:**
- None - This is a pull-only service
- Discord CDN requests are one-way (avatars, CDN resources)
- Cloudflare tunnel creates reverse proxy connection but no webhooks

## Real-Time Communication

**WebRTC:**
- **ICE Servers:** Retrieved from `/api/ice`, includes STUN (always public Google server) and optional TURN
- **Signaling:** Via WebSocket messages with `type: 'rtc'`
- **Payload:** Encrypted by browser (SRTP over UDP)
- **Failure Mode:** Falls back to WebSocket relay (`server/rooms.js`) if P2P negotiation fails

**WebSocket Protocol:**
- Connection: Authenticated via token in query parameter (`t=`)
- Commands: JSON messages for room operations (watch, unwatch, rename)
- Streaming: Binary frames for media chunks (video/audio relay)
- Heartbeat: Server sends ping every 15 seconds, expects pong to keep connection alive (`server/index.js` lines 1194-1224)

---

*Integration audit: 2026-08-20*
