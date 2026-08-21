# Architecture Research: Server-Orchestrated WebRTC Distribution Tree

**Domain:** Depth-capped P2P media distribution tree, layered over an existing WebSocket relay
**Researched:** 2026-08-20
**Confidence:** MEDIUM-HIGH (protocol/component design: HIGH — derived directly from the existing, working `server/rooms.js` + `shared/broadcaster.js` + `shared/rtc.js` code. Browser media-forwarding mechanics: MEDIUM — cross-checked against MDN/W3C spec pages, but the load-bearing claim about decode/re-encode behavior is inference from spec docs + general WebRTC domain knowledge, not a single authoritative citation. Treat as HIGH-confidence design, MEDIUM-confidence physics, and validate the physics with the spike this project already plans.)

## The One Finding That Reshapes Everything Else

The project's own `PROJECT.md` flags one unproven assumption as the whole thing's linchpin: *"Um espectador consegue repassar a faixa recebida para uma nova RTCPeerConnection via `addTrack`, sem decodificar e sem recodificar."* Research says this premise is **half right and the important half is wrong**, in a way that actually helps.

In a browser (not a media server like mediasoup/Pion), `RTCPeerConnection.addTrack(track)` where `track` came from another connection's `ontrack` does **not** give you raw-RTP passthrough. The browser decodes the incoming stream to a `MediaStreamTrack` (real decoded frames) and the second `RTCPeerConnection` runs its **own independent encoder** over those frames. True zero-decode packet forwarding only exists via WebRTC Encoded Transforms (`RTCRtpScriptTransform` / Insertable Streams on `RTCRtpReceiver.transform` / `RTCRtpSender.transform`) — MDN's own framing of that API ("enables forwarding frames without decoding them at intermediate points like SFUs") only makes sense if the *default* path decodes. [Using WebRTC Encoded Transforms — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_Encoded_Transforms)

This does **not** sink the plan — R1/R2's actual goal (cap the *broadcaster's* uplink) is achieved either way, since the forwarder's uplink is spent instead of the broadcaster's. But it changes the engineering:

- **Cost moved, not avoided.** A forwarder pays real CPU (decode H.264 + encode again) and adds one hop of encode/decode latency, on hardware you don't control (a room participant's laptop, not infra you provision). This is why R2 ("capacity measured, not guessed") and R5's mobile hard-cut matter more than the plan currently assumes — a forwarder's *encode* headroom, not just its *network* uplink, is the real constrained resource.
- **A silver lining for keyframes (see Q4 below).** Because the forwarder's outgoing leg is a real, independent, browser-native encoder — not a raw-packet relay — it automatically participates in standard WebRTC loss/PLI recovery. A new grandchild triggers the forwarder's own encoder to emit a keyframe, same as any ordinary WebRTC sender. You get correct keyframe behavior at every depth **for free**, specifically *because* the naive approach isn't a pure relay.
- **Recommendation: use plain `addTrack(remoteTrack)` forwarding, not Encoded Transforms.** Insertable Streams would recover the CPU cost but reintroduces exactly the problem you'd be avoiding: with true packet passthrough, nobody along the forwarding leg has a decoder to react to PLI, and you'd have to hand-roll RTCP interception and keyframe orchestration that browsers don't expose to JS in the first place (there is no `pc.onPliReceived`). Given the room target is 10 people (K=3 → 12 seats, K=4 → 20 seats) and modern laptops decode+encode 1080p30 H.264 with hardware acceleration trivially, the CPU cost of transcoding at one hop is the cheaper trade. Validate this in the spike with a real forwarder on modest hardware (not a dev machine) before trusting it.

This reframes the "prove first" item in `PROJECT.md`: what needs proving isn't "can a track be forwarded without recoding" (it can't, structurally) — it's "does one hop of decode+re-encode on ordinary viewer hardware hold up at the target fan-out and resolution." That's the real spike.

## Standard Architecture

### System Overview

