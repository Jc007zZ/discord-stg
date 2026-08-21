# Codebase Concerns

**Analysis Date:** 2026-08-20

## Tech Debt

### No Fan-Out Cap on WebRTC Peer Connections

**Issue:** Each viewer who starts watching a stream triggers a new WebRTC peer connection on the broadcaster's side. With N viewers, the broadcaster maintains N simultaneous RTCPeerConnection objects and must send video via each one. This is a direct multiplication of the broadcaster's uplink bandwidth usage.

**Files:**
- `server/rooms.js:841` — `watch()` sends `rtc-want` message to broadcaster for every viewer
- `shared/broadcaster.js:1034-1064` — `abrirPeer()` creates an RTCPeerConnection for each peer
- `shared/broadcaster.js:264` — `peers` Map stores all peer connections without a limit

**Impact:**
- When one person watches, the broadcaster's uplink carries that video twice (once for relay, once for direct)
- With 5 viewers, 5 peer connections exist even if only 1 viewer is actually receiving video via WebRTC
- Confirmed failure mode: "when one person watches, nobody else can connect" — broadcaster's uplink saturates

**Root Cause:** The relay's automatic fallback when WebRTC fails means every viewer request must open a peer attempt, even if it will fail. No connection pooling, no shared sending.

**Fix approach:** 
1. Cap concurrent WebRTC connections per broadcaster (suggested: 3-4)
2. Queue additional viewers to request WebRTC only after an existing peer closes
3. Reject new WebRTC attempts with "too many viewers" when at capacity
4. Alternatively: implement a single multicast-like peer that serves multiple viewers, though this requires significant architectural change

---

### P2P_ONLY Mode Disables Relay for EVERYONE

**Issue:** When `P2P_ONLY` environment variable is set to a truthy value, ALL viewers lose the relay fallback entirely. A viewer whose WebRTC never establishes sees an infinite "Conectando..." state with no timeout or error message.

**Files:**
- `server/index.js:42` — `SO_P2P` boolean derived from `P2P_ONLY` env var
- `server/index.js:964` — `soDireto` flag passed to `handleViewer()` includes SO_P2P
- `server/rooms.js:731` — `if (v.__soDireto) continue;` skips relay send entirely
- `server/index.js:1304-1308` — Warning printed at startup

**Impact:**
- Viewers with NAT traversal failures, symmetric NAT on both ends, or WebRTC unsupported in their browser see a blank screen forever
- No graceful degradation; no timeout; no error message
- Cannot distinguish between "still connecting" and "will never connect"
- Server-wide setting affects all rooms and all viewers with no per-connection override

**Current Behavior:** Currently on the `p2p-diagnostico` branch; this is a staging/testing mode. Production should have `P2P_ONLY=""` to keep relay enabled.

**Risk:** If accidentally deployed to production, entire application becomes unusable for viewers with NAT issues.

---

### Quality/FPS Settings UI Missing

**Issue:** Code exists to store and use custom bitrate and FPS settings (`AJUSTES_PADRAO` at `client/src/main.js:2087`), but no UI exists to edit them. Comment at line 2080 says "edited by the gear" but the gear icon has no handler.

**Files:**
- `client/src/main.js:2087` — `AJUSTES_PADRAO = { bitrate: 2500000, fps: 30 }`
- `client/src/main.js:2089-2095` — Settings loaded from localStorage
- `client/src/main.js:2105-2110` — `opcoesDaFonte()` builds URL params from settings
- No gear button or settings UI exists in the client codebase

**Impact:**
- Everyone transmits at exactly 2.5 Mbps / 30 fps
- No way for power users to optimize for slow connections or high-quality local sharing
- Settings are stored but unreachable, creating false impression of configurability
- The infrastructure is half-built (storage, read, apply) but the UI input path doesn't exist

**Fix approach:**
1. Add a settings modal or drawer to the top bar
2. Sliders for bitrate (500k – 8Mbps) and fps (15, 30, 60)
3. Save to localStorage on change
4. Apply immediately to broadcaster via `setQuality()` call
5. Document that changes only affect future transmissions (not the live one)

---

### Sidebar People-Count Chip Lost Its Hover List

**Issue:** The people-count chip in the sidebar (showing total count) has only a `title` attribute and no hover list. The list of people appears only when hovering over the #people chip at the top bar, not the sidebar chip.

**Files:**
- `client/src/main.js:461-472` — `contagemPessoas()` creates `.sidebar-count` with only `title` attribute
- `client/src/main.js:849-875` — `buildPeopleList()` returns the hover list HTML
- `client/src/main.js:886` — `buildPeopleList()` is only appended to `#people` pill (top bar)
- `client/src/style.css:555-556` — Hover rules only exist for `.pill:hover` and `.tile-watchers:hover`
- `client/src/style.css:149-177` — `.sidebar-count` has no hover styling defined

