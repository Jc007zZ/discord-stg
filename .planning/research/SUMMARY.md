# Project Research Summary

**Project:** Sala de Tela — distribuição P2P em árvore
**Domain:** Peer-assisted (tree) distribution of live WebRTC media in the browser
**Researched:** 2026-08-20
**Confidence:** MEDIUM-HIGH

## Executive Summary

**Lead finding, and it corrects a load-bearing assumption in the original design:
forwarding a received `MediaStreamTrack` to another `RTCPeerConnection` via
`addTrack` costs a full decode + re-encode.** There is no raw passthrough in the
browser. Two agents reached this independently; the strongest evidence is the
source of Google's own official `webrtc/samples` `multiple-relay` demo, read
directly. This is precisely why SFUs exist as a separate architectural category.

Forwarding still **works** — it is simply not free. Four consequences, and none of
them kills the tree:

1. **The bandwidth goal survives intact.** The broadcaster's uplink is still
   offloaded to forwarders exactly as designed; the GB/hour arithmetic that
   motivated this milestone does not change.
2. **Forwarder CPU becomes a second scarce resource, alongside uplink.** R2's
   "measured, never guessed" philosophy must now cover encode headroom, not just
   network capacity — on hardware the project does not control.
3. **There is generation loss.** A grandchild sees worse quality than a child.
4. **The problem believed hardest disappears.** Because the forwarder runs a real
   encoder, standard PLI recovery is self-healing per hop — a grandchild joining
   mid-stream gets its I-frame automatically, at zero protocol cost. The existing
   WebSocket keyframe request and the 3 s periodic cadence become defence in
   depth rather than the mechanism.

The rest of the research is confirmatory and unusually well aligned: the project's
existing decisions (server-owned topology, structural cycle prevention, relay as a
permanent layer underneath, hysteresis, pure-function parent selection) match
production practice, and in one case — the two-phase "hard gates then score"
selector — the design is *better* than the only published prior art in the domain.
**Implementation risk here is quantitative, not architectural**: the unknowns are
numbers nobody has measured for this stack, not questions of whether the shape is
right.

## Key Findings

### Recommended Stack

No new npm dependency. Everything needed is a native browser API already reachable
through the existing `RTCPeerConnection` usage in `shared/rtc.js`. Full detail in
[`STACK.md`](STACK.md).

**Core technologies:**

- `RTCPeerConnection.addTrack()` with the track from `ontrack` — the only
  forwarding mechanism the browser offers (R3). Accept decode/re-encode as a
  known, bounded cost.
- `RTCRtpSender.setParameters()` (`maxBitrate`, `scaleResolutionDownBy`) — the
  *only* lever a forwarder has over its own outgoing quality, since it owns no
  WebCodecs `VideoEncoder` for the forwarded hop. Feeds R2 directly.
- `getStats()` → `candidate-pair.availableOutgoingBitrate` — primary capacity
  signal. **Chromium only**; `undefined` on Firefox/Safari.
- `getStats()` → `outbound-rtp.qualityLimitationReason === 'bandwidth'` — clean
  boolean "back off now" trigger. Chromium only.
- `getStats()` → `outbound-rtp.bytesSent` delta + `remote-inbound-rtp.fractionLost`
  — universal fallback path, required for Firefox/Safari forwarders on the
  standalone website.
- `getStats()` → `candidate-pair.currentRoundTripTime` — primary RTT, available as
  soon as ICE nominates a pair, before any media flows. Refine later with
  `remote-inbound-rtp.roundTripTime`.
- `navigator.connection` (`saveData`, `type`) — advisory hard cut only, Chromium
  only, never the sole capacity gate.

**Explicitly rejected:** `RTCRtpScriptTransform` as the forwarding primitive (runs
*after* the encoder, cannot replace it); any SFU (server egress — the very problem
being solved); `p2p-media-loader` and kin (assume HLS/DASH segments, incompatible
with a continuous WebCodecs chunk pipeline).

### Expected Features

From [`FEATURES.md`](FEATURES.md). Every independent source agrees on four
non-negotiables, all of which the project had already decided on unprompted.

**Must have (table stakes):**
- Always-warm non-P2P fallback — R7
- Measured, not guessed, capacity — R2
- Server-owned single-parent topology — R4
- Structural (not algorithmic) loop prevention — R4
- Orphan adoption on parent departure — R4
- Keyframe on join — solved for free by per-hop PLI

**Should have (competitive):**
- Two-phase parent selection: hard gates, then weighted score — R5. No P2P-video
  system publishes such a design; the closest prior art is the Kubernetes
  filter-then-score scheduler. This is a genuine differentiator.
