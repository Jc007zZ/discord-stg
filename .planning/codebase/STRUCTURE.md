# Codebase Structure

**Analysis Date:** 2026-08-20

## Directory Layout

```
discord-screen/
├── client/                  # Viewer Activity (React/Vite + client-side code)
│   ├── dist/                # Built output (index.html, assets/)
│   ├── src/
│   │   ├── main.js          # Viewer UI, WebSocket viewer connection, WebRTC peer negotiation
│   │   ├── player.js        # Jitter buffer, decoder, canvas rendering, clock sync
│   │   ├── audio.js         # Audio track decoder, volume control
│   │   ├── player.test.js   # Player unit tests (vitest)
│   │   └── style.css        # CSS for grid, stage, controls
│   ├── index.html           # Entry point (served via Vite in dev, bundled in prod)
│   ├── package.json         # Client deps (React, @discord/embedded-app-sdk, Vite)
│   └── vite.config.js       # Vite build config
│
├── server/                  # Node.js backend (Express + WebSocket)
│   ├── index.js             # HTTP server, WebSocket upgrade, auth, OAuth, room endpoints
│   ├── rooms.js             # Room management, relay, chunk routing, WebRTC signaling
│   ├── tokens.js            # JWT signing/verification (identity, room tokens)
│   ├── system.js            # CPU/memory sampling for admin dashboard
│   ├── admin.js             # Admin dashboard HTML generation
│   ├── public/
│   │   ├── share.html       # Standalone broadcaster UI (captures screen, no viewer grid)
│   │   ├── share.js         # Broadcaster instance (imported from shared/)
│   │   └── admin.js         # Admin panel JavaScript (in-browser dashboard)
│   ├── *.test.js            # Server unit tests (vitest)
│   └── package.json         # Server deps (express, ws, dotenv)
│
├── shared/                  # Code used by both client and server
│   ├── broadcaster.js       # Media capture, VideoEncoder/AudioEncoder, frame pump, peer mgmt
│   ├── rtc.js               # RTCPeerConnection factory, ICE, escape hatches
│   ├── broadcaster.test.js  # Broadcaster unit tests
│   └── rtc.test.js          # RTC tests
│
├── docs/                    # Markdown documentation (user guides, troubleshooting)
├── infra/                   # Deployment config (Docker, environment templates)
│   └── (Dockerfile usage in root)
├── scripts/                 # Utility scripts (configuration, setup)
├── .planning/               # GSD planning documents (this dir)
│   └── codebase/            # ARCHITECTURE.md, STRUCTURE.md, etc.
│
├── .env                     # Environment variables (SECRET, never commit)
├── .env.example             # Template for required vars
├── package.json             # Root package (workspace scripts: dev, build, test)
├── package-lock.json        # Lock file for all deps
├── vitest.config.js         # Test runner config (shared by server/ and client/)
├── vitest.setup.js          # Test setup (mocks, globals)
├── eslint.config.js         # Linting rules (JS, no TypeScript)
├── .prettierrc.json         # Code formatting (tabs, single quotes)
├── Dockerfile               # Container image
├── squarecloud.app          # SquareCloud deployment manifest
└── README.md                # Project overview
```

## Directory Purposes

**`client/src/`:**
- Purpose: React Activity that runs inside Discord iframe, also works standalone on website
- Contains: Viewer grid/stage UI, WebRTC peer answer logic, player instances per stream
- Key files: 
  - `main.js` (89KB) — All UI logic, state management, WebSocket connection
  - `player.js` (11KB) — Jitter buffer, frame queue, canvas rendering
  - `audio.js` (5KB) — Audio decoding and volume control

**`server/`:**
- Purpose: Relay, auth, room management, WebRTC signaling router
- Contains: Express HTTP routes, WebSocket handlers, room state in RAM
- Key files:
  - `index.js` (1300+ lines) — HTTP endpoints, WebSocket upgrade, OAuth, auth middleware
  - `rooms.js` (1000+ lines) — Relay logic, slot management, chunk routing, P2P gating
  - `tokens.js` — JWT sign/verify, scope-based auth
  - `admin.js` — Metrics dashboard HTML generation