**Impact:**
- Users expect clicking/hovering the sidebar chip to show names like it did before
- Inconsistent UX: top bar chip shows list, sidebar chip doesn't
- Users must hover over the small icon at the top to see who's in the room while watching the main grid

**Fix approach:**
1. Create a hover-list in `contagemPessoas()` similar to `buildPeopleList()`
2. Add CSS hover rule for `.sidebar-count:hover .hover-list`
3. Ensure avatar images are included like the tile-watchers list

---

### Potential Video Element Playback Circular Dependency

**Issue:** The `<video>` element for WebRTC playback is created in `openStream()` but is NOT appended to the DOM until `noDe()` is called by `buildTile()`. The element only appears in the DOM when `s.viaRtc` is true. However, the loadeddata event listener is attached at line 1085 before the element is rendered, which could theoretically prevent the loadeddata event from firing on some browsers if media decoding pauses when the element is off-DOM.

**Files:**
- `client/src/main.js:924-965` — `openStream()` creates `<video>` element at line 931
- `client/src/main.js:192` — `noDe()` returns `s.video` only if `s.viaRtc` is true
- `client/src/main.js:520` — `buildTile()` appends `noDe(stream)` to DOM
- `client/src/main.js:1085` — `loadeddata` listener added while element is still off-DOM
- `client/src/main.js:1070-1072` — `srcObject` is set and `play()` called before element is in DOM

**Current Behavior:** Works in practice because the video element has `srcObject` set before the loadeddata listener is added, so it can begin receiving frames and playback even while off-DOM. Most browsers decode media for video elements not in the DOM.

**Actual Risk:** LOW. The current sequence is:
1. Create video element (off-DOM)
2. Set srcObject (media stream attached, browser can begin decoding)
3. Call play() (playback starts)
4. Add loadeddata listener
5. Append to tile when viaRtc becomes true (element now visible)

The element can fully decode while off-DOM. However, if browser behavior changes or if a fallback path is added that doesn't set srcObject early, this could break.

**Fix approach:**
1. Keep current sequence (works)
2. Add explicit comment about why the off-DOM order is safe
3. Consider appending element to DOM immediately (hidden) in `openStream()` to avoid future gotchas
4. Add defensive check: if loadeddata fires but element is off-DOM, log a warning

---

## Error Handling Issues

### Silent Failure on WebSocket Message Parse Errors

**Issue:** When viewers or broadcasters send malformed JSON, the error is caught and silently swallowed with an empty `return`. No logging, no error response sent to the client.

**Files:**
- `server/index.js:1035-1039` — Broadcaster message handler catches JSON parse errors silently
- `server/index.js:1080-1084` — Viewer message handler catches JSON parse errors silently

**Impact:**
- Malformed messages from buggy clients disappear without a trace
- Difficult to debug client-side issues that produce invalid JSON
- No way to know if a message was dropped due to parse error or was never sent

**Risk:** Medium. While the fallback to silent failure is reasonable (preventing one bad message from breaking the connection), the total lack of logging makes diagnosis hard.

**Fix approach:**
1. Log parse errors at warn level: `console.warn(`[room ${room.id}] parse error: ${err.message}`)`
2. Consider sending back an error only if the message looks like it was supposed to be JSON (e.g., starts with `{`)
3. Add a counter of parse errors per room for diagnostic endpoints

---

### No Timeout on WebRTC Negotiation Errors

**Issue:** If WebRTC offer/answer exchange fails partway (e.g., setRemoteDescription rejects), the error is caught and `desistirDoRtc()` is called. However, in some race conditions where the viewer has already timed out and moved back to relay, the peer connection might remain in `s.pc` without being properly closed.

**Files:**
- `client/src/main.js:1040-1095` — `receberOferta()` has try-catch that calls `desistirDoRtc()` on error
- `client/src/main.js:1166-1179` — `fecharPeer()` sets `s.viaRtc = false` and `s.pc = null`, but only on explicit close

**Current Behavior:** The timeout at line 1088-1090 ensures that if playback never starts, the viewer falls back to relay after `PRAZO_CONEXAO_MS` (from shared/rtc.js). So the risk is low in normal cases.

**Actual Risk:** LOW. The timeout mechanism is in place and working.

---

## Fragile Areas

### Room State Broadcast on Every Viewer Change