- Measurement-driven re-parenting with hysteresis — R6
- Operator-visible tree — R9. Unusually cheap here *because* R4 already requires
  the server to own topology; no commercial vendor publishes such a view.

**Defer (v2+):**
- Depth > 2 — the cost curve is all in depth
- Seamless (no-flicker) parent handover — explicitly out of scope
- TURN in production — instrument only (R11)

### Architecture Approach

Server owns the topology and is the single writer; clients never choose a parent.
Full detail in [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Major components:**
1. **Tree state store** (server) — node, parent, children, capacity, role. Depth
   is always *derived*, never accepted as input.
2. **`escolherPai()`** (server, pure function) — hard cuts, then weighted score.
   Testable against synthetic 10-node trees without opening a socket.
3. **`atribuirPai()`** (server, sole writer) — the only path that mutates the tree.
4. **Signalling router** (server) — today's `rtc-*` messages generalized to be
   peerId-indexed across *both* the viewer and broadcaster pools, so a forwarder
   can play the role today reserved for the origin.
5. **Forwarder runtime** (client) — accept-child + `addTrack`, reusing
   `shared/rtc.js` unchanged, **including `construtorPeer()`** — every new peer
   connection must go through the Discord Activity escape hatch or it breaks only
   inside the real Activity, silently.
6. **Viewer state machine** (client) — relay-only → negotiating → direct-from-root
   → direct-from-forwarder → orphaned → re-parented.

**New control messages** (naming follows the existing Portuguese `rtc-` convention):
`rtc-papel`, `rtc-pai`, `rtc-quer` (extends `rtc-want`), `rtc-recusa`,
`rtc-capacidade`, `rtc-medicao`, `rtc-orfao`, `rtc-reparentar`. `rtc`, `rtc-bye`
and `rtc-ativo` keep their shape and only change routing.

**The forwarder-departure sequence is the single most important piece of
sequencing in the design.** Same tick: restore relay gating for every orphan
*before* choosing any replacement; send `rtc-orfao`; request an urgent keyframe.
Only then, staggered with 150–300 ms jitter, re-parent. The asymmetry — fail open
to relay fast, fail back to P2P slowly — is what keeps a 10-person room from
visibly breaking when one forwarder leaves.

### Critical Pitfalls

Top five from [`PITFALLS.md`](PITFALLS.md) (10 documented).

1. **`availableOutgoingBitrate` is a lagging sender-side guess.** A new stream
   ramps from ~15% to 100% of target over ~30 s. Reading capacity right after a
   child connects and admitting a second on that basis is the classic overshoot.
   → Probation window before admitting an additional child; grow slowly, shrink
   immediately on any loss report.
2. **Per-connection estimates do not sum.** Chrome's GCC runs independently per
   `RTCPeerConnection` and cannot see sibling traffic on the same physical uplink.
   → Treat as a ceiling hint, never a budget to spend.
3. **NAT/ICE failure compounds multiplicatively with hops.** 10–22% of WebRTC
   sessions need TURN to connect at all (4–30% by geography). A depth-2 path
   succeeds at roughly p², not p — about 72% if each hop is 85%. *This is
   structural inference, not a measured statistic.* → The relay underneath is not
   optional, and the realistic share of viewers who end up on it in a tree is
   higher than in a star. This eats part of the saving.
4. **Full room-state broadcast on every viewer change.** `broadcastState()` is
   already O(N×M); a single forwarder departure triggers several reassignments,
   each a full broadcast to every socket. → The debounce is not optional cleanup;
   it becomes load-bearing the moment re-parenting exists.
5. **The Discord Activity escape hatch must be re-applied everywhere.** Any new
   `RTCPeerConnection` constructed outside `construtorPeer()` works everywhere
   except inside the real Activity — the worst possible failure signature.

Also material: **tree forwarding introduces new IP exposure.** In today's star
only the broadcaster sees a viewer's IP; in a tree, forwarders see their
children's. mDNS does not fix this (it only hides local candidates) and the
Discord Activity proxy does not either (HTTP only, not the ICE/UDP path).
**Product decision taken:** accept it, and record it in the terms/README — the
Hola/Luminati precedent shows the backlash trigger was undisclosed reuse
discovered by third parties, not the sharing itself.

## Implications for Roadmap

Granularity is `fine`. Suggested structure — dependency-driven, not one phase per
requirement:

### Phase 1: Spike de repasse
**Rationale:** the framing question changed from "is this possible?" to "what does
one hop cost?" — and nobody has measured it for this stack. Everything downstream
is sized by the answer.
**Delivers:** measured CPU%, added latency, and visual quality loss for one
decode+re-encode hop at 1080p30 H.264 on non-dev-tier hardware; measured
black-screen duration for a grandchild joining mid-stream; verification that the
H.264 encoder honours PLI promptly (`issues.webrtc.org/issues/42220637`).
**Addresses:** R3 feasibility and cost.
**Avoids:** Pitfall — budgeting forwarding as free.
**Decided contingency:** if the cost is too high, **only viewers with a hardware
encoder are promoted to forwarder**; others stay leaves or fall to the relay.

### Phase 2: Consertos de interface
**Rationale:** independent of topology, small, and the quality/fps gear is
*needed* to test measured capacity — without varying the bitrate there is nothing
to make capacity react to. Runs in parallel with Phase 1.
**Delivers:** R12 (gear for bitrate/fps on the site), R13 (people list back on the
sidebar hover).

### Phase 3: Higiene do plano de controle
**Rationale:** two known issues become load-bearing the moment re-parenting
exists; fixing them after would mean debugging churn on top of a known-bad base.
**Delivers:** `broadcastState()` debounce (Pitfall 4); R8 — `P2P_ONLY` stops
silently disabling the relay for everyone and becomes an explicit diagnostic mode.

### Phase 4: Estado da árvore + `escolherPai` boba
**Rationale:** pure data and a pure function, testable against synthetic 10-node
trees without a single socket. Also lands the cheap half of R1 (hard cut on a
configured K) with no measurement needed.
**Delivers:** tree state store, `atribuirPai()` as sole writer, `escolherPai()`
returning the first candidate with room, role-gated candidate query (structural
depth cap), R1 hard cut.
**Avoids:** Anti-pattern — a depth check bolted onto every call site.

### Phase 5: Protocolo de controle + roteador por peerId
**Rationale:** depends on Phase 4's data model existing to assign roles against.
**Delivers:** `rtc-papel`, `rtc-pai`, `rtc-quer`, `rtc-recusa`; signalling routing
generalized to peerId across both pools.
**Research flag:** must be verified inside the real Activity iframe on stg.

### Phase 6: Runtime do repassador
**Rationale:** first phase where media actually flows over a forwarded hop.
**Delivers:** R3 — accept-child + `addTrack` forwarding, reusing `shared/rtc.js`
and `construtorPeer()` unchanged.
**Avoids:** Pitfall 5 — escape hatch not re-applied.

### Phase 7: Espectador — órfão, re-paternização, convivência com o relay
**Rationale:** the survivability layer. Relay gating itself needs no changes; this
is mostly extending existing `rtc-ativo` handling.
**Delivers:** R7, viewer state machine, `rtc-orfao`/`rtc-reparentar`, the
same-tick relay restore and the staggered/jittered re-parent.
**Avoids:** Anti-patterns — waiting for a replacement before restoring relay;
dispatching all orphans in one tick.

### Phase 8: Medição — capacidade, RTT, perda
**Rationale:** needs live connections from Phase 7 to measure against.
**Delivers:** R2 (measured fan-out, uplink *and* CPU, with the Firefox/Safari
`bytesSent` fallback), R5 (weighted `escolherPai`), R6 (hysteresis re-parenting),
`rtc-capacidade`, `rtc-medicao`, probation window before admitting a second child.
**Research flag:** the probation-window duration is folklore (~30–45 s). Must be
established empirically against diverse network profiles and documented.

### Phase 9: Instrumentação
**Rationale:** the milestone's success criteria are numbers; without this there is
no way to close it.
**Delivers:** R10 (GB/hour per broadcast, % of viewers on a direct connection,
broadcaster peak uplink), R11 (how many pairs fail without TURN and what that
costs in relay bandwidth — measure, do not deploy).

### Phase 10: Visibilidade e registro
**Rationale:** a tree failure is unreadable without an operator view; and the IP
exposure decision needs to actually land somewhere.
**Delivers:** R9 (admin tree view — who parents whom, capacity, RTT, reason for
the last swap), plus the IP-exposure note in the terms/README.

### Phase Ordering Rationale

- **The spike is first and alone** because it can reshape Phases 6–8 and cannot be
  parallelized against work it might invalidate. Phase 2 is the only safe parallel
  companion — it touches no topology.
- **Control-plane hygiene precedes the tree** because both items are already known
  problems that churn amplifies; fixing them afterwards means debugging two things
  at once.
- **Pure logic before wire protocol before media** (4 → 5 → 6) follows the
  project's own stated reason for keeping parent selection a pure function: the
  hardest logic gets tested without any network at all.
- **Survivability before optimization** (7 before 8): a tree that re-parents well
  but chooses badly is merely suboptimal; one that chooses well but strands
  orphans is broken.
- **R1 and R2 are deliberately split** across phases — the hard cut on a
  configured K is cheap and lands in Phase 4; the measured, loss-reactive half
  needs Phase 8's live data.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** must measure; no bypass. The numbers do not exist anywhere.
- **Phase 5 and 6:** must be verified inside the real Discord Activity iframe on
  stg, not merely in a browser tab.
- **Phase 8:** probation window and hysteresis thresholds are folklore in every
  source consulted; no production system publishes them.

Phases with standard patterns (research-phase can be skipped):
- **Phase 2:** ordinary DOM/CSS work against an already-mapped codebase.
- **Phase 3:** debounce and an env-flag semantics change; both well understood.
- **Phase 4:** plain data structures and a pure function.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | MDN/BCD/spec read directly; the central Q1 claim rests on primary source (Google sample code) plus convergent synthesis |
| Features | MEDIUM-HIGH | Table stakes unanimous across commercial and academic sources; differentiator claims directional only — vendors keep internals opaque |
| Architecture | MEDIUM-HIGH | Component/protocol design derived from the working codebase (HIGH); browser media-forwarding physics cross-checked but partly inferential (MEDIUM) |
| Pitfalls | MEDIUM | NAT/TURN rates cross-checked across 3+ sources; latency-per-hop and mobile-cost have no primary measured data and are flagged as such |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **CPU, latency and quality cost of one re-encode hop** — no measured data exists
  for this stack. → Phase 1 spike. Hard blocker on finalizing depth 2.
- **Probation-window duration for GCC ramp-in** (~30–45 s is folklore) → establish
  empirically in Phase 8 and document the chosen threshold with its evidence.
- **Re-parenting hysteresis thresholds** — no source publishes concrete numbers.
  The closest prior art is this codebase's own encoder-backpressure hysteresis. →
  Phase 8.
- **H.264 encoders honouring PLI promptly** — open libwebrtc issue, body not
  retrievable (sign-in gated); only the title was confirmed. Since "PLI
  self-heals per hop" is now load-bearing, → explicit test coverage in Phase 1.
- **Viewer↔viewer vs viewer↔broadcaster NAT failure rates** — no study compares
  them. The compounding argument is inference. → Phase 9's R11 instrumentation
  turns this into measured data from real users.
- **Per-connection GCC behaviour under sibling load** — MDN confirms the estimate
  is per-candidate-pair, but the magnitude of the overestimate is unquantified. →
  Conservative "grow slowly, shrink fast" absorbs it without needing the number.

## Sources

### Primary (HIGH confidence)
- `webrtc/samples` — `multiple-relay` demo source, read directly — proves
  forwarding works and shows the mechanism
- MDN + Browser Compat Data — `RTCIceCandidatePairStats.availableOutgoingBitrate`,
  `RTCRtpScriptTransform`, `navigator.connection`, `RTCRtpSender.setParameters`
- W3C `webrtc-stats` spec and issue tracker — RTT field semantics, smoothing guidance
- This repository's own `.planning/codebase/` map — component boundaries and
  existing protocol

### Secondary (MEDIUM confidence)
- fybrrStream (arXiv:2105.07558) — the only published parent-selection formula in
  the domain; flat weighted sum, no gating phase
- WebRTC NAT/TURN failure-rate aggregates — 10–22% typical, 4–30% by geography,
  cross-checked across 3+ independent sources
- Hola/Luminati 2015 incident — corroborated across multiple independent outlets
- `issues.webrtc.org/issues/42220637` — H.264 PLI responsiveness; title confirmed,
  body not retrievable

### Tertiary (LOW confidence — needs validation)
- GCC bitrate ramp-in timing (~15% → 100% over ~30 s) — single-source, plausible,
  not independently replicated
- Generic 150–500 ms per-hop latency ranges — no source specific to raw-track
  forwarding
- Magharei & Rejaie (INFOCOM 2007) mesh-vs-tree — headline finding reported
  secondhand; full text not machine-readable in this pass
- A claimed "30% opt-in rate / EU broadcasters requiring opt-in" figure was
  **discarded** as uncorroborated rather than carried forward

---
*Research completed: 2026-08-20*
*Ready for roadmap: yes*