```text
                    ┌───────────────────────────────────────┐
                    │         Origin (Broadcaster)           │
                    │   shared/broadcaster.js (unchanged)     │
                    │  WebCodecs encode → chunks → relay      │
                    │  RTCPeerConnection per DIRECT child      │
                    └───────┬───────────────────┬─────────────┘
                            │ WS control (existing rtc-*        │ up to K peer
                            │ + new tree messages)               │ connections
                            ▼                                    ▼
        ┌───────────────────────────────────┐        ┌────────────────────┐
        │   Server — Tree Owner (new)        │        │  Direct child(s)    │
        │   server/rooms.js extension        │◄──────►│  role: leaf OR       │
        │  • node registry (id,parent,       │  WS     │  role: forwarder     │
        │    children,role,depth,capacity,   │ control │  (depth 1)           │
        │    measured stats)                 │        └─────────┬───────────┘
        │  • atribuirPai() — sole writer     │                  │ if role=forwarder:
        │  • escolherPai() — pure function   │                  │ up to K peer
        │  • orphan detection + reparent     │                  │ connections
        │  • relay gating (existing,         │                  ▼
        │    unchanged, still per-viewer)    │        ┌────────────────────┐
        └───────────────┬─────────────────────┘        │  Leaf (depth 2)     │
                         │ signaling routed by peerId,   │  never a parent     │
                         │ regardless of ws pool          └────────────────────┘
                         ▼
        ┌───────────────────────────────────┐
        │  WebSocket Relay (existing,        │◄──── every viewer, at every depth,
        │  server/rooms.js pushChunk())      │      stays subscribed here as the
        │  UNCHANGED — still per-viewer      │      substrate underneath the tree
        │  __rtc-gated fallback              │
        └───────────────────────────────────┘
```

Depth is capped at 2 by construction: root (depth 0) → forwarder (depth 1) → leaf (depth 2). A leaf is never offered the forwarder role's client code path, so it structurally cannot accept a child — see Q5.

### Component Responsibilities

| Component | Responsibility | Where it lives |
|-----------|----------------|-----------------|
| **Tree State Store** | Authoritative node registry for one broadcast: role, parent, children, depth, capacity, measured stats. Sole source of truth — nothing else caches topology. | New: `server/arvore.js` (or inline in `rooms.js` next to the existing `broadcasters`/`viewers` maps) |
| **Parent Selection (`escolherPai`)** | Pure function: candidates → chosen parent. Hard cuts first (capacity, mobile, depth), then weighted score. v1 can be "boba" (dumb: first candidate with room). | New: `server/escolherPai.js`, zero I/O, unit-testable without a socket |
| **Signaling Router** | Routes `rtc`, `rtc-want`, and new tree messages by `peerId`, agnostic of whether that peerId currently lives in `room.broadcasters` or `room.viewers`. | Extension of `server/rooms.js:rtcParaBroadcaster()` / `rtcParaViewer()` |
| **Relay Gating** | Decides per-viewer whether relay chunks flow. **Unchanged.** Already keyed on "is this viewer's `__rtc` set populated for this slot" — agnostic to whether the P2P peer is the origin or a forwarder. | `server/rooms.js:atualizarChunks()` (no changes needed) |
| **Forwarder Client Runtime** | Accepts child offers up to assigned capacity, forwards received track via `addTrack`, reports capacity/RTT/loss. New role, new small module reusing existing peer-connection plumbing. | New: `shared/forwarder.js`, built on existing `shared/rtc.js:construtorPeer()`/`criarPeer()` |
| **Viewer State Machine** | Tracks per-stream connection state (relay-only / negotiating / direct / orphaned), reacts to tree messages, unchanged relay/jitter-buffer integration. | Extension of `client/src/main.js` |
| **Capacity & Measurement Reporter** | Polls `getStats()` for `availableOutgoingBitrate`, RTT, loss; reports upward on an interval. Runs on forwarders (their outgoing legs) and on leaves (their one incoming leg). | New, client-side, shared between Activity and website builds |
| **Admin Tree View (R9)** | Read-only projection of the Tree State Store: parent/child graph, capacity, RTT, last reparent reason. | Extension of `server/admin.js` |

