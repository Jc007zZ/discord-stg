# Architecture

**Analysis Date:** 2026-08-20

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                    Broadcaster (Screen Share)                │
│              `shared/broadcaster.js` (client-side)           │
│  • Screen/camera capture (getUserMedia/getDisplayMedia)      │
│  • VideoEncoder config selection & frame pump               │
│  • Backpressure hysteresis + rhythm grid                    │
│  • Peers Map (one RTCPeerConnection per viewer)             │
└────────┬─────────────────────────────────────────┬──────────┘
         │ Binary chunks + JSON signaling           │
         ▼                                          ▼
┌─────────────────────────────────┐      ┌────────────────────┐
│  WebSocket Relay (TCP-based)     │      │ RTCPeerConnection  │
│  `server/rooms.js`               │      │ (P2P via SRTP/UDP) │
│ • pushChunk() — multi-cast       │      │ Direct connection  │
│ • watch/unwatch — viewers opt-in │      │ Broadcaster ← Peer │
│ • Slot→Broadcaster routing       │      └─────────┬──────────┘
│ • Config/keyframe guards         │               │
│ • Backpressure (bufferedAmount)  │               ▼
└─────────────────────────────────┘      ┌────────────────────┐
         │                               │  Viewer's Canvas   │
         │ Keyframes + Delta frames      │  `client/src/player.js`
         ▼                               │ • Jitter buffer    │
    ┌────────────────┐                   │ • Clock sync       │
    │ Viewer WebSocket                   │ • Frame queue      │
    │ (receive-only)  │                  └────────────────────┘
    │                │
    │ • Config       │
    │ • Audio config │
    │ • Chunks       │
    │ • Keyframes    │
    │ • RTC control  │
    └────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **Broadcaster** | Captures media, encodes frames, manages peer connections, gates relay | `shared/broadcaster.js` |
| **RTC Peer Factory** | Constructs WebRTCPeerConnection, escapes Discord Activity sandbox | `shared/rtc.js` |
| **Server Room Manager** | Holds rooms in memory, routes chunks, manages slots, handles WebRTC signaling | `server/rooms.js` |
| **HTTP+WebSocket Server** | Auth, token verification, OAuth flow, ICE servers, WebSocket upgrade | `server/index.js` |
| **Viewer UI** | Renders grid/stage, manages player lifecycle, handles stream selection | `client/src/main.js` |
| **Player (Decoder)** | Jitter buffer, clock skew detection, frame queue, canvas rendering | `client/src/player.js` |
| **Audio Encoder** | Opus audio encoding from captured audio track | `shared/broadcaster.js` (lines 581–634) |

## Pattern Overview

**Overall:** STAR topology with TCP relay fallback

**Key Characteristics:**
- Broadcaster opens RTCPeerConnection TO each viewer (not the reverse)
- Relay (WebSocket) is the safety net: TCP ensures ordered delivery
- P2P is the optimization: UDP with adaptive bitrate reduces latency and server load
- No fan-out cap: any authenticated user can broadcast (capped at 4 broadcasters per room)
- Slot-based multiplexing: each broadcaster gets a numeric slot (0–3), stamped in byte 0 of every chunk
- Dynamic relay gating: `enviarChunks` flag turns off relay when all viewers are on P2P
- Clients can opt into P2P-only mode (`p2p=only`) for testing/debugging

## Layers

**Capture & Encoding Layer:**
- Purpose: Convert raw media (screen/camera + audio) into packetized chunks
- Location: `shared/broadcaster.js`
- Contains: `pump()`, `pumpDirect()`, `pumpViaVideo()`, `encodeFrame()`, `pickConfig()`, `onEncoded()`, audio encoding
- Depends on: WebCodecs API, MediaStreamTrackProcessor (Chromium), VideoEncoder, AudioEncoder
- Used by: Both Activity iframe and external capture page (same code, two deployments)