**`shared/`:**
- Purpose: Media pipeline code usable by both client and server
- Contains: Capture, encoding, peer construction, escape hatches
- Key files:
  - `broadcaster.js` (1260 lines) — Screen/camera capture, encoder config selection, backpressure, peer opening/closing
  - `rtc.js` (301 lines) — WebRTC factory with Discord Activity sandbox workarounds

## Key File Locations

**Entry Points:**

| Purpose | File | Role |
|---------|------|------|
| Browser Activity | `client/src/main.js` | Creates player instances, manages WebSocket, renders grid |
| Broadcaster Page | `server/public/share.html` + `server/public/share.js` | Standalone screen share capture |
| Viewer Page | `client/index.html` → `src/main.js` | Same as Activity (Activity is just an iframe) |
| Server | `server/index.js` | Express + WebSocket server |
| Admin | `/admin` route → `buildAdminDashboard()` | Dashboard HTML + metrics |

**Configuration:**

| Purpose | File |
|---------|------|
| Server env vars | `.env` (never commit) |
| Client build | `client/vite.config.js` |
| Server build | `vitest.config.js` + `package.json` scripts |
| Linting | `eslint.config.js` |
| Format | `.prettierrc.json` |
| Docker | `Dockerfile` |

**Core Logic:**

| Purpose | File |
|---------|------|
| Media capture & encoding | `shared/broadcaster.js` |
| WebRTC negotiation | `shared/rtc.js` |
| Relay routing | `server/rooms.js` (pushChunk, watch, unwatch) |
| Viewer decode & render | `client/src/player.js` |
| Viewer UI & WebSocket | `client/src/main.js` |
| Auth & tokens | `server/tokens.js` + `server/index.js` `/api/session` |

**Testing:**

| Purpose | File |
|---------|------|
| Broadcaster tests | `shared/broadcaster.test.js` |
| RTC tests | `shared/rtc.test.js` |
| Player tests | `client/src/player.test.js` |
| Server tests | `server/*.test.js` (index, rooms, tokens, admin, system) |
| Test config | `vitest.config.js`, `vitest.setup.js` |

## Naming Conventions

**Files:**
- Modules: camelCase, one concern per file (e.g., `player.js`, `tokens.js`)
- Tests: `*.test.js` or `*.spec.js` suffix
- Config: kebab-case with dot separator (e.g., `vite.config.js`, `.prettierrc.json`)
- Public static: kebab-case (e.g., `share.html`)

**Directories:**
- Lowercase, plural when containing multiple of same kind (e.g., `server/`, `client/src/`, `shared/`)
- Special: `.planning/`, `.env*`, `.git/`, `.github/`

**Functions & Variables:**
- **camelCase** everywhere (Portuguese variable names OK, common for legacy projects)
- **Broadcaster state:** `peers` (Map), `stream`, `encoder`, `ws`, `enviarChunks`
- **Viewer state:** `streams` (Map), `watching` (Set), `available` (Map), `abas` (Set)
- **Room state:** `broadcasters` (Map), `slots` (Map), `viewers` (Set), `controles` (Set)
- **RTC-related:** `pc` (RTCPeerConnection), `ws` (WebSocket), `peerId`, `slot`

**Message Types (WebSocket JSON):**
- Broadcaster → Server: `start`, `stop`, `config`, `audio-config`, `rtc`, `rtc-bye` (from peer closure)
- Server → Broadcaster: `slot`, `need-keyframe`, `rtc-want`, `rtc`, `rtc-bye`, `chunks`, `stop-request`, `error`
- Viewer → Server: `watch`, `unwatch`, `rtc`, `rtc-ativo`, `rename`, `start-broadcast`, `config-broadcast`, `stop-broadcast`, `ambiente`
- Server → Viewer: `state`, `stream-start`, `stream-stop`, `config`, `audio-config`, `chunks`, `rtc`, `room-gone`

