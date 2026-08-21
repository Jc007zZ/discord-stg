# Stack Research

**Domain:** Browser-to-browser P2P tree distribution of a live WebRTC video track (peer-assisted delivery / application-level multicast), no SFU, no new media dependency
**Researched:** 2026-08-20
**Confidence:** MEDIUM-HIGH — API facts (spec/MDN/BCD/official samples) are HIGH confidence; the architectural verdict on Q1 is a synthesis across multiple independent sources (no single canonical sentence found) and is flagged accordingly.

## The one finding that changes the roadmap

PROJECT.md's central untested assumption is:

> "Um espectador consegue repassar a faixa recebida para uma nova RTCPeerConnection via `addTrack`, **sem decodificar e sem recodificar**."

**This premise is very likely false as stated, with MEDIUM-HIGH confidence.** Forwarding *does* work — it is not blocked, and it is demonstrated in Google's own official WebRTC samples repo (see Q1 below) — but it is not RTP passthrough. Browsers do not expose a "relay without touching the bits" mode through the standard `MediaStreamTrack` + `addTrack()` API. What actually happens on the forwarder:

1. `RTCRtpReceiver` de-packetizes and **decodes** the incoming RTP into a `MediaStreamTrack`, which the spec and every browser implementation model as a *decoded* frame source (`VideoFrame`s), not a compressed bitstream.
2. When that same track object is passed to `pcNew.addTrack(track)` on a second `RTCPeerConnection`, the browser's internal encoder **re-encodes** those decoded frames to produce a fresh, independent H.264 (or whatever codec was negotiated) bitstream for the downstream peer.

This is not a guess — it is the entire reason Selective Forwarding Units exist as a separate architectural category: "the SFU forwards streams to subscribers without decoding or re-encoding them, it reads RTP packet headers... and sends the packet" — explicitly contrasted against browser/mesh peers, which cannot do this. No browser vendor documentation (MDN, W3C `webrtc-pc`, `webrtc-encoded-transform`) describes a way to move a track between two `RTCPeerConnection`s without going through this decode/encode boundary. The very existence of the Encoded Transform API (Q2) — whose entire purpose is to expose frames "after the encoder, before the packetizer" and "after de-packetization, before the decoder" — is further indirect confirmation: if `addTrack` forwarding didn't decode/encode, there would be no reason for an API whose value proposition is "touch the bits without decoding them."