## Data Model (Q1)

Tree state lives **server-side only**, in memory, next to the existing per-broadcaster/per-viewer entries — not as a separate subsystem, and not client-side. Clients never see the whole tree, only their own assignment. This matches the existing pattern (`server/rooms.js` already owns all room state; nothing here breaks that boundary).

Minimal authoritative node record, one per (peerId, broadcaster-slot) — a viewer watching two different streams has two independent tree memberships:

```js
{
  id: peerId,               // same peerId already used by rtc-want/rtc routing
  role: 'root' | 'forwarder' | 'leaf',
  parent: peerId | null,    // null only for role:'root'
  children: Set<peerId>,    // empty for role:'leaf'; capped at K for 'forwarder'
  capacity: number,         // K, or measured-derived ceiling (R2)
  depth: 0 | 1 | 2,         // derived from parent.depth + 1, never trusted as input
  measured: {
    availableOutgoingBitrate: number | null,
    rtt: number | null,
    loss: number | null,
    lastUpdate: number,     // timestamp; stale measurements decay out of scoring
  },
  state: 'pending' | 'connected' | 'orphaned' | 'draining',
}
```

**Why this shape and not more:** everything else the roadmap will want (ASN, room tenure, mobile flag) is an *input* to `escolherPai`, not part of the tree's own state — keep the tree record about topology, keep scoring inputs in the existing viewer/broadcaster entries where they already live (`entry.info`, connection metadata). Don't duplicate.

**Single writer:** all mutations to `parent`/`children`/`depth` go through one function, e.g. `atribuirPai(filho, pai)`. This is what makes Q5 (cycle/depth prevention) structural rather than validated — see below.

## Control Protocol (Q2)

The existing four messages stay exactly as they are for the root's direct children (nothing changes for a 2-3 person room, which is deliberately still just the star — per the project's own "no `if (espectadores > 5)` branch" decision). New messages are needed only for: assigning roles/parents, capacity/health reporting, and reparenting/orphan handling. Naming follows the existing convention (short, `rtc-`-prefixed, Portuguese where the existing set already is — `rtc-ativo` sets the precedent).

| Message | Direction | Payload | Purpose |
|---|---|---|---|
| `rtc-papel` | server → node | `{ role: 'leaf'\|'forwarder', capacidade: K }` | Tells a node whether it may ever accept children, and how many. A `leaf` client never even loads the forwarder-accept code path — this is the structural half of cycle prevention (Q5). Sent once on assignment, resent if the role changes. |
| `rtc-pai` | server → child | `{ pai: peerId, papel: 'root'\|'forwarder' }` | "Expect an offer from `pai`." Replaces the implicit assumption in today's `rtc-want` that the offerer is always the origin. Child does nothing on receipt except arm a negotiation timeout (reuses existing `PRAZO_CONEXAO_MS` pattern) — it never dials out. |
| `rtc-quer` | server → parent (new field on existing `rtc-want`) | `{ peer: peerId, papel: 'root'\|'forwarder' }` | Renamed/extended `rtc-want`: server tells the assigned parent (origin OR forwarder) to open the connection to a specific child. Existing `rtc-want` handler in `broadcaster.js:abrirPeer()` is reused unchanged for the root; the same handler is added to the new forwarder runtime. |
| `rtc-recusa` | parent → server | `{ peer: peerId, motivo: 'sem-capacidade'\|'erro' }` | Parent refuses an assignment (race: server thought there was a free slot, a concurrent child already took it). Server immediately re-runs `escolherPai` excluding this parent for this child. Without this message, a race produces a silently-stuck child waiting for an offer that never comes. |
| `rtc-capacidade` | forwarder → server | `{ availableOutgoingBitrate, filhosAtivos, filhosMax }` | Periodic (piggyback on existing 15s ping/pong cadence, or its own shorter interval — see capacity caveat below). Feeds R2's "shrink fast" side. |
| `rtc-medicao` | child → server | `{ pai: peerId, rtt, perda }` | Reported after connecting and periodically thereafter. Feeds `escolherPai`'s measured-RTT tiebreak (R5) and R6's hysteresis reparent trigger. |
| `rtc-orfao` | server → child | `{ motivo: 'pai-saiu'\|'pai-sobrecarregado' }` | Sent the instant the server detects the parent is gone, **before** a replacement is chosen. Client tears down the dead `RTCPeerConnection` and — critically — this message's arrival is what the client uses to know relay is expected to resume; it does not wait for a new `rtc-pai`. |
| `rtc-reparentar` | server → child | same shape as `rtc-pai` | Explicit "you're being moved for a *better* option," distinct from `rtc-orfao`'s "your parent died." Distinguishing the two lets the client log/telemetry (and eventually R9's admin panel) show *why* a swap happened, separate from failure handling. |