**Relay Layer:**
- Purpose: Multiplex broadcasters to viewers over TCP WebSocket; route WebRTC signaling
- Location: `server/rooms.js`
- Contains: `pushChunk()` (multi-cast to all viewers watching this slot), `watch()`/`unwatch()`, WebRTC envelope routing (`rtcParaBroadcaster()`, `rtcParaViewer()`), chunk backpressure, config/keyframe guards
- Depends on: Node.js `ws` library, in-memory room state
- Used by: `server/index.js` WebSocket handlers

**Peer Connection Layer:**
- Purpose: Offer/answer negotiation, ICE gathering, frame track exchange
- Location: `shared/rtc.js`
- Contains: `construtorPeer()` (escapes Discord sandbox), `criarPeer()`, `ajustarEnvio()` (bitrate/degradation prefs), `iceServers()` (STUN/TURN)
- Depends on: RTCPeerConnection (or webkit alias, or iframe workaround)
- Used by: `createBroadcaster()` for `abrirPeer()`, `receberRtc()`, `fecharPeer()`

**Decode & Render Layer:**
- Purpose: Reassemble chunks into frames, jitter-buffer them, decode, draw to canvas, sync audio
- Location: `client/src/player.js`, `client/src/audio.js`
- Contains: `createPlayer()` (start, push, draw, jitter buffer logic), clock skew detection, frame queue
- Depends on: WebCodecs API (VideoDecoder, AudioDecoder), Canvas 2D context
- Used by: `client/src/main.js` viewer

**Auth & Session Layer:**
- Purpose: OAuth with Discord, issue signed tokens, token verification for every operation
- Location: `server/index.js` (lines 186–325), `server/tokens.js`
- Contains: `/api/token` (exchange code for access_token), `/api/session` (identify user), token signing/verification
- Depends on: Discord OAuth endpoints, JWT signing
- Used by: Every room operation (create, join, broadcast, watch)

## Data Flow

### Primary Request Path: Screen Share

1. **Capture** (`shared/broadcaster.js:pump()`) — User clicks "Share Screen"
   - `getDisplayMedia()` or `getUserMedia()` opens picker
   - VideoEncoder configured with `pickConfig()` choosing H.264 level based on resolution + FPS
   
2. **Encode** (`encodeFrame()`) — Frame arrives from track processor
   - Backpressure hysteresis: if `encodeQueueSize > 2`, discard frame and set `afogado=true`
   - Rhythm grid (`proximaMarca`) throttles to target FPS independent of network
   - `encoder.encode()` produces keyframes on demand or periodically (3s)
   - Optional scaling via canvas when frame exceeds 1920×1080 max
   
3. **Pack** (`empacotar()`) — Encoded chunk exits encoder
   - `[1B slot][1B type][8B timestamp][8B sendTime][payload]`
   - Type: 1=keyframe, 2=delta, 3=audio
   - Slot allows server to route without parsing
   
4. **Send to Relay** (`broadcaster.js:onEncoded()`) — WebSocket binary send
   - Only if `enviarChunks===true` (relay needed)
   - Only if `ws.readyState === OPEN`
   - Bytes tracked for stats
   
5. **Server Relay** (`server/rooms.js:pushChunk()`) — Received at `handleBroadcaster`
   - Extract slot from byte 0, find broadcaster entry
   - For each viewer watching this slot:
     - If watching via P2P (`ws.__rtc.has(slot)`), skip — they get it from peer
     - If buffer too full, drop (increment `droppedChunks`)
     - If keyframe and not yet primed (`ws.__primed`), add to primed set
     - If delta and not primed, skip until next keyframe
     - Otherwise, send binary to viewer's WebSocket
   - Audio has higher buffer threshold (2× keyframe threshold)
   
6. **Viewer Receives** (`client/src/main.js:handleBroadcaster` → `handleMessage`) — JSON or binary
   - Config message: call `player.start(config)` → VideoDecoder.configure()
   - Binary chunk: call `player.push(chunk)` → decoder.decode()
   