## Where to Add New Code

**New Feature / Media Path Change:**

- **Encode workflow** (new codec, new constraint): `shared/broadcaster.js`
  - Modify `pickConfig()` (lines 645–679) to add codec candidates
  - Update `candidatos()` (lines 80–87) to change fallback order
  - Adjust `nivelH264()` if adding new H.264 levels

- **Capture workflow** (new media source, new resolution): `shared/broadcaster.js`
  - `capturarTela()` or `capturarCamera()` to add source
  - `opcoesTela()` (lines 168–178) for capture constraints
  - `fitWithin()` (lines 133–136) if changing max resolution

- **Backpressure / Frame Timing**: `shared/broadcaster.js`
  - `encodeFrame()` (lines 758–851) for frame gating logic
  - `TOLERANCIA_GRADE`, `GRADE_PERDIDA`, `KEYFRAME_EVERY_MS` constants

**Relay Feature (Multi-cast, New Gating):**

- **Chunk routing**: `server/rooms.js:pushChunk()` (lines 702–793)
  - Add filter conditions alongside `v.__rtc.has(entry.slot)` (line 725)
  - Backpressure checks use `bufferedAmount`, adjust thresholds if needed

- **Relay gating logic**: `server/rooms.js:atualizarChunks()` (lines 926–939)
  - Currently: all viewers on P2P → relay off
  - Add conditions to `precisa > 0` calculation if changing gating rules

- **Room state / Participant tracking**: `server/rooms.js:roomState()` (lines 492–545)
  - Add new fields to state object if tracking new metrics
  - Broadcast via `broadcastState()` to all room members

**WebRTC Signaling Extension:**

- **New message types**: `server/index.js`
  - Broadcaster handler (lines 1028–1056): add `else if (msg.type === '...')` case
  - Viewer handler (lines 1076–1187): add `else if (msg.type === '...')` case
  - Call relevant `server/rooms.js` function or reply directly

- **Peer negotiation logic**: `shared/rtc.js:criarPeer()` (lines 206–234)
  - Modify `iceServers` config (line 211)
  - Add event listeners around line 217–231

**Viewer UI / Grid Changes:**

- **Layout / Grid rendering**: `client/src/main.js:renderGrid()` (lines 288+)
  - Grid construction logic, entry generation
  - CSS variables: `--strip` (sidebar width), grid column count

- **Player lifecycle**: `client/src/main.js:openStream()`, `closeStream()`, `startStream()`
  - Player creation, attachment to DOM, cleanup

- **WebRTC peer (viewer side)**: `client/src/main.js` (search for RTCPeerConnection)
  - Currently receives stream from broadcaster's offer
  - Add answer logic, ICE handling, state tracking

**Tests (Add Coverage):**

- **Unit**: New modules get `.test.js` in same directory
- **Integration**: Server routes tested in `server/index.test.js`, WebSocket in `server/index-ws.test.js`
- **E2E**: Not currently implemented; would require browser automation

**Shared Utility:**

- **Helper function used by multiple modules**: `shared/broadcaster.js` or new `shared/utils.js`
  - Clock correction helpers, format helpers, etc.

## Special Directories

**`.planning/codebase/`:**
- Purpose: GSD (Getting Stuff Done) task planning docs
- Generated: By `/gsd-map-codebase` skill
- Committed: Yes (track architecture decisions)

**`node_modules/`:**
- Purpose: npm dependencies
- Generated: Yes (npm install)
- Committed: No (.gitignore)

**`coverage/`:**
- Purpose: Test coverage reports (vitest)
- Generated: Yes (npm run test -- --coverage)
- Committed: No (.gitignore)

**`client/dist/`:**
- Purpose: Vite build output (HTML, CSS, JS bundles)
- Generated: Yes (npm run build)
- Committed: No (rebuilt on deploy)

**`discord-stg/`:**
- Purpose: **IGNORED** — nested Discord app copy (staging clone), ignore entirely
- Committed: No

---

*Structure analysis: 2026-08-20*