`rtc`, `rtc-bye`, `rtc-ativo` are unchanged in shape; `rtc-bye`/`rtc-ativo` now need to be routed by peerId against *either* pool (see Signaling Router below), not just `room.broadcasters`.

**Capacity reporting cadence caveat (ties to R2):** don't trust the naive sum. Each child of a forwarder is a *separate* `RTCPeerConnection`, and Chrome's bandwidth estimator (GCC) runs independently per connection — it does not know about sibling connections competing for the same physical uplink. Summing `availableOutgoingBitrate` across a forwarder's children will systematically overestimate true headroom, especially right after a new child joins (its own estimator hasn't yet converged and doesn't see the other children's traffic). [`RTCIceCandidatePairStats.availableOutgoingBitrate` — MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidatePairStats/availableOutgoingBitrate) confirms the value is a per-candidate-pair sender-side estimate, not a system-wide one. Practical mitigation for `escolherPai`'s capacity cut: **grow slowly, shrink fast** — a forwarder only becomes eligible for an *additional* child after a cool-down since its last child joined, and any `rtc-medicao` loss report from an existing child immediately zeroes out remaining advertised capacity, rather than waiting for the next `rtc-capacidade` tick.

## Forwarder Departure Sequence (Q3)

Order of operations, all triggered from one server-side event (WebSocket close, or `rtc-bye`, or missed-ping timeout on the forwarder's control connection):

1. **Same tick, before anything else:** for every child of the departing forwarder, flip relay-gating back on. This is not a new mechanism — it's the *inverse* of the existing `atualizarChunks()` gate, and because relay-gating is already keyed per-viewer on `__rtc` membership (not on which peer they were connected to), this requires no new relay code — clearing `__rtc` for that slot is sufficient. This is what prevents the black screen: relay resumes **before** any replacement parent is even chosen.
2. **Same tick:** send `rtc-orfao` to every affected child so they close their now-dead `RTCPeerConnection` and stop waiting on it (avoids a zombie connection sitting in `failed` state).
3. **Same tick:** send an urgent keyframe request to the origin over the existing WS control channel (reuse `requestKeyframe()` verbatim) so the relay has something fresh to send those children immediately, not whatever was last cached.
4. **Immediately after, but staggered:** recompute `atribuirPai()` for each orphan — do **not** dispatch all replacements in the same tick. Stagger with a small jitter (e.g. 150-300ms spacing) per orphan. This is the thundering-herd guard: without it, if a forwarder serving 4 children dies, all 4 `escolherPai()` calls could independently pick the *same* replacement forwarder (whichever looks best right now), and that replacement then receives 4 simultaneous offer/encode-start events, spiking its CPU exactly when it's least prepared for it. Staggering also lets each assignment observe the capacity state left by the previous one, naturally spreading orphans across multiple valid parents instead of piling onto one.
5. **Root is otherwise untouched.** If the departing forwarder was itself a direct child of the root, only the root's own child-count decreases (freeing one root slot for adoption) — the root does not need to know anything about the forwarder's own children; that's handled entirely in steps 1-4.
6. **Per orphan, as each new `rtc-pai` connects:** existing `rtc-ativo:{on:true}` flow re-triggers `atualizarChunks()`, which turns relay back off for that viewer once (and only once) the new direct path is confirmed live. This is already-existing logic; nothing new required here.

The key property: **relay-off is never the default reaction to churn.** Relay only turns off as a *confirmation* of a working replacement, never as an assumption that one will arrive shortly. That asymmetry (fast fail-open to relay, slow/staggered fail back to P2P) is what keeps a 10-person room from visibly breaking when one forwarder leaves.

## Keyframe Handling (Q4)

Because forwarding is decode+re-encode (see the framing finding above), the forwarder's outgoing leg to each child is an ordinary, independent WebRTC sender — it participates in standard loss/PLI recovery automatically. This changes the cost/benefit of the three options materially from what they'd be in front of a true packet-forwarding relay:

| Option | Mechanism | Cost | Verdict |
|---|---|---|---|
| **PLI propagation** | A new child's decoder can't decode without a reference frame, so its browser automatically issues RTCP PLI to the forwarder. Because the forwarder's leg to that child is a *real encoder* (not a packet relay), the browser's own WebRTC stack responds to that PLI by forcing a keyframe **on the forwarder's own encoder output** — standard behavior, zero app code. | Free. Not observable from JS as an event (no `onPliReceived`), but visible after the fact via `getStats()` `pliCount`/`firCount` on the outbound-rtp stats object (verify exact field name at implementation time — not directly confirmed by a primary source in this pass, MEDIUM confidence). Throttled internally (implementations commonly rate-limit PLI response, roughly ~1/sec order of magnitude) — see the `mediasoup` PLI throttling behavior as an analog: [PLI/FIR improvements · Issue #232 · versatica/mediasoup](https://github.com/versatica/mediasoup/issues/232). | **Primary mechanism.** Requires nothing beyond just using plain `addTrack` forwarding. Validate the throttling window in the spike — it bounds the worst case for a burst of grandchildren joining together. |
| **Out-of-band request to origin over WebSocket** | Server already has `requestKeyframe()` on the relay path. Extend it: fire it at the origin any time the server assigns *any* new leg anywhere in the tree, not just relay fallback. | Trivial — the mechanism exists and works today; this is a one-line trigger-point extension, no new code path. | **Cheap defense-in-depth.** Shrinks worst-case latency for the *forwarder's own* keyframe by giving it a fresh, strong reference frame to re-encode from sooner, on top of (not instead of) native PLI. Won't by itself force the forwarder's own encoder to emit a keyframe (there's no JS-exposed "generate keyframe now" call on a native `RTCRtpSender` for this project to invoke) — it helps quality of the *next* keyframe, PLI still drives *when* one is emitted. |
| **Periodic keyframes** | Already implemented at the origin: `encoder.encode()` forces one every 3s (`shared/broadcaster.js`). | Zero additional cost — already shipped. | **Backstop, not primary.** Worst case for a grandchild who joins right after a keyframe: up to ~3s wait, propagated through one extra re-encode hop. Acceptable given the project already accepted "reparenting may blink" — but don't rely on this alone; it's the floor under the other two, not the plan. |