**What this means for the roadmap — and why it is not fatal:**
- The tree topology (R3/R4) still *works functionally*. This is proven, not theoretical: Google's official `webrtc/samples` repo ships a demo (`content/peerconnection/multiple-relay`) that does exactly this — chain `N` `RTCPeerConnection` pairs, each one forwarding the previous hop's received track into a new one, with a button literally labelled "Insert relay." Video plays through the chain.
- The real question shifts from *"is this possible"* (yes) to *"is the decode+re-encode CPU/quality/latency cost per hop acceptable at K=3–4, depth≤2, ~10–20 viewers, on ordinary laptops"* — a quantitative question, answerable only with a spike that measures CPU%, added glass-to-glass latency, and visual quality after one re-encode generation, on a representative forwarder device. **This should be the first thing built in the tree phase**, exactly as PROJECT.md already flags it, but the spike should measure *cost*, not test *possibility*.
- One genuine silver lining: because each hop re-encodes independently, **PLI/keyframe recovery is self-healing per hop** — a downstream viewer's PLI is served by the forwarder's own re-encoder producing a fresh keyframe from its already-decoded frames, without needing to signal all the way back to the original broadcaster. You get this for free specifically *because* of the re-encode, not despite it. (Caveat below: there is a known open libwebrtc issue about H.264 encoders not always honoring PLI promptly — test this explicitly, don't assume.)
- Simulcast and RTX do not "pass through" a hop either, for the same reason: each `RTCPeerConnection` negotiates its own independent RTX/SSRC per hop. This project doesn't use simulcast (single H.264 config per `shared/broadcaster.js`), so that particular gap is moot; RTX still works per-hop, independently, because it's renegotiated fresh in each hop's own SDP.
- The forwarder does **not** get to reuse its app-level WebCodecs `VideoEncoder` config for the re-encode — that encoder only ever ran on the original broadcaster's `pump()`. The re-encode on the forwarder is done by the browser's **internal** RTCRtpSender encoder, which you can only steer via `RTCRtpSender.setParameters()` (`maxBitrate`, `scaleResolutionDownBy`), not via WebCodecs. This is the practical hook for R2's "leque derivado de capacidade medida": constrain the forwarder's outgoing bitrate to what the child's measured capacity can take.

## Q1 — Evidence trail (cite-by-cite)

| Claim | Evidence | Confidence |
|---|---|---|
| `addTrack()` forwarding of a received remote track to a new `RTCPeerConnection` is a real, working, documented pattern | Google's official `webrtc/samples`: `src/content/peerconnection/multiple-relay/` + shared `src/js/videopipe.js` (`VideoPipe(stream, handler)` — opens `pc1`/`pc2`, `pc1.addTrack(track, stream)`, `pc2.ontrack` fires with the forwarded track; `main.js`'s `insertRelay()` explicitly chains a new `VideoPipe` fed with the *previously forwarded* `remoteStream`, i.e., a relay chain of arbitrary depth) | HIGH — primary source, official Google WebRTC samples repo |
| Forwarding via `addTrack` requires decode+re-encode, not RTP passthrough | Convergent explanation across SFU-vs-mesh literature (antmedia.io, forasoft.com, meetrix.io, red5.net) all state the *SFU's* differentiator is precisely "forwards without decode/re-encode" — implying non-SFU (peer) forwarding does decode/re-encode; corroborated by the `MediaStreamTrack`/`VideoFrame` architecture docs (Chrome for Developers WebCodecs guide, Mozilla's "Unbundling MediaStreamTrackProcessor" post) describing the receiver pipeline as producing decoded `VideoFrame`s, and by the Encoded Transform explainer's stated purpose (access frames "after encoder, before packetizer") | MEDIUM-HIGH — no single canonical spec sentence found stating this outright; conclusion is a synthesis across several independent, mutually-reinforcing industry/vendor sources, not one authoritative document |
| PLI/keyframe requests on a forwarded hop are handled locally by the forwarder's own re-encoder | Standard WebRTC behavior (RTCP PLI/FIR received by an `RTCRtpSender` triggers that sender's own encoder to insert a keyframe); BlogGeek.me PLI glossary confirms the general mechanism | MEDIUM — mechanism is well established for direct sends; not verified specifically in a chained/forwarded topology by an independent test, so treat as "should work, verify empirically" |
| A specific H.264-encoder-doesn't-always-honor-PLI bug exists in the libwebrtc/Chromium tracker | `issues.webrtc.org/issues/42220637` ("H264 encoder does not send key frame on receipt of PLI...") — title found via search, full bug body was not retrievable through available tools (sign-in gated) | LOW on specifics (status/root cause/fix version unknown) — HIGH confidence the issue *exists* (title is a direct search hit on the official tracker). **Treat as: budget explicit test coverage for "does a keyframe reliably arrive within N ms of a new child joining a forwarder," don't assume it from spec text alone.** |
| Simulcast/RTX do not carry through a forwarding hop | Inferred from architecture: each `RTCPeerConnection` negotiates SDP (and therefore RTX/SSRC/simulcast `rid`s) independently; no API exists to "clone" a receiver's RTX state onto a new sender | MEDIUM — architectural inference, not directly sourced from a bug report or spec statement, but consistent with how every other part of the negotiated media pipeline works |

## Recommended Stack (browser primitives — no new npm dependency)

### Core Technologies