7. **Decode & Buffer** (`client/src/player.js:push()` → `draw()`) — Frame enters jitter buffer
   - Keyframe check: if `needKeyframe && !isKeyframe`, drop (wait for keyframe)
   - Decode enqueues frame to decoder output
   - `draw()` (decoder's output callback) computes display time based on capture timestamp
   - Frame queued with `exibirEm = base + tsMs` (base = viewer's clock - capture timestamp)
   - If queue > 12 frames, discard oldest
   
8. **Render** (`drawNextFrame()` via `requestAnimationFrame`) — Frame appears on canvas
   - Pop frame from queue whose `exibirEm <= now()`
   - Draw to canvas via `ctx.drawImage(frame, …)`
   - Close frame to free resources
   - Measure jitter every 2s and adjust `base` if clock skew detected

### Secondary Flow: WebRTC Direct Connection

1. **Viewer Requests** (`client/src/main.js:watchSlot()`) — "watch" message sent
   - `ws.send({ type: 'watch', slot })`
   - Relay immediately sends config (if cached) and keyframe request
   
2. **Broadcaster Invited** (`server/rooms.js:watch()`) — `rtc-want` sent
   - `sendJson(entry.ws, { type: 'rtc-want', peer: ws.__peerId })`
   
3. **Broadcaster Opens Connection** (`broadcaster.js:abrirPeer()`) — Offer created
   - Fetch ICE servers via `/api/ice`
   - `criarPeer()` constructs RTCPeerConnection with STUN/TURN
   - `addTrack()` for video + audio from broadcast stream
   - `createOffer()` → `setLocalDescription()` → send SDP via relay
   
4. **WebRTC Signaling** (`receberRtc()`, `rtcParaViewer()`) — Relay passes envelope
   - Offer/answer/ICE candidates travel opaque through relay
   - Server never opens: it just routes via peerId
   
5. **Viewer Answers** (`client/src/main.js` WebRTC side) — Answer + ICE
   - Peer receives SDP, calls `setRemoteDescription()`
   - ICE candidates added as they arrive
   
6. **Connection Established** (`connectionstatechange`) — First frames via P2P
   - Broadcaster sends directly over SRTP/UDP
   - Viewer receives track, sets video element's srcObject or renders to canvas
   - Viewer sends `rtc-ativo: { on: true, slot: X }` to relay
   
7. **Relay Gating** (`server/rooms.js:atualizarChunks()`) — Decision to keep/drop relay
   - If all viewers of this slot are on P2P or P2P-only, set `chunks: { on: false }`
   - Broadcaster receives, sets `enviarChunks=false`, stops sending chunks to relay
   - CPU/bandwidth saved on uplink
   
8. **Fallback** (`rtc-ativo: { on: false, motivo: '...' }`) — Back to relay
   - Connection failed or closed, viewer returns to relay
   - Relay sends urgent keyframe request
   - Relay re-enabled: `chunks: { on: true }`

### Audio Stream

Audio follows the same relay path as video:
- Broadcaster: `pumpAudio()` feeds AudioEncoder
- Encoder produces Opus 96kbps mono/stereo
- Chunks sent as type=3 (AUDIO)
- No keyframe needed: each Opus packet is self-contained
- Viewer: passed through to same player, or from WebRTC track (if P2P)

## Key Abstractions

**Broadcaster Entry** (in-memory):
- Purpose: Track state of one person's one stream (screen OR camera, not both simultaneously)
- Examples: `server/rooms.js:attachBroadcaster()`, `broadcastersOf()`, `room.broadcasters` Map
- Pattern: Keyed by `"${userId}|${fonte}"`, holds `{ ws, info, slot, streaming, config, traffic, … }`

**Viewer Entry** (in-memory):
- Purpose: Track which slots a viewer is watching, which are on P2P, which are ready (primed)
- Examples: `server/rooms.js:attachViewer()`, `room.viewers` Set
- Pattern: WebSocket with attached metadata: `__watching`, `__rtc`, `__primed`, `__peerId`

**Slot Multiplexing**:
- Purpose: Allow server to route chunks to correct broadcaster without parsing payload
- Examples: Byte 0 of every chunk, room.slots Map (slot→entry)
- Pattern: Linear allocation (freeSlot), 0–3 range, freed on broadcast end

**Config Guard**:
- Purpose: New viewers get decoder config before first frame
- Examples: `server/rooms.js:setConfig()`, `entry.config`, `v.__primed`
- Pattern: Config cached per broadcaster, sent to new viewers, tracked via primed set

**Keyframe Request Gate**:
- Purpose: Prevent flood of redundant keyframe requests
- Examples: `server/rooms.js:requestKeyframe()`, `entry.lastKeyframeAsk`
- Pattern: Max 1 keyframe request per second per stream, urgent flag overrides for fallback

**Jitter Buffer** (viewer-side):
- Purpose: Smooth playback despite irregular network delivery
- Examples: `client/src/player.js:fila[]`, `BUFFER_MS=80ms`, `AJUSTE_MS=2000ms`
- Pattern: Queue frames, display at capture time + 80ms buffer, auto-adjust if clock drifts

## Entry Points

**Broadcaster (Capture Page):**
- Location: `server/public/share.html`, `server/public/share.js`
- Triggers: User navigates to `/share.html?t=<shareUrl>`
- Responsibilities: 
  - Import broadcaster module
  - Manage UI (quality slider, start/stop, screen picker)
  - Handle WebSocket connection via token in query param
  - Report stats and codec info

**Broadcaster (Activity Iframe inside Discord):**
- Location: `client/src/main.js` (lines ~600+)
- Triggers: User clicks "Share Screen" in Activity
- Responsibilities: 
  - Load broadcaster module
  - Open WebSocket to relay (via `/ws` with token)
  - Open control channel (separate connection, mode=controle)
  - Manage broadcast UI alongside viewer grid
  - Fallback to camera if desktop share not permitted

**Viewer (Activity Iframe):**
- Location: `client/src/main.js`
- Triggers: User opens Activity or navigates to lobby
- Responsibilities:
  - Open WebSocket viewer connection
  - Render grid or stage based on stream state
  - Handle watch/unwatch
  - Manage WebRTC peer negotiation (viewer-side answer)

**Viewer (Website):**
- Location: `client/dist/index.html` served by `/`
- Triggers: User navigates to website or opens shared link
- Responsibilities: Same as Activity viewer, but outside Discord

**Admin Dashboard:**
- Location: `/admin`, served by `buildAdminDashboard()` in `server/admin.js`
- Triggers: Admin user logs in via OAuth
- Responsibilities: Metrics, room list, traffic graphs

## Architectural Constraints

- **Threading:** Single-threaded event loop. No worker threads. Broadcaster runs on main thread with backpressure hysteresis to prevent UI blocking.
- **Global state:** 
  - `rooms` Map in `server/rooms.js` — all rooms in this instance
  - `peers` Map per broadcaster — tracks RTCPeerConnection objects
  - Per-viewer `__watching`, `__primed`, `__rtc` sets — mutable
  - Per-broadcaster `enviarChunks` flag — controls relay gating
- **Circular imports:** None detected. Shared modules (`broadcaster.js`, `rtc.js`) are pure utilities imported by both client and server.
- **No persistence:** Rooms exist only in RAM. Reboot = all rooms gone. Designed for ephemeral sessions (Discord call duration, ~minutes to hours).
- **No horizontal scaling:** Single-instance-only. Room IDs are base64-random but scoped to `instance` (Activity instance or "web" for site users). Multiple server instances see different instances and rooms.
- **Slot cap:** Max 4 broadcasters per room. No global queue; rejections are immediate.
- **Viewer cap per room:** Unlimited. No soft limit; only WebSocket backpressure prevents overload.

## Anti-Patterns

### One-Sender-to-All vs. Fan-Out Relay

**What happens:** Relay sends same bytes to all watching viewers. For 100 viewers, chunk of 100KB is sent 100 times down the same uplink. If relay is on a cheaper pipe than broadcaster, it becomes the bottleneck.

**Why it's wrong:** Bandwidth waste when viewers far outnumber broadcasters. Also, TCP ordering means late packets stall the entire playback for a viewer (vs. UDP which can drop).

**Do this instead:** P2P direct connection (`abrirPeer()`) is the optimization. Relay is the fallback. When all viewers can use P2P, set `enviarChunks=false` to disable relay and save bandwidth. If P2P is not working (NAT, firewall), relay is the safety net.

### Unbounded Queue + No Discard

**What happens:** Old code (hypothetical) would queue chunks until memory ran out or TCP buffer filled.

**Why it's wrong:** Atraso acumulado (accumulated delay) never recovers. A late chunk sits in queue forever.

**Do this instead:** `pushChunk()` checks `bufferedAmount` and drops if over threshold. Backpressure in encoder (`encodeQueueSize > 2`) discards frames, not bytes. Jitter buffer discards old frames if queue > 12.

### No Rhythm Grid, Bare Timestamps

**What happens:** If broadcaster just sent frames whenever encoder produced them, fps would vary wildly (28, 41, 30, 37 ms apart) due to OS scheduling jitter.

**Why it's wrong:** Even with constant bitrate, viewer sees micro-stutter because the natural rhythm of the capture is lost.

**Do this instead:** `encodeFrame()` maintains `proximaMarca` (next grid mark). Every frame is measured against the grid, not against the last frame. This restores the original capture rhythm even if the network reordered them.

### Activity Sandbox Isolation = No WebRTC

**What happens:** Discord's Activity iframe nullifies `RTCPeerConnection` property to block direct P2P.

**Why it's wrong:** Activity would be stuck on relay-only, paying latency tax.

**Do this instead:** `construtorPeer()` cascade: try `window.RTCPeerConnection`, then `webkitRTCPeerConnection` alias, then create hidden iframe with `contentWindow.RTCPeerConnection`. Each escape hatch has a cost; use the cheapest available.

## Error Handling

**Strategy:** Graceful degradation. P2P failure falls back to relay. Relay failure keeps trying. Entire broadcast stops only if explicitly stopped or socket closed.

**Patterns:**
- Encoder error → stop broadcast with message
- WebSocket close → stop broadcast, show "connection lost"
- WebRTC connection failure → continue on relay, log reason (timeout, NAT, sandbox)
- Decoder error → set `needKeyframe=true`, await next keyframe
- Backpressure → discard frame, don't queue
- Config reject → fall back to previous config (Broadcaster does this if level too high)

## Cross-Cutting Concerns

**Logging:** Console logs prefixed with `[room ${room.id}]` in server, plain `console.*` in browser. No centralized log sink. File system logging not implemented.

**Validation:** 
- Auth: Token signature + scope check (identity vs. broadcaster vs. viewer)
- Input: Slot number check, fonte check (FONTES.has), payload type check
- Size: maxPayload=4MB WebSocket, MAX_BUFFERED_BYTES=2MB relay, MAX_BUFFERED_BYTES×2 for keyframes
- Rate limiting: Password attempts (5 in 60s window), keyframe requests (1/s), ice.json caching

**Metrics:**
- Traffic counters per room, per broadcaster, per connection (bytes in/out/dropped)
- Latency: ping/pong on WebSocket every 15s
- Jitter: Player measures min/max folga over 2s window, adjusts base
- FPS: Broadcaster tracks frames input vs. output, stats reported every 1s

---

*Architecture analysis: 2026-08-20*