**Recommendation:** layer all three, in this priority order — native PLI (free, automatic, the actual mechanism that resolves "grandchild needs an I-frame") as primary; the existing WS keyframe request fired on every new tree assignment as cheap-to-wire defense-in-depth; the existing 3s periodic cadence as the backstop that was already there. No new keyframe protocol is needed at all — this is the one place in the whole feature where the existing system already does the hard part.

## Structural Cycle/Depth Prevention (Q5)

Prevent, don't validate, by construction:

1. **Single writer.** `atribuirPai(filho, pai)` is the *only* function anywhere in the server that mutates `parent`/`children`. Nothing else touches those fields. This alone rules out most classes of "two code paths disagreed about who's whose parent."
2. **Depth is derived, never accepted as input.** `depth(node) = depth(parent) + 1`, root fixed at 0 by definition. `atribuirPai` computes this from the *current, authoritative* parent record, not from anything a client sends — clients never report their own depth.
3. **Candidate pool is role-gated, not depth-checked after the fact.** `escolherPai`'s candidate list is built by querying the Tree State Store for nodes with `role !== 'leaf'` and `depth < 1` (i.e., only root and depth-1 forwarders are ever eligible parents). A depth-2 leaf is never in the candidate list to begin with — there's no depth arithmetic to get wrong because depth-2 nodes are structurally excluded from the query, not filtered by a depth comparison that could have an off-by-one.
4. **Children never choose, structurally, not by policy.** A leaf's client code never contains a "become a parent" branch unless the server has sent `rtc-papel: forwarder`. There is no client-initiated "connect to me" message in the whole protocol — every offer is dispatched by the parent *because the server told it to* (`rtc-quer`), mirroring the existing invariant that the broadcaster always initiates. A node cannot create an edge the server didn't order; cycles require some node to accept an unsolicited connection, and none can.
5. **One parent at a time, enforced by the writer.** `atribuirPai` always removes the child from any previous parent's `children` set in the same call that adds it to the new one — there is no window where a node has two parents in the data model, which is what would make "is this a cycle" an actual graph question instead of a non-issue by invariant (a forest where every node has ≤1 parent and depth is monotonic from a single root cannot contain a cycle).