| Technology | Version / availability | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `RTCPeerConnection.addTrack()` with the track from an `ontrack` event | Universal (all evergreen browsers) | Forward a received track to a new downstream peer (R3) | Only mechanism that exists in the browser for this; proven pattern via official samples (Q1). Accept the decode/re-encode cost as a known, bounded tradeoff, not a blocker. |
| `RTCRtpSender.setParameters()` (`encodings[0].maxBitrate`, `scaleResolutionDownBy`) | Universal | Cap the forwarder's re-encode bitrate/resolution to what a child's measured capacity supports | This is the *only* lever a forwarder has over its own outgoing quality, since it doesn't own a WebCodecs `VideoEncoder` for the forwarded hop (that only exists on the original broadcaster). Feeds R2's capacity-derived fan-out directly. |
| `RTCPeerConnection.getStats()` — `candidate-pair` type, field `availableOutgoingBitrate` | Chrome/Edge/Opera/Chromium WebView: yes. Firefox/Safari: **undefined**, not implemented | Primary uplink-capacity signal (R2) | Directly measures what GCC (Google's congestion controller) believes the path can carry; this is the "measured, not chutada" number R2 asks for — but only on Chromium. |
| `RTCPeerConnection.getStats()` — `outbound-rtp` type, fields `qualityLimitationReason`, `targetBitrate`, `bytesSent` | `qualityLimitationReason`: Chrome reliable, Firefox/Safari fail. `bytesSent`/`targetBitrate`: universal | Corroborating/fallback capacity signal, works everywhere via self-computed throughput | `qualityLimitationReason === 'bandwidth'` is a clean boolean "I am congested" trigger for R2's shrink logic, Chromium-only. `bytesSent` delta over a rolling window is a universal (if lagging) throughput estimate for the Firefox/Safari fallback path. |
| `RTCPeerConnection.getStats()` — `candidate-pair.currentRoundTripTime` | Universal | Primary RTT signal (R5/R6) | Available as soon as ICE connects, independent of whether media/RTCP is even flowing yet — matters for fast `escolherPai` decisions before a keyframe has arrived. |
| `RTCPeerConnection.getStats()` — `remote-inbound-rtp.roundTripTime` | Universal, but only populated once RTCP SR/RR is exchanged on that SSRC | Secondary/corroborating RTT signal, closer to the actual media path | Use to refine, not replace, `currentRoundTripTime`; only trust once media is flowing. |
| `navigator.connection` (Network Information API): `effectiveType`, `saveData`, `type`, `downlink`, `rtt` | Chrome/Edge/Opera/Chromium Android WebView only (`effectiveType`/`saveData` since Chrome 61/65). Firefox: removed support years ago. Safari: never implemented (WebKit bug 185697, still open) | Soft/advisory pre-filter for "refuse to promote this viewer to forwarder" (R5's hard cuts) | Matches R5's explicit "celular" hard cut when present. Must be treated as **advisory-only**: undefined on Firefox/Safari, and even where present it's a coarse heuristic bucket over recent browsing history, not a live measurement of this WebRTC session. The real safety net for capacity is always the measured `availableOutgoingBitrate`/throughput above, which works regardless of `navigator.connection` availability. |

### Explicitly NOT recommended for this milestone

| Considered | Why not |
|---|---|
| `RTCRtpScriptTransform` / Encoded Transform as the forwarding primitive (Q2) | Does not let you skip having a real encoder on the sender side. It only exposes already-encoded frames *after* your own encoder ran (sender side) or *before* your own decoder runs (receiver side) — it cannot substitute for the encoder itself. There is a known, undocumented technique of feeding a near-null "carrier" track into `addTrack` purely to get an `RTCRtpSender` pipeline running, then fully replacing `encodedFrame.data` in the transform with externally-sourced bytes (from the upstream receiver's own encoded transform) to achieve genuine bit-exact passthrough without a real encode. This is technically closer to "no decode/no re-encode," but it is unsupported/unspecified browser behavior (rate-control feedback, RTP timestamp continuity, and SSRC bookkeeping all assume the bytes came from the browser's own encoder), fragile across Chromium versions, and directly conflicts with the project's "no new dependência de mídia" / dependency-light constraint by requiring bespoke low-level plumbing. **Do not build this for v1.** If the Q1 spike shows the decode/re-encode cost is genuinely unacceptable at target scale, revisit this as an isolated, clearly-flagged research spike — not a roadmap phase. |
| Any SFU (mediasoup, LiveKit, Janus, ion-sfu) | Already excluded in PROJECT.md's Out of Scope, and this research corroborates why: an SFU's only advantage over the tree is exactly the decode/re-encode avoidance described above — but an SFU is a *server* process, so that bandwidth is still server egress, same problem that motivated this milestone. |
| `p2p-media-loader` / WebTorrent-over-DataChannel-style segment sharing | Assumes an HLS/DASH **segmented** delivery model (peers trade byte-range chunks of `.ts`/`.m4s` files over `RTCDataChannel`, tracker-style). This project has no segments — WebCodecs pumps individual encoded chunks directly over RTP/WebSocket in a continuous low-latency stream. Adopting it would mean re-architecting the entire capture/encode/deliver pipeline around chunked file-like segments, which contradicts both the low-latency design and the "no new media dependency" constraint. Not a fit — do not adopt. |
| `navigator.connection` as the sole/authoritative capacity gate | Chromium-only, heuristic, and not scoped to this connection. Use only as a hard pre-filter for the "celular" case (R5), never as the source of truth for fan-out sizing — that's `getStats()`'s job. |

## Q2 — Encoded Transform: what it costs, why it's not the answer here

- **Architecture:** `RTCRtpScriptTransform` runs your transform code in a dedicated Worker thread, off the main thread, which is a genuine cost *benefit* (doesn't block `requestAnimationFrame`/UI). Frames (`RTCEncodedVideoFrame`) are moved via the Streams API (`readable`/`writable`), which the spec designs around transferable buffers rather than full copies — so the message-passing overhead per frame is small, not a full serialize/copy.
- **What it does NOT do:** it does not reduce codec CPU cost. The encoder and decoder still run in full; the transform only gets a hook on the compressed bytes *between* those stages and the network. It is not a way to "skip" decode or encode.
- **Browser support (now good, worth knowing for other uses):** per MDN's Browser Compatibility Data, `RTCRtpScriptTransform` is Baseline since October 2025 — Chrome 141+, Firefox 117+ (shipped *before* Chrome), Safari 15.4+. If the project ever needs E2E encryption or per-frame instrumentation (e.g., "did this forwarder actually receive a keyframe" telemetry for R9's admin panel), this API is now solid to reach for — just not as the forwarding primitive itself.
- **Verdict:** not adopted for v1. Revisit only as a targeted spike if the Q1 CPU/quality spike shows the plain `addTrack` re-encode cost is unacceptable.

## Q3 — Measuring uplink capacity in 2026

Recommended read path, in priority order, polled on the same ~2–3s cadence the codebase already uses for jitter/backpressure decisions (`client/src/player.js` already measures jitter every 2s — reuse that rhythm, don't invent a new one):

1. `getStats()` → find the `transport` stat → `selectedCandidatePairId` → look up that `candidate-pair` stat → read `availableOutgoingBitrate`. **Chromium only**; `undefined` on Firefox/Safari and briefly `undefined` right after connect (needs ~1s of real traffic before GCC populates it).
2. Corroborate with `outbound-rtp.qualityLimitationReason === 'bandwidth'` (Chromium only) as a boolean "back off now" trigger, independent of the exact bitrate number.
3. Universal fallback (needed for any Firefox/Safari forwarder): self-compute achieved throughput from `outbound-rtp.bytesSent` delta over the same polling window. This tells you what you *did* send, not what you *could* send — treat it as a floor, not a ceiling, and combine with `remote-inbound-rtp.packetsLost`/`fractionLost` from the child as the actual shrink trigger per R2 ("encolhe quando as estatísticas do filho mostram perda").
4. Apply the project's existing hysteresis philosophy (already a Key Decision for the encoder's backpressure) to whichever signal you use — do not react to a single sample; smooth over 2–3 windows before growing or shrinking fan-out.

**Reliability caveat to build into the design, not discover in production:** because the Discord Activity iframe always runs the embedded Chromium (per `construtorPeer()`'s escape-hatch cascade in `shared/rtc.js`), Activity-side forwarders will reliably have `availableOutgoingBitrate`. The **standalone website** is where Firefox/Safari forwarders are possible — that code path must degrade to the `bytesSent`-based fallback and a more conservative default fan-out cap, since it has strictly less visibility into real capacity.

## Q4 — Real RTT

- `candidate-pair.currentRoundTripTime`: STUN-based, comes from ICE connectivity/consent-freshness checks (RFC 8445/8489), available as soon as the pair is nominated — **before** any media or RTCP has flowed. Universal across browsers. This is what should drive `escolherPai`'s initial RTT-band cut, since it's available immediately on connect.
- `remote-inbound-rtp.roundTripTime`: derived from RTCP Sender/Receiver Report NTP timestamps (the classic RTT-via-DLSR calculation), only populated once RTCP is actually being exchanged on that SSRC (i.e., after media starts flowing with feedback enabled). Reflects the actual media path more directly than the ICE-level number, but arrives later and updates on RTCP's own cadence (roughly ~1s intervals for active video, per the W3C stats spec discussion).
- Both are coarse, smoothed values (not millisecond-precise instantaneous samples) — the W3C `webrtc-stats` issue tracker itself flags that developers should prefer the interval-averaged `totalRoundTripTime`/`roundTripTimeMeasurements` fields over the instantaneous `currentRoundTripTime`/`roundTripTime` if smoothing matters. Given R5's design of RTT *bands* (not exact numbers) feeding a weighted score, this coarseness is a non-issue — bucket into bands, don't chase precision.
- **Recommendation:** use `candidate-pair.currentRoundTripTime` as the primary signal for `escolherPai` (available fastest, universal), refine with `remote-inbound-rtp.roundTripTime` once media is flowing for R6's post-connect correction pass.

## Q5 — Client-side signals to refuse promoting a viewer to forwarder

| Signal | Support (2026) | Reliability | Use |
|---|---|---|---|
| `navigator.connection.type === 'cellular'` | Chromium desktop: `type` mostly ChromeOS-only (`partial_implementation`); Chromium Android: broader support. Firefox: removed. Safari: never shipped. | Low reliability even where present — patchy platform coverage | Best-effort hard cut per R5, but cannot be the *only* gate (absent on the majority of desktop browsers) |
| `navigator.connection.effectiveType` (`slow-2g`/`2g`/`3g`/`4g`) | Chrome 61+/Android 38+, Edge/Opera (Chromium-based) mirror. Firefox: removed. Safari: never shipped | Heuristic bucket over recent connection history, not this-session-specific; Chrome docs itself frames it as approximate | Soft signal only |
| `navigator.connection.saveData` | Chrome 65+ and Chromium family. Firefox/Safari: no | User-declared preference (Data Saver mode), reliable *when present* since it reflects explicit user intent, not a measurement | Reasonable hard cut when true and available — respects explicit user intent to avoid extra data usage |
| `navigator.connection.downlink`/`rtt` | Chrome family only; Chrome caps `downlink` at 10 Mbps and `rtt` at 3000 ms as an explicit anti-fingerprinting measure | Capped/coarsened by design, not a real measurement | Not useful for capacity sizing (use `getStats()` for that); at most a very soft pre-filter |

**Net recommendation:** feature-detect `navigator.connection` and, where present, use `saveData === true` or `type === 'cellular'` as an explicit hard "never promote" cut (matches R5's "celular" cut directly). Where the API is absent (Firefox, Safari, and a meaningful share of Chromium configurations for `type`), the gate simply doesn't fire — fall through to the measured-capacity check from Q3, which is browser-agnostic in its fallback form and is the real safety net regardless of platform.

## Q6 — Existing open-source libraries for browser P2P tree/mesh media CDN

| Library | Status (2026) | Model | Fit for this project |
|---|---|---|---|
| `p2p-media-loader` (Novage/Chocobozzz forks; also on npm as `p2p-media-loader-*`) | Actively maintained, recent npm releases seen as of Aug 2026 | HLS/DASH **segment** sharing over `RTCDataChannel`, BitTorrent-style, integrates with hls.js/dash.js/Shaka | No fit. Assumes chunked HTTP-segment VOD/live delivery; this project streams individual WebCodecs-encoded frames directly, with no segment files. Would require replacing the entire delivery pipeline. |
| Peer5 | Historically a commercial P2P-CDN for HLS, same segment-sharing model as p2p-media-loader | Segment-based | Same fit problem as above; also unclear if still an independently operating product as of 2026 — treat any reference to it as historical, verify before considering. |
| Hive Streaming (now under Vimeo) | Alive as an enterprise product | Closed-source enterprise agent-based caching for corporate video (SCCM/BranchCache-adjacent), not a browser JS library | Not usable as an OSS dependency; wrong problem shape (enterprise IT LAN caching vs. public internet WebRTC viewers) |
| Genet / `webrtc-tree-overlay` (academic, Lavoie et al., IEEE/arXiv 1904.11402) | Last active ~2019, not maintained | Fat-tree WebRTC **DataChannel** overlay for volunteer *compute* task distribution, not continuous media | Not usable as a dependency (unmaintained, wrong payload type — data channels + compute results, not live video tracks). Useful only as a conceptual reference for tree-formation/routing ideas, already superseded in scope by this project's much simpler "server owns the tree, depth ≤ 2" design. |
| PeerJS / simple-peer | Alive, generic WebRTC signaling/wrapper libraries | Generic 1:1 peer wrapper, no tree/CDN semantics | Redundant — `shared/rtc.js` already owns the Discord-sandbox escape hatch and this project's own signaling protocol; adopting a generic wrapper adds a dependency for no capability gained, and conflicts with "sem dependência nova de mídia." |

**Conclusion: no existing library fits "WebCodecs-encoded live track + one-hop server-owned relay tree."** This validates, rather than contradicts, the project's existing Out of Scope decision to build the tree directly on `RTCPeerConnection` + the existing WebSocket signaling. Do not add a dependency here — continue building `escolherPai` and the server-owned topology state in-house exactly as scoped.

## Stack Patterns by Variant

**If forwarder is inside the Discord Activity iframe (always Chromium/Electron, via `construtorPeer()`'s escape hatch):**
- Full stats available: `availableOutgoingBitrate`, `qualityLimitationReason`, `navigator.connection`.
- Use the Chromium-only fast path throughout: measured capacity + hard network-type cut.

**If forwarder is on the standalone website and happens to be Firefox or Safari:**
- No `availableOutgoingBitrate`, no `qualityLimitationReason`, no `navigator.connection`.
- Fall back to self-computed throughput (`bytesSent` delta) + `remote-inbound-rtp` packet loss as the shrink trigger + a conservative fixed default fan-out cap as the floor (the "chutada" constant R2 wants to avoid relying on for Chromium is an acceptable safety floor specifically for this minority, lower-visibility case).

**Given the project's fixed depth cap of 2 (Out of Scope: "Árvore de profundidade arbitrária"):**
- The self-healing per-hop PLI/keyframe behavior (Q1) is sufficient on its own; there is no need to build any mechanism for propagating a keyframe request more than one hop, which would be a meaningfully harder problem at greater depth.

## Version Compatibility

| Package/API | Compatible With | Notes |
|---|---|---|
| `RTCRtpScriptTransform` | Chrome 141+, Firefox 117+, Safari 15.4+ | Baseline since Oct 2025 per MDN BCD. Not adopted for forwarding in v1 (see Q2); noted for future use (E2E encryption, per-frame telemetry). |
| `navigator.connection` (`effectiveType`/`saveData`) | Chrome 61+/65+ (desktop), Chrome Android 38+/mirror | No Firefox (removed), no Safari (never shipped, WebKit bug 185697 still open as of this research) |
| `candidate-pair.availableOutgoingBitrate` | Chrome/Edge/Opera/Chromium WebView | Firefox: confirmed not populated in community reports cross-checked against MDN's "not Baseline" framing; treat as always-undefined there |
| Node 22 / Express 4 / `ws` 8 / Vite 6 / Vitest 4 (existing stack) | Unaffected | No new npm dependency required by anything in this document — everything recommended is a native browser API already reachable through the existing `RTCPeerConnection` usage in `shared/rtc.js` |

## Sources

- `webrtc/samples` GitHub repo (official Google WebRTC samples): `src/content/peerconnection/multiple-relay/` and `src/js/videopipe.js` — fetched directly via `gh api`, read the actual source (`VideoPipe` class, `insertRelay()` chaining). HIGH confidence, primary source.
- MDN `RTCIceCandidatePairStats.availableOutgoingBitrate`, `RTCRtpScriptTransform`, `Network Information API`, `NetworkInformation.effectiveType`/`saveData` — HIGH confidence, official docs.
- `mdn/browser-compat-data` GitHub repo, raw JSON fetched directly for `api/NetworkInformation.json` and `api/RTCRtpScriptTransform.json` — HIGH confidence, primary compatibility data source, not summarized secondhand.
- W3C `webrtc-encoded-transform` explainer (`github.com/w3c/webrtc-encoded-transform/blob/main/explainer.md`) — HIGH confidence, spec-adjacent source.
- W3C `webrtc-stats` issue #523 (roundTripTime vs currentRoundTripTime naming/semantics discussion) — MEDIUM confidence, GitHub issue thread, not a resolved spec statement.
- `issues.webrtc.org/issues/42220637` (H.264 encoder + PLI) — LOW confidence on specifics (couldn't retrieve body), HIGH confidence the issue exists (direct tracker hit).
- Industry/vendor comparison articles on SFU vs mesh (antmedia.io, forasoft.com, meetrix.io, red5.net, getstream.io) — MEDIUM confidence, converging but non-primary sources, used to corroborate the decode/re-encode conclusion in Q1.
- `p2p-media-loader` (Novage/Chocobozzz GitHub + npm) — HIGH confidence for "what it is and does," MEDIUM confidence for "actively maintained in 2026" (inferred from recent npm publish dates, not a maintainer statement).
- Genet / `webrtc-tree-overlay` (arXiv 1904.11402, `github.com/elavoie/webrtc-tree-overlay`) — HIGH confidence for what it is, HIGH confidence it is unmaintained (no activity signal found post-2019).

---
*Stack research for: browser P2P tree distribution of live WebRTC video, no SFU*
*Researched: 2026-08-20*