**Issue:** Every time a viewer connects, disconnects, or changes what they're watching, `broadcastState()` is called, which sends the full room state to ALL viewers and ALL broadcasters. With N viewers, M broadcasters, and high churn, this becomes O(N*M) messages.

**Files:**
- `server/rooms.js:547-551` — `broadcastState()` sends JSON-stringified room state to all viewers and broadcasters
- `server/rooms.js:642` — Called when broadcaster connects
- `server/rooms.js:844` — Called when viewer starts watching
- `server/rooms.js:852` — Called when viewer stops watching
- `server/rooms.js:973` — Called when viewer connects

**Impact:**
- High churn rooms (viewers dropping in and out) cause a flood of state messages
- Each message includes the full list of participants, all active streams, all watchers for each stream
- Scales linearly with room size for every single user action

**Risk:** Medium. This works fine for small rooms (< 20 people) but degrades noticeably at 50+ participants. Not a showstopper yet, but a known scaling limit.

**Optimization path:**
1. Implement delta updates: only send what changed
2. Debounce state broadcasts: collect changes over 50ms, send once
3. Separate notification types: viewer-joined (small message) vs full state (rare)

---

### Unbounded Viewer State Accumulation

**Issue:** When a viewer watches multiple streams, their `__watching`, `__primed`, `__rtc` Sets grow. When they unwatch, entries are deleted. However, if a broadcast ends while a viewer is watching it, the cleanup path needs verification.

**Files:**
- `server/rooms.js:822-845` — `watch()` adds to `__watching`, `__primed` is initialized
- `server/rooms.js:795-808` — `stopStream()` removes from `__watching`, `__primed`, `__rtc` for all viewers
- `server/rooms.js:947-974` — `attachViewer()` initializes Sets

**Current Behavior:** When a broadcast stops, `stopStream()` explicitly cleans up all viewers' state for that slot. This looks correct.

**Risk:** LOW. Cleanup is explicit and comprehensive.

---

### Password Attempt Array Not Bounded

**Issue:** Although `room.attempts` is filtered to remove old attempts (line 233), the array could theoretically grow unbounded if an attacker sends requests at exactly the ATTEMPT_WINDOW_MS interval, adding one entry per interval. With a 1000ms window, this could reach ~60 entries per minute per room.

**Files:**
- `server/rooms.js:233-234` — Filter removes attempts older than ATTEMPT_WINDOW_MS
- `server/rooms.js:234` — Push new attempt onto array
- `server/rooms.js:236-239` — Check length and lock out if >= MAX_ATTEMPTS

**Current Behavior:** The array is bounded implicitly by MAX_ATTEMPTS check at line 236. Once it reaches 5, the room is locked for 30s. During the lockout, new attempts don't get added (line 210 returns early).

**Risk:** LOW. The lockout prevents unbounded growth. The rate limit is already in place.

---

## Scaling Limits

### Maximum Concurrent Rooms Per Instance

**Issue:** Server caps rooms at MAX_ROOMS_PER_INSTANCE = 20 per instance. This is a hard limit enforced at room creation (line 271 in server/rooms.js).

**Files:**
- `server/rooms.js:33` — `MAX_ROOMS_PER_INSTANCE = 20`
- `server/rooms.js:270-272` — Error returned if limit is reached
- `server/rooms.js:425-456` — Sweep interval cleans up empty rooms every 4 seconds

**Current Capacity:**
- 20 open rooms per instance
- Each room can have up to 4 simultaneous broadcasters
- Each broadcast can have unlimited viewers (but WebRTC fan-out caps around 5)
- Total: ~20 concurrent broadcasts, but per-broadcaster uplink will saturate at ~3-5 viewers

**Scaling Path:**
- Horizontal: Run multiple instances, use load balancer to route by room ID
- Consider: Is 20 rooms/instance too high? Each room holds state in memory indefinitely until it empties

---

### Memory for Buffered Media Chunks

**Issue:** Each viewer has a socket with a `bufferedAmount` property that tracks outgoing data. The relay holds chunks in memory until they're sent. With large bitrates and slow connections, buffers can grow.

**Files:**
- `server/rooms.js:34` — `MAX_BUFFERED_BYTES = 2 * 1024 * 1024` (2 MB per viewer)
- `server/rooms.js:736-740` — Chunks dropped if buffer exceeds 2MB (for audio)
- `server/rooms.js:749-756` — Keyframes dropped if buffer exceeds 4MB
- `server/rooms.js:767-780` — Deltas dropped if buffer exceeds 2MB

**Current Behavior:** Backpressure is implemented: chunks are dropped rather than queued infinitely. This prevents memory explosion.

**Risk:** LOW. Backpressure mechanism is in place and tuned.