## Relay/Tree Coexistence (Q6)

The pleasant surprise: **this requires no changes to the relay gating mechanism.** `atualizarChunks()` and the `__rtc` per-viewer set are already agnostic to *who* the peer on the other end is — they only ask "is this viewer receiving this slot via RTC." Whether that RTC connection terminates at the origin or at a forwarder is invisible to the relay layer today, and stays invisible after this change. The only thing that needs generalizing is signaling routing (`rtcParaBroadcaster`/`rtcParaViewer` → route by peerId against whichever pool currently holds it, since a forwarder's WebSocket is a *viewer* connection that must also receive parent-side signaling for its own children).

The viewer-visible mechanics of "moving between them without a break longer than a brief loading state" are exactly the Q3 sequence: relay-off is a confirmation, not a default; relay-on is the immediate, same-tick reaction to any parent loss, before a replacement exists. The "brief loading state" the project already accepted is bounded by: urgent keyframe request round-trip (existing, sub-second) + the jitter buffer's `BUFFER_MS` — not by how long reparenting takes, since reparenting happens underneath an already-resumed relay stream.

## Viewer State Machine (Q7)

```text
                    ┌──────────────┐
        ┌──────────►│  RELAY_ONLY  │◄────────────────────────────┐
        │           └──────┬───────┘                              │
        │                  │ server sends rtc-quer/rtc-pai         │
        │                  ▼                                       │
        │           ┌──────────────┐   timeout / ICE failed        │
        │           │ NEGOTIATING  │─────────────────────────────► │
        │           └──────┬───────┘                               │
        │                  │ connectionstate=connected,             │
        │                  │ first frame decoded                    │
        │                  ▼                                        │
        │           ┌──────────────┐                                │
        │           │    DIRECT    │  (viaForwarder: bool flag,     │
        │           │              │   same state either way —      │
        │           │              │   see note below)              │
        │           └──────┬───────┘                                │
        │                  │ parent ws closes /                     │
        │                  │ connectionstate=failed past grace       │
        │                  ▼                                        │
        │           ┌──────────────┐                                │
        └───────────│   ORPHANED   │────────────────────────────────┘
     rtc-orfao         └──────┬───────┘   on entry: relay resumes immediately
     received                 │ rtc-reparentar received
                               ▼
                        NEGOTIATING (re-parented attempt)
```

**Opinionated simplification vs. the six states in the question:** collapse "direct-from-broadcaster" and "direct-from-forwarder" into one `DIRECT` state with a `viaForwarder` boolean, and collapse "re-parented" into the same `NEGOTIATING` state the first connection used. The client genuinely does not need different behavior in either case — same offer/answer flow, same fallback timeout, same relay-gating interaction. Introducing two states for something that behaves identically only adds branches nobody will exercise differently, which is exactly the kind of rarely-run path the project's Key Decisions already warn against ("caminho que só roda no caso raro está sempre quebrado"). Keep the distinction only in *telemetry* (log `parentRole` and `motivo` for the admin panel, R9), not in control flow.

One constraint worth carrying into the roadmap: **`P2P_ONLY` (R8) as currently implemented skips `RELAY_ONLY` entirely** — a client in that mode goes straight to `NEGOTIATING` with no fallback state to return to on failure, which is the exact mechanism behind the already-diagnosed "stuck on Connecting… forever" bug. Whatever R8 becomes (diagnostic-only mode), the state machine should make `RELAY_ONLY` unreachable-but-still-defined in that mode, not remove the state — so the diagnostic value (does this fail without relay?) is preserved while the failure mode is visible/timed-out rather than infinite.

## Recommended Build Order

Dependency-driven, not requirement-numbered (R1-R13 thread through multiple phases, not one each):

1. **Forwarding spike (before anything else architectural).** A hardcoded, two-hop, no-server-orchestration probe: origin → manually-designated forwarder → manually-designated leaf, using plain `addTrack` passthrough on real (non-dev-tier) hardware, at target resolution/fps. This is the "prove first" item from `PROJECT.md`, now sharpened by the framing finding above: what's being proven is CPU headroom for one hop of decode+re-encode, not whether forwarding is possible at all (it is, just not free).
2. **Tree State Store + pure `escolherPai` (dumb version) + `atribuirPai` as sole writer.** No wire protocol yet. Testable with synthetic 10-node trees without opening a single socket — matches the project's own stated reason for keeping parent selection a pure function.
3. **Control protocol + Signaling Router generalization.** Wire `rtc-papel`/`rtc-pai`/`rtc-quer`/`rtc-recusa` through the now-peerId-indexed router. Depends on (2)'s data model existing to assign roles/parents against.
4. **Forwarder client runtime.** Accept-child + `addTrack` forwarding, reusing `shared/rtc.js` unchanged for the connection/escape-hatch machinery. Depends on (3) for the offer-dispatch trigger.
5. **Viewer state machine + orphan/reparent + relay coexistence.** Mostly extending existing `rtc-ativo` handling; relay gating itself needs no changes (Q6). Depends on (3).
6. **Capacity/RTT/loss measurement + hysteresis reparenting (R6).** Needs real, live connections to measure against — depends on (5) being stable before feeding scored reparenting decisions back into `escolherPai`.
7. **Fan cap + relay overflow (R1) and measured-capacity leash (R2)** are not a separate phase — they fall out of (2)'s hard-cut candidate filtering plus (6)'s measured feed. Land the "hard cut on configured K" half in (2)-(3) (cheap, no measurement needed), and the "measured, shrinks on loss" half in (6).
8. **Admin tree view (R9).** Read-only projection; safe to build any time after (2)'s data shape stabilizes, but low-value until (4)-(6) exist to have something worth showing.

## Anti-Patterns to Avoid

### Trusting `addTrack` as literal zero-cost passthrough

**What people assume:** forwarding a remote track costs nothing extra because "it's just relaying packets."
**Why it's wrong:** it's decode+re-encode on the forwarder's machine, not packet relay. Budgeting it as free will produce a forwarder that silently degrades (frame drops, encode backpressure) under load with no visible cause, on hardware the project doesn't control.
**Do instead:** treat forwarder CPU/encode headroom as a measured, shrinking-fast resource in `escolherPai`, same as network capacity (R2's own philosophy, just applied to a resource the requirement text doesn't currently name).

### Summing per-connection bandwidth estimates as total forwarder capacity

**What people assume:** `availableOutgoingBitrate` summed across a forwarder's active children equals remaining headroom for a new child.
**Why it's wrong:** each `RTCPeerConnection`'s GCC estimator runs independently and doesn't see sibling connections' traffic on the same physical link — the sum systematically overestimates.
**Do instead:** grow capacity slowly (cool-down after each new child before offering another), shrink immediately on any child's loss report, and treat the estimate as a ceiling hint, not a budget to spend precisely.

### Waiting for a replacement parent before restoring relay

**What people assume:** on parent loss, find the new parent first, then reconnect — minimizes "wasted" relay bandwidth.
**Why it's wrong:** this is exactly the black-screen path — any latency in `escolherPai` + offer/answer/ICE becomes visible dead air.
**Do instead:** relay-on is the immediate, same-tick default on any parent loss; relay-off is only ever a confirmation that a replacement is *already* working (Q3, Q6).

### Dispatching all orphan reassignments in one tick

**What people assume:** react to a forwarder's departure by immediately reparenting all its children — feels responsive.
**Why it's wrong:** thundering herd — several orphans' `escolherPai` calls can converge on the same replacement, hitting it with simultaneous offer/encode-start load right when it's least ready.
**Do instead:** stagger with jitter, and let each assignment observe the capacity state left by the previous one (Q3).

### A depth check instead of a role-gated candidate query

**What people assume:** "just add `if (depth >= MAX_DEPTH) reject`" wherever a parent is chosen is enough to cap depth.
**Why it's wrong:** it's validation bolted onto every call site, which means every new call site is a chance to forget it — exactly the failure mode the project is trying to design out by making the server (not clients) own topology in the first place.
**Do instead:** make the *candidate query itself* structurally incapable of returning a depth-2 node — there's no depth check to skip if depth-2 nodes were never in the result set (Q5).

## Sources

- [Using WebRTC Encoded Transforms — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_Encoded_Transforms) — confirms Insertable Streams exists specifically to enable decode-free forwarding, implying the default `addTrack` path is not decode-free. MEDIUM confidence (cross-checked, inference-based).
- [`RTCIceCandidatePairStats.availableOutgoingBitrate` — MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidatePairStats/availableOutgoingBitrate) — per-candidate-pair sender-side bandwidth estimate; basis for the "don't sum across sibling connections" finding. MEDIUM-HIGH (MDN spec reference).
- [PLI/FIR improvements · Issue #232 · versatica/mediasoup](https://github.com/versatica/mediasoup/issues/232) — documents real-world PLI throttling behavior (~1 per 2s in mediasoup's producer), used as an analog for expected native throttling order of magnitude. MEDIUM (community issue, not spec).
- [pion/webrtc rtp-forwarder example](https://github.com/pion/webrtc/blob/master/examples/rtp-forwarder/main.go) — demonstrates that even a pure-RTP-level relay implementation needs explicit PLI handling; used to reason about what's and isn't automatic. MEDIUM.
- [Jitsi Octo cascading design doc](https://github.com/jitsi/jitsi-videobridge/blob/a953d1d892bf78c2f12cfe70af7ded0c2fe81188/doc/octo.md) and [Improving Scale and Media Quality with Cascading SFUs — webrtcHacks](https://webrtchacks.com/sfu-cascading/) — precedent for "no signaling between relay tiers; all topology decisions made centrally," reinforcing the server-owns-topology / children-never-choose design. MEDIUM.
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`, `.planning/PROJECT.md` (this repository) — existing, working implementation of the relay/signaling substrate this design extends. HIGH (primary source, own codebase).

---
*Architecture research for: server-orchestrated WebRTC distribution tree*
*Researched: 2026-08-20*