---

## Testing & Coverage Gaps

### No Test Coverage for WebRTC Fan-Out Behavior

**Issue:** The critical path where N viewers create N peer connections is not tested. No test verifies that adding the 6th viewer fails or is queued.

**Files:**
- `shared/broadcaster.test.js` — Tests the broadcaster module
- No test for `abrirPeer()` accepting/rejecting based on count

**Risk:** HIGH. The fan-out problem could silently get worse if refactored.

**Priority:** Add test to `shared/broadcaster.test.js`:
```javascript
test('abrirPeer should reject after N concurrent connections', async () => {
  // Open 5 peers, verify 6th is rejected or queued
});
```

---

### P2P_ONLY Mode Not Tested in CI

**Issue:** The SO_P2P code path has no automated test. The warning at line 1304 exists to catch accidental deployment, but no test validates the behavior.

**Files:**
- `server/index.test.js` — No test for SO_P2P branch
- `server/index.js:1304-1308` — Warning only

**Risk:** MEDIUM. Regression could go unnoticed.

---

### No Integration Test for Zero-Viewer Bandwidth Cutoff

**Issue:** The `atualizarChunks()` and `enviarChunks` mechanism that stops relaying when all viewers are on direct connections is not tested.

**Files:**
- `server/rooms.js:926-939` — `atualizarChunks()` logic
- `shared/broadcaster.js:768` — `if (!enviarChunks && configEnviada)`

**Risk:** MEDIUM. If someone refactors the relay startup/shutdown, this could silently break.

---

## Security Considerations

### Password Hashing Using Scrypt with Random Salt

**Issue:** Passwords are hashed with scrypt and a random salt for each room (line 199-200). This is correct.

**Files:**
- `server/rooms.js:198-200` — `hashPassword()` uses crypto.scryptSync()
- `server/rooms.js:202-206` — `passwordMatches()` uses timingSafeEqual()

**Current Mitigation:** Strong. Scrypt is expensive, random salt per room, timing-safe comparison.

**Risk:** LOW.

---

### No Rate Limit on /api/token (OAuth Token Exchange)

**Issue:** The `/api/token` endpoint (line 186-239) that exchanges a Discord OAuth code for an access token has no rate limiting. An attacker could send unlimited invalid codes.

**Files:**
- `server/index.js:186-239` — `/api/token` endpoint
- No rate limiter, no consecutive-request tracking

**Impact:**
- Brute-force attack on Discord OAuth codes (though codes are short-lived and can't be guessed)
- DoS attack to burn Discord API rate limit on your application's behalf

**Mitigation:** Discord's own rate limits on their OAuth endpoint provide some defense, but it's weak.

**Fix approach:** Add rate limiting per IP to this endpoint, e.g., 10 requests per minute per IP.

---

### Session Secret Validation

**Issue:** Session secret is validated for minimum length (32 chars) only when admin panel is enabled, not in production. But in production, lack of SESSION_SECRET causes hard error at startup (line 58-60).

**Files:**
- `server/index.js:58-84` — Secret validation

**Current Behavior:** Correct. Production startup fails if SESSION_SECRET is missing.

**Risk:** LOW.

---

## Deployment Concerns

### Production Divergence from Origin/Main

**Issue:** The `p2p-diagnostico` branch has several commits not on origin/main, including a recently added "Entra por uma das portas que sobraram abertas na atividade" (line 43f7810). The comment in the known issues list mentions that origin/main and locutor/main lack "the H.264 level fix, the zero-viewer bandwidth fix, and the WebRTC escape-hatch cascade."

**Current Branch:** `p2p-diagnostico`
**Main Branch:** Has H.264 fix (efaad8d), but check what else is missing.

**Files:** All changes are in the current branch vs main.

**Impact:** Unknown. Depends on what's staging vs production.

**Recommendation:** Clarify what each branch represents and whether staging/production are tracking the right branch.

---

## Missing Critical Features

### No Settings UI for Broadcast Quality

Already documented in "Quality/FPS Settings UI Missing" section above.

---

## Test Coverage

### Lines of Code Without Tests

**Files with no tests or minimal coverage:**
- `server/admin.js` — Administrative dashboard backend
- `server/system.js` — System metrics collection
- `client/src/audio.js` — Audio stream decoding
- Large portions of `shared/rtc.js` — WebRTC negotiation

**Priority:** Add tests for:
1. Audio config delivery and playback (audio.js)
2. WebRTC failure modes and fallback (rtc.js, main.js receberOferta)
3. Admin endpoints (admin.js)

---

*Concerns audit: 2026-08-20*
