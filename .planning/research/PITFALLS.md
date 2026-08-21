# Pitfalls Research: Peer-Assisted WebRTC Tree Distribution

**Domain:** Peer-to-peer / tree-based WebRTC media distribution (one-hop forwarding tree over an existing WebSocket relay + WebRTC star)
**Researched:** 2026-08-20
**Confidence:** MEDIUM overall (HIGH for measured NAT/TURN numbers cross-checked across sources; LOW for latency-per-hop and mobile-uplink numbers — no primary measured data found, flagged inline)

## How to read this file

Ten questions were asked; each maps to one Critical Pitfall below in the same order. Numbers are cited with source links. Where no measured number exists, the item is explicitly labeled **FOLKLORE** or **NO DATA FOUND — inferred** rather than presented as fact. Findings are tied back to this project's actual code (`server/rooms.js`, `shared/broadcaster.js`, `PROJECT.md` requirements R1–R13) wherever the codebase map (`CONCERNS.md`) already surfaced the relevant mechanism.

---

## Critical Pitfalls

### Pitfall 1: `availableOutgoingBitrate` is a lagging, sender-side guess — trusting it directly overshoots fan-out

**What goes wrong:**
A forwarder reads `availableOutgoingBitrate` from `getStats()` and treats it as "spare capacity for one more child." Two things make this wrong: (a) it's a transport-cc/REMB estimate computed from feedback the sender already has, which lags reality — under feedback-path congestion it can "look fine while roundTripTime is already growing," i.e. it's stale by the time it reflects a problem ([bloggeek.me/getstats](https://bloggeek.me/getstats/), [discuss-webrtc thread](https://groups.google.com/g/discuss-webrtc/c/mhVV1GI_Gq8)); (b) a freshly-started stream ramps from roughly 15% of target bitrate to 100% over about 30 seconds, so an estimate read moments after a child connects is not the ceiling, it's a ramp-in-progress ([forasoft.com](https://www.forasoft.com/learn/video-streaming/articles-streaming/webrtc-bandwidth-estimation)). A forwarder that accepts a 3rd child because the stat momentarily "shows room" can end up dragging all three children down together once its real uplink saturates, because they share the same physical NIC/queue — congestion on one shows up as loss on all.

**Why it happens:**
The metric name implies ground truth ("available outgoing bitrate") when it's actually a smoothed, lagged sender-side model. Teams new to WebRTC congestion control treat it like a hardware speedometer instead of a noisy, delayed signal.

**How to avoid:**
- Never gate fan-out admission purely on an instantaneous `availableOutgoingBitrate` read; require it to hold steady across multiple polling intervals before trusting a capacity increase (matches this project's own R2/R6: "leque encolhe quando as estatísticas do filho mostram perda" and "servidor re-paterniza com histerese").
- Corroborate with the *receiving* child's own reported loss/RTT via RTCP receiver reports (R6's "filho mede RTT e perda... e reporta"), not just the sender's local view — the sender's estimate can be optimistic exactly when the child is already suffering.
- Treat the first ~30s after a child connects as a probation window: don't admit a further child from that same forwarder until the stream has ramped and stabilized.

**Warning signs:** a forwarder's admitted children all show correlated bitrate drops/freezes at the same time; `availableOutgoingBitrate` stays "healthy" while children's `packetsLost`/RTT climb.

**Phase to address:** the capacity-aware fan-out phase (R1/R2).

---

### Pitfall 2: Churn causes reconnect storms and orphan cascades, amplified by this app's own full-broadcast state model

**What goes wrong:**
When people join/leave rapidly, two failure modes compound:
1. **Reconnect thundering herd** — if clients retry without jitter, "every retry wave hits the recovering server simultaneously," which can keep the system degraded longer than the original disruption ([websocket.org/guides/reconnection](https://websocket.org/guides/reconnection/)).
2. **Orphan storms in trees specifically** — academic P2P-streaming comparisons find that when a parent node in a tree disconnects, its *entire subtree* loses data until re-parented, and the effect worsens with tree depth; this is a structural property of trees (vs. mesh) repeatedly observed in the literature, though mostly validated in small academic testbeds rather than large production deployments — treat the *magnitude* as **folklore-adjacent**, the *mechanism* as solid ([P2P live streaming comparison research](https://www.researchgate.net/publication/286562014_P2P_live_video_streaming_in_WebRTC)).

This project's own control plane makes both worse than a generic tree would: `server/rooms.js` calls `broadcastState()` — a full room-state fan-out to every viewer *and* every broadcaster — on every single connect, disconnect, watch-start, and watch-stop event (`CONCERNS.md`, "Room State Broadcast on Every Viewer Change," `server/rooms.js:547-551,642,844,852,973`). When one mid-tree forwarder drops, the server must reassign several orphans in a burst; if each reassignment independently triggers a full `broadcastState()`, a single node leaving a 10-person room can produce several full O(N) broadcasts within the same second — control-message amplification on top of the media-plane orphan cascade.

**Why it happens:** `broadcastState()` was written for a flat star where join/leave events are already infrequent relative to viewer count; a tree introduces server-initiated re-topology events (re-parenting) that weren't part of the original event model, and nothing currently debounces or batches them.

**How to avoid:**
- Add jittered backoff to any client-side reconnect/re-request logic.
- Batch/debounce `broadcastState()` calls that occur within a short window (CONCERNS.md's own suggested fix: "collect changes over 50ms, send once") — this becomes load-bearing, not optional, once orphan reassignment can fire several state changes back-to-back.
- Keep the relay as the immediate fallback for orphans (R7: "órfão volta ao relay em menos de um segundo") so media doesn't stall while the control plane catches up — this decouples media continuity from control-plane storm behavior.

**Warning signs:** CPU/message-rate spikes on the WebSocket server correlated with a single peer disconnecting in a tree-heavy room; visible stutter across multiple *unrelated* viewers when only one viewer actually left.

**Phase to address:** the topology-ownership phase (R4, R7) and the instrumentation phase (R10) should both budget for this — R10 must be able to show "did one departure cause N broadcasts."

---

### Pitfall 3: Keyframe starvation compounds with hop count — black screen duration is not fixed, it's `f(hops, PLI interval, encoder cost)`

**What goes wrong:**
A viewer sees black/frozen video until the next keyframe arrives. The mechanics: a receiver should request a full keyframe immediately on connect via PLI ("this minimizes the delay between connecting and an image showing up") and multiparty conferencing servers explicitly force a keyframe request when a new participant joins, precisely because otherwise the wait is for the next *scheduled* keyframe, which can be seconds away ([webrtcforthecurious.com](https://webrtcforthecurious.com/docs/06-media-communication/), [bloggeek.me/webrtcglossary/pli](https://bloggeek.me/webrtcglossary/pli/)). PLI's own protocol has a floor: default interval 5s, recommended minimum 1s between two PLI requests — so even a well-behaved implementation can't get an *arbitrarily* fast keyframe; there's a built-in minimum latency to the request path itself.

In a **tree**, this gets worse, not just repeated: this project's R3 forwards the raw track via `addTrack` without decoding/re-encoding, so a forwarder cannot itself synthesize a keyframe — a PLI from a grandchild has to travel back through the forwarder to the original broadcaster's encoder, which must then produce a fresh IDR frame, which then has to propagate back down through the forwarder to the grandchild. That's two RTT-scale round trips (grandchild→forwarder→broadcaster, then broadcaster→forwarder→grandchild) plus encoder IDR-generation time, stacked on top of PLI's own 1s minimum spacing — worse on **re-parent**, because the new parent (itself possibly a peer that just joined) has no cached keyframe to hand off immediately, unlike a dedicated SFU that can cache and immediately replay the last keyframe to a newly-attached receiver.

**Why it happens:** raw-track forwarding (chosen deliberately here to avoid decode/encode cost — see PROJECT.md "Peça que decide tudo") trades away the SFU's ability to cache and instantly replay a keyframe to new/re-parented receivers.

**How to avoid:**
- Force a keyframe request up to the root broadcaster on every new child attach *and* every re-parent event, not just on first connect.
- Measure actual black-screen duration in the depth-2 case specifically (grandchild path) during the spike this project has already flagged as unmeasured (PROJECT.md: "o teto aceitável ainda não está definido — é pergunta a responder com número medido no spike").
- Accept the "trancadinha" (visible stutter) on re-parent as intentional per this project's own decision log, but make sure the *worst case* (grandchild re-parenting to a fresh peer) is the one actually measured, not the best case (parent re-parenting directly under the broadcaster).

**Warning signs:** re-parent events correlate with multi-second freezes specifically at depth 2, not depth 1 — if depth 1 and depth 2 re-parents look the same, the keyframe round-trip assumption above is wrong and needs re-checking against real captures.

**Phase to address:** the topology-ownership / re-parent phase (R4, R6) — this needs an explicit "keyframe on attach/re-parent" acceptance test, and the UI phase (bugs entering early per Key Decisions) should surface a loading state rather than a bare black frame during this window.

---

### Pitfall 4: NAT/ICE failure compounds multiplicatively with hop count — a tree is only as reliable as its weakest link, raised to the power of hops

**What goes wrong:**
Cross-checked across multiple independent sources: roughly **10–22% of WebRTC sessions need TURN to connect at all**, with reported ranges as wide as 4–30% depending on geography and network type (corporate/institutional firewalls push it toward the high end); one aggregate measurement across billions of session-minutes found **~22% needed TURN, and 85% of all connection failures traced to NAT/firewall traversal** specifically ([Philipp Hancke, "So I read that 20% of WebRTC calls fail"](https://medium.com/@fippo/so-i-read-that-20-of-webrtc-calls-fail-67b185e49765); [lazyharu.com NAT traversal](https://lazyharu.com/en/webrtc-nat-traversal/); [arxiv large-scale NAT traversal measurement](https://arxiv.org/pdf/2510.27500)). Symmetric NAT — common on mobile carrier CGNAT and some consumer routers — is repeatedly identified as the dominant single cause.

**On the specific question of viewer↔viewer vs viewer↔broadcaster failing more:** **NO DIRECT MEASURED COMPARISON WAS FOUND.** What can be said with confidence is structural, not measured: in this app the broadcaster is *also* a residential peer (PROJECT.md: "Dez espectadores... exigiriam 25 Mb/s de subida de **uma conexão doméstica**"), so a viewer↔broadcaster connection and a viewer↔viewer connection are the *same kind* of NAT pairing today — both are residential-to-residential. What changes with a tree is not the per-pair failure rate, it's the **number of pairs a session depends on**. If a single hop connects with probability *p* (≈0.78–0.90 per the ranges above), a two-hop path (broadcaster→forwarder→grandchild) that needs *both* hops to succeed has combined probability ≈ *p²* — e.g. at p=0.85, a depth-2 path succeeds only ≈72% of the time end-to-end, purely from compounding independent hop failures. This is an inference from the cited numbers, not a directly measured tree-vs-star study — label it **INFERRED, not folklore, not directly measured**.

**Why it happens:** teams size TURN capacity/instrumentation off single-hop failure rates and don't re-derive the number for a multi-hop path, where failure probability compounds.

**How to avoid:**
- Instrument per-hop connect success separately (this project's own R11: "quantos pares não fecham sem TURN") — and explicitly break it out by depth, not just aggregate, since depth-2 will have a structurally worse *effective* success rate even if every individual hop is equally reliable.
- Keep the relay fallback per-hop (R7), not just at the root — an orphaned grandchild whose *own* WebRTC hop fails needs to fall to relay independently of whether its former parent's hop was fine.

**Warning signs:** connect-success telemetry shows depth-2 viewers falling back to relay noticeably more than depth-1 viewers even when both hops individually report similar ICE-failure rates — that's the compounding effect showing up, not a new bug.

**Phase to address:** the TURN-instrumentation phase (R11) must slice data by hop depth, not just report a single aggregate number.

---

### Pitfall 5: There is no reliable client-side signal to detect "this viewer is on a bad/metered/mobile uplink" before promoting them to forwarder

**What goes wrong:** No measured production numbers were found for "how much does promoting a mobile viewer as a forwarder hurt" (**NO DATA FOUND**). What is verifiable: mobile/cellular uplink is shared, congestible cell capacity that degrades unpredictably under contention, and some carrier plans throttle or cap tethered/mobile-hotspot upload separately from the phone's own untethered allowance ([mobile hotspot reliability sources](https://www.bgr.com/2159640/reasons-why-mobile-hotspot-unreliable/)). The obvious client-side detection tool, the Network Information API (`navigator.connection.effectiveType`/`downlink`), is **Chromium/Android-only with no Safari/iOS support at all**, and even where supported returns coarse buckets (`slow-2g`/`2g`/`3g`/`4g`) rather than a real bitrate ceiling ([MDN Network Information API](https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API)). It cannot be trusted as the sole gate for "is this device fit to be a forwarder," and on iOS it isn't available at all.

**Why it happens:** the API name suggests it answers the exact question a forwarder-promotion feature needs ("what kind of connection is this"), but it was designed for adaptive asset loading (image quality), not real-time capacity planning, and its browser coverage gap is easy to miss until an iPhone user hits it.

**How to avoid:**
- Don't gate forwarder eligibility on `navigator.connection` alone; this project's own R2/R6 design already gets this right by preferring *measured* capacity (post-connection `availableOutgoingBitrate` + child-reported loss/RTT) over any pre-connection guess — extend that same principle to mobile detection: let a mobile viewer be tried as a forwarder, but demote fast (with the same hysteresis logic as R6) the moment measured loss appears, rather than trying to pre-classify device type.
- Where `navigator.connection` *is* available, treat it only as a soft "deprioritize" signal (R5's weighted scoring already has room for this — "nota por... folga"), never a hard cut except where the project has explicitly named one ("celular" appears as a listed hard cut in R5's own design: "cortes duros primeiro (capacidade, celular, profundidade)").
- Verify what `navigator.connection` reports (if anything) inside the Discord Activity's sandboxed iframe specifically — sandboxed iframes sometimes restrict or omit less-common Web APIs; don't assume desktop-browser test results transfer.

**Warning signs:** a promoted forwarder's children all degrade together shortly after promotion, with the forwarder's own device being a phone/laptop-on-hotspot — the pattern to watch for is correlated child degradation, not a single metric.

**Phase to address:** the parent-selection phase (R5) — "celular" is already named as a hard cut in the pure-function scoring; this pitfall confirms that decision was right and that no better pre-emptive signal exists to replace it with.

---

### Pitfall 6: Per-hop latency has no verified number for this stack yet — don't ship a depth cap decision on an assumed number

**What goes wrong:** No primary source gives a clean "X ms per forwarding hop" figure for a raw-track WebRTC relay (as opposed to a decode/re-encode SFU hop). What's known: multi-hop scenarios mean `roundTripTime/2` from `getStats()` only covers the *last* hop — "there could be servers in-between the sender and receiver" that aren't reflected in that single stat ([webrtcforthecurious.com](https://webrtcforthecurious.com/docs/05-real-time-networking/)); typical single-hop end-to-end WebRTC latency is cited as **150–500ms** depending on path/config ([VideoSDK latency guide](https://www.videosdk.live/developer-hub/webrtc/webrtc-latency)) — a wide range, not a number precise enough to budget a depth cap against. This project's own jitter buffer adds a known, fixed cost per hop that *is* measured: `BUFFER_MS = 80` (per PROJECT.md Constraints). A depth-2 path plausibly adds one extra link-RTT plus one extra 80ms jitter-buffer stage versus depth-1, but PROJECT.md itself is explicit that "the acceptable ceiling isn't defined yet — it's a question to answer with a number measured in the spike, not guessed now." Treat any specific "X ms at depth 2" claim you encounter elsewhere as **FOLKLORE unless it cites a measurement of this exact stack**.

**Why it happens:** it's tempting to reason from generic "WebRTC latency is ~200ms" folklore and assume a hop just adds "a bit more," but raw-track forwarding without an SFU's jitter-absorbing buffer per leg behaves differently from a typical SFU fan-out, and this project uses a *client-side* re-sampling jitter buffer (not a server buffer), which changes the math again.

**How to avoid:** run the spike this project has already scoped, and measure real depth-2 latency end-to-end (broadcaster capture timestamp → grandchild render timestamp) across at least one real cross-network path (not two tabs on localhost — see Pitfall 8). Only after that number exists should "is depth 2 acceptable" be answered.

**Warning signs:** shipping a depth cap or a "feels laggy" threshold based on a number nobody actually measured on this codebase.

**Phase to address:** must be answered *before* the topology phase locks in depth=2 as final — PROJECT.md already flags this as open, this research confirms no external source closes the gap; it has to be closed internally.

---

### Pitfall 7: Full room-state broadcast on every viewer change — a 10-person room with a re-arranging tree can flood every socket in the room

**What goes wrong:** already diagnosed in this codebase's own `CONCERNS.md`: `broadcastState()` sends the full room state (all participants, all active streams, all watchers per stream) to *every* viewer and *every* broadcaster on every connect, disconnect, watch-start, and watch-stop (`server/rooms.js:547-551,642,844,852,973`). This was flagged as "fine under 20 people, degrades at 50+" for the *existing* star topology. The tree milestone adds a new class of event this wasn't sized for: **server-initiated re-parenting**, which isn't a user action but *will* call the same state-broadcast path every time the server reassigns a child. In a 10-person room (the project's explicit target size), one forwarder dropping could trigger 2-4 orphan reassignments in quick succession, each potentially firing a full O(N) broadcast — meaning a single departure could produce on the order of N × (number of reassignments) messages within a second, all while the room is already trying to recover media continuity.

**Why it happens:** the O(N×M) messaging pattern was an acceptable simplification for the star topology's lower churn-event rate; the tree topology introduces a new, server-driven event type that inherits the same broadcast call without anyone having re-evaluated the volume.

**How to avoid:** implement the fix CONCERNS.md already recommends — debounce/coalesce `broadcastState()` calls within a short window (e.g. 50ms) — but treat it as **required for the tree milestone specifically**, not a nice-to-have, since re-parenting is the first event type in this codebase's history that can legitimately fire several state changes back-to-back from a single root cause. Consider a separate lightweight "topology changed" delta message distinct from full state, so a re-parent doesn't need to re-send the entire participant/stream list.

**Warning signs:** message-rate/latency spikes on the WebSocket server that correlate with tree re-arrangement events rather than with actual join/leave counts.

**Phase to address:** the instrumentation phase (R10) should specifically report messages-sent-per-departure as a metric, and the topology-ownership phase (R4/R6) should not ship without the debounce fix, since re-parenting is exactly the workload that turns this from "known limitation" into "active incident."

---

### Pitfall 8: You cannot validate real NAT/latency behavior with N tabs on one laptop — know what's fake and what isn't

**What goes wrong:** it's common (and useful, for logic testing) to spin up multiple `RTCPeerConnection` instances in one browser or across headless Docker/Puppeteer instances to exercise signaling and tree logic. Tooling exists for this: `docker-webrtc-test` (headless Chrome/Firefox in Docker, explicitly noting the need for `-P --net=host` flags "to avoid symmetrical NAT between two hosts" in a Docker bridge network — which is itself a warning that Docker's default networking silently changes NAT behavior) and `webrtcperf` (Puppeteer-driven multi-peer load testing) ([docker-webrtc-test](https://github.com/relekang/docker-webrtc-test), [webrtcperf](https://github.com/vpalmisano/webrtcperf)). But all of these run on one host or one datacenter network — they cannot reproduce real consumer NAT types (symmetric NAT, CGNAT), real cross-ISP RTT, or real consumer router bufferbloat under upload saturation, and they will never trigger a TURN fallback because loopback/LAN paths always connect directly.

**What CAN be faked/mocked (and should be, for speed):** signaling protocol correctness, the topology/re-parent algorithm itself (`escolherPai` is explicitly designed as a pure function per PROJECT.md — "Sem estado e sem protocolo, dá para testar árvore de 10 pessoas sem subir uma conexão"), keyframe-request timing logic, capacity-threshold/hysteresis decision logic, and orphan-detection/reassignment logic — all with mocked `getStats()`/fake `RTCPeerConnection`, exactly like this project's existing 403-test suite already does with WebCodecs/WebSocket/RTCPeerConnection test doubles.

**What CANNOT be faked:** real NAT traversal success/failure rates, real per-hop latency under real internet paths (Pitfall 6), real mobile carrier uplink congestion (Pitfall 5), real Discord Activity iframe sandbox behavior (Pitfall 10) — and specifically for this project, the actual `webkitRTCPeerConnection`/child-iframe escape hatch (`construtorPeer`) can only be verified by loading the real app inside a real Discord Activity, not by mocking `window.RTCPeerConnection` in a unit test, since the whole point of that code path is "what does the *real* sandbox actually leave available."

**How to avoid:** keep the topology/logic layer unit-testable and mocked (fast, exercised on every commit, already this project's strength at 86% coverage) — but budget a small number of **manual real-network smoke tests** before shipping the tree milestone: at minimum, one real cross-ISP pair (e.g. a phone on cellular data + a laptop on home wifi + the staging server), and one test run inside the actual Discord Activity iframe on `stg`, since PROJECT.md's own "Não testar em produção" constraint means `stg` is where this has to happen.

**Warning signs:** a PR that adds tree logic and passes CI with only mocked-peer tests but no real-network verification note in the phase's verification checklist.

**Phase to address:** every phase touching `abrirPeer`/`escolherPai`/re-parenting needs both: (1) the pure-function unit tests the design already calls for, and (2) an explicit manual stg verification step before merge — this maps to the project's own testing constraint ("86% é piso, não meta").

---

### Pitfall 9: Tree forwarding increases *who* sees a viewer's IP address — this is new exposure this milestone specifically introduces, and mDNS does not fix it

**What goes wrong:** WebRTC ICE negotiation inherently exposes IP addresses to the connection's other party — this is well documented in the gaming/voice-chat space, where "IP grabbing" from peer-to-peer voice/game sessions is a known, tooled attack pattern (commercial and open-source packet sniffers like OctoSniff/Session-Sniffer are built specifically for this), typically chained into geolocation (city-level, cited at 50–75% accuracy within 50km) and then a DDoS/stresser attack against the identified target ([WebRTC security overview](https://webrtc.ventures/2025/07/webrtc-security-in-2025-protocols-vulnerabilities-and-best-practices/), IP-grabber tooling sources). **In this project's current star topology, only the broadcaster's app process sees a given viewer's IP** (via that viewer's one WebRTC connection to the broadcaster). **In the tree topology, a forwarder — who is just another viewer, potentially a stranger in the same Discord room, not a trusted server operator — now also sees the IP of every child assigned to them.** This is a genuinely new exposure surface introduced by this exact milestone, not a pre-existing condition being carried forward.

**On mDNS specifically:** Chrome (and Edge/Opera) has obfuscated *local/LAN* host ICE candidates behind random `.local` mDNS hostnames since 2019 — but this explicitly does **not** hide the server-reflexive (STUN-discovered) public IP, which is the address that actually matters for the exposure described above ([mDNS ICE candidates background](https://bloggeek.me/psa-mdns-and-local-ice-candidates-are-coming/)). **mDNS candidate obfuscation is not relevant to this threat** — it protects against LAN-topology fingerprinting, not against a room member learning another room member's public IP via a forwarded connection.

**How to avoid:**
- Document explicitly (in the security/UX decision, not buried in code) that becoming a forwarder or a forwarder's child means your public IP becomes visible to that specific other room member — same category of exposure as any P2P voice/game, but new relative to *this app's* prior star behavior where only the broadcaster saw it.
- This project already retains TURN as a working fallback path outside this milestone's active scope (Out of Scope: "TURN_URL/USER/PASS continuam funcionando") — that remains the correct answer for any user who wants to opt out of direct IP exposure; nothing in this milestone should remove that escape hatch.
- Since room membership is gated by Discord OAuth + room password (PROJECT.md "Validated" list), the exposure is bounded to authenticated room members rather than the open internet — worth stating plainly since it meaningfully changes the risk profile versus an anonymous P2P app, but doesn't eliminate it (a malicious or compromised room member is still a real threat model for communities).

**Warning signs:** none technical — this is a disclosure/design gap, not a bug that throws an error. The warning sign is simply shipping the tree without anyone having explicitly decided whether users are told about it.

**Phase to address:** should be an explicit line item in the topology-ownership phase's acceptance criteria (R4), not left implicit — "does the room-list/UI communicate that repassing exposes your connection to your assigned children" is a yes/no decision this project's own Out of Scope list has *already* dodged once ("UI de 'você está repassando' — decidido invisível"); worth flagging that the invisibility decision and the IP-exposure decision are not the same decision and may deserve separate answers.

---

### Pitfall 10: Discord Activity sandbox specifics — the RTCPeerConnection escape hatch must be re-applied everywhere a new peer connection is created, and the Discord proxy does not protect WebRTC's own IP exposure

**What goes wrong, two distinct issues:**

1. **The escape hatch is per-call-site, not global.** PROJECT.md documents that inside the Activity sandbox `window.RTCPeerConnection` is `null`, and the app already found a working cascade (`webkitRTCPeerConnection` + a child iframe) via `construtorPeer` in `shared/broadcaster.js`. Adding forwarder-side peer connections (a viewer creating a *new* `RTCPeerConnection` to serve its own children, not just receiving one from the broadcaster) is new code that must route through that same `construtorPeer` cascade. It is easy for new code to call `new RTCPeerConnection()` directly out of habit — that will silently fail or throw inside the Activity, working fine in every non-Activity test (regular browser tab, `stg` accessed directly) and only breaking inside the real Discord client. This is exactly the kind of gap real-network testing (Pitfall 8) is needed to catch, since it's invisible in any test that doesn't run inside the actual Activity iframe.

2. **Discord's Activity Proxy hides your IP from *your own backend*, not from other WebRTC peers.** Discord's documented proxy model routes an Activity's HTTP/API network requests through Discord's infrastructure so "all requests appear to originate from Discord's infrastructure, preventing IP-based tracking" of the *server* by the client, or vice versa via HTTP ([Discord networking docs](https://discord.com/developers/docs/activities/development-guides/networking), [Discord Proxy overview](https://www.glorycloud.com/blog/discord-proxy/)). This is easy to misread as "Discord protects user IPs generally," but ICE candidate negotiation for a real `RTCPeerConnection` happens over UDP/STUN directly between peers, entirely outside the `/.proxy` HTTP-request path — Discord's proxy does not, and structurally cannot, hide a peer's public IP from another WebRTC peer it directly connects to. Pitfall 9's IP-exposure concern is fully present inside the Activity; the proxy is not a mitigation for it.

**Also worth checking, not yet verified either way:** whether `navigator.connection` (Pitfall 5) and other less-common Web APIs used by capacity/mobile-detection logic are available inside the sandboxed Activity iframe — sandboxed iframes commonly restrict APIs beyond just `RTCPeerConnection`, and this project already has one documented precedent (RTCPeerConnection itself) of an API being nulled out specifically in this environment. Don't assume other APIs survived just because RTCPeerConnection's replacement was already found.

3. **URL mapping requirement for any new external endpoint.** If the tree/topology work adds any new outbound HTTP call from the client (a new STUN/TURN host, a new admin-panel fetch target, etc.), Discord's CSP will block it (`blocked:csp`) unless it's registered as a URL mapping in the Activity's developer-portal config first ([embedded-app-sdk URL mappings](https://github.com/discord/embedded-app-sdk/blob/main/patch-url-mappings.md)). This project's tree design is scoped to reuse the existing WebSocket/RTCPeerConnection (PROJECT.md Constraints: "sem dependência nova de mídia"), so this is a lower-risk item than 1–2 above, but the admin-panel visibility requirement (R9) is exactly the kind of feature likely to introduce a new fetch target and should be checked against URL mappings specifically.

**How to avoid:** route every new `RTCPeerConnection` construction (forwarder-side included) through the existing `construtorPeer` cascade, never call the constructor directly in new code; explicitly test forwarder-role code inside the real Activity on `stg`, not just in a regular browser tab; treat Discord's proxy as irrelevant to the IP-exposure discussion in Pitfall 9; check any new fetch target against URL mappings before shipping R9.

**Warning signs:** a feature that works when accessed as a standalone site but fails silently or throws inside the actual Discord client; a new fetch call that works locally but fails with `blocked:csp` only in the Activity.

**Phase to address:** the topology-ownership phase (wherever forwarder-side `RTCPeerConnection` creation is implemented) and the admin-panel phase (R9) both need an explicit "verified inside Activity iframe on stg" checkbox, not just "verified in browser."

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|-----------------|------------------|
| Trusting `availableOutgoingBitrate` on first read after child connects | Simple admission check, ships fast | Overshoots fan-out during the ~30s bitrate ramp-in, drags children down together | Never for the admission decision itself; fine as one input among several with a probation window |
| Skipping the `broadcastState()` debounce fix for the tree milestone | Less code to touch this phase | A 10-person room's re-parent burst floods every socket, exactly when the room is already stressed | Never once re-parenting exists — this was already flagged as a known limitation even before the tree, and the tree is the workload that actually triggers it |
| Calling `new RTCPeerConnection()` directly in new forwarder code instead of `construtorPeer` | Faster to write, works in every non-Activity test | Silent failure inside the real Discord Activity, only caught by manual real-environment testing | Never — this app has exactly one place peer connections should be constructed |
| Using `navigator.connection.effectiveType` as a hard gate for forwarder eligibility | Looks like a clean pre-emptive filter | No iOS Safari support at all, coarse buckets elsewhere, false confidence | Acceptable only as a soft demotion signal alongside measured post-connection stats, never as the sole gate |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| `getStats()` / `availableOutgoingBitrate` | Reading once and trusting it as a hard ceiling | Poll repeatedly, require stability across intervals, corroborate with child-reported loss/RTT (R6) |
| Discord Activity sandbox | Constructing `RTCPeerConnection` directly in new forwarder code | Route through `construtorPeer`; test inside the real Activity, not just a browser tab |
| Discord Activity URL mappings | Adding a new fetch target (e.g. admin panel data source) without registering it | Register in developer portal before shipping, or it fails with `blocked:csp` only in production-like environments |
| Docker/headless test harnesses for WebRTC | Assuming Docker bridge networking reproduces symmetric-NAT behavior realistically | Explicitly use host networking for realistic NAT behavior, and still supplement with real cross-ISP manual tests — Docker networking is not a substitute for real NAT diversity |
| TURN (kept as fallback, not deployed per Out of Scope) | Assuming TURN failures/successes are uniform regardless of hop depth | Instrument (R11) TURN fallback rate broken out by tree depth, since depth-2 paths compound single-hop failure probability |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Full `broadcastState()` per viewer/topology event | Message-rate spikes correlated with churn, not with actual room size | Debounce/coalesce within ~50ms window; separate lightweight delta messages from full state | Already flagged at 50+ participants for the star; the tree's re-parent bursts can trigger it well before 50 people, even at the project's own 10-person target |
| Fan-out admission based on instantaneous capacity read | Correlated freezes across a forwarder's children | Probation window + hysteresis on admission, not just on demotion (R6 already covers demotion) | As soon as any forwarder accepts a 2nd or 3rd child during its own bitrate ramp-in window |
| Latency budget assumed rather than measured for depth-2 | Users report "laggy" at depth 2 with no clear root cause in telemetry | Measure real depth-2 latency in the spike before locking the depth cap | The moment depth-2 paths exist in production without this number having been measured first |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Assuming mDNS candidate obfuscation protects viewer IP privacy in the tree | False sense of security — mDNS only hides local/LAN candidates, not the public IP that matters | Don't cite mDNS as a mitigation for peer-to-peer IP exposure; the real IP exposure is via the server-reflexive candidate |
| Assuming Discord's Activity Proxy protects WebRTC peer IP exposure | Same false sense of security, Activity-specific | ICE/UDP negotiation bypasses the `/.proxy` HTTP path entirely; treat IP exposure inside the Activity exactly as if the app were not proxied |
| Not disclosing that becoming a forwarder exposes your IP to your assigned children | Room members unknowingly exposed to IP-based DDoS/geolocation risk from other room members, a documented attack pattern in P2P voice/game contexts | Explicit product decision (not just a code default) on whether/how to disclose this; keep TURN opt-out available regardless |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|--------------|-------------------|
| Bare black screen with no loading indicator during keyframe wait on join/re-parent | Users think the app is broken, not just waiting for a keyframe | Explicit loading/connecting state distinct from an error state, especially for the (slower) re-parent-at-depth-2 case |
| No visibility into "why did my stream just stutter" | Users blame the app for what may be an intentional, accepted re-parent blip (per this project's own Key Decision that stutter on re-parent is acceptable) | Admin panel (R9) surfaces this for operators; consider whether end users need any signal at all, or whether "accepted invisible" truly means invisible everywhere |

## "Looks Done But Isn't" Checklist

- [ ] **Fan-out capacity logic:** Often missing a stability/probation window on admission — verify it doesn't admit a new child purely off a single fresh `availableOutgoingBitrate` read taken during the bitrate ramp-in.
- [ ] **Re-parent flow:** Often missing an explicit forced keyframe request on attach — verify PLI is sent to the root broadcaster (not just the immediate parent) on every new child attach and every re-parent, and that this is measured at depth 2 specifically, not just depth 1.
- [ ] **`broadcastState()` under churn:** Often still calling full-state broadcast per individual re-parent event — verify a burst of 3-4 reassignments from one departure doesn't produce 3-4 separate full-room broadcasts.
- [ ] **New `RTCPeerConnection` call sites (forwarder-side):** Often bypassing the existing `construtorPeer` escape hatch — verify every new peer-connection construction site routes through it, and verify by testing inside the real Discord Activity on stg, not a regular browser tab.
- [ ] **Mobile/metered detection:** Often relying solely on `navigator.connection`, which silently does nothing on iOS Safari — verify a demotion path exists based on measured post-connection stats, independent of that API's availability.
- [ ] **TURN/IP-exposure disclosure:** Often shipped with no explicit decision recorded — verify whether the product intentionally decided to disclose (or not disclose) that forwarding exposes IPs to child viewers, rather than it being an unexamined side effect.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|----------------|------------------|
| Forwarder dragging children down (Pitfall 1) | LOW | R6's hysteresis-based demotion already provides the mechanism — ensure the demotion threshold triggers fast enough that "recovery" happens within a few seconds, not minutes |
| Orphan/control-plane storm (Pitfalls 2, 7) | MEDIUM | Add the debounce fix to `broadcastState()`; until then, recovery is "wait for the burst to settle," which is user-visible — treat as urgent, not deferred, cleanup |
| Black screen on re-parent worse than expected (Pitfall 3) | LOW | Force keyframe request to root broadcaster on every attach; this is a small, isolated code change once identified |
| Depth-2 latency turns out unacceptable (Pitfall 6) | HIGH | If the spike's measured number is bad, the fallback is reducing effective depth or biasing parent-selection (R5) away from long chains — architecturally cheap since depth is already capped at 2 by design, but a bad number here could force revisiting the whole "one hop" decision |
| Undisclosed IP exposure discovered post-launch (Pitfall 9) | MEDIUM | Retrofit disclosure UI/docs; TURN opt-out path already exists and doesn't need new engineering, just needs to be surfaced |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|--------------------|-----------------|
| 1. Capacity estimation overshoot | Capacity-aware fan-out phase (R1/R2) | Test: forwarder admits a child, then a 2nd child during ramp-in — verify no admission until stability window passes |
| 2. Churn/orphan/control-plane storm | Topology-ownership phase (R4/R7) + instrumentation (R10) | Test: kill one mid-tree forwarder in a 10-person room, count total broadcast messages sent in the following 2s |
| 3. Keyframe starvation compounding by depth | Topology-ownership phase (R4/R6) | Test: measure time-to-first-frame at depth 1 vs depth 2 on attach and on re-parent |
| 4. NAT/ICE compounding by hop count | TURN-instrumentation phase (R11) | Verify: connect-success telemetry sliced by depth, not just aggregate |
| 5. No reliable mobile-detection signal | Parent-selection phase (R5) | Verify: "celular" hard-cut logic doesn't rely solely on `navigator.connection`; demotion path exists independent of it |
| 6. Unmeasured per-hop latency | Pre-topology spike (already scoped in PROJECT.md) | Verify: a real number exists for depth-2 latency before depth=2 is locked as final |
| 7. Full-broadcast control-plane cost | Instrumentation phase (R10) + topology-ownership phase | Verify: messages-sent-per-departure metric exists and stays bounded under re-parent bursts |
| 8. Untestable-without-real-network gaps | Every phase touching `abrirPeer`/`escolherPai` | Verify: phase's verification checklist includes an explicit real-stg manual test, not just mocked unit tests |
| 9. New IP-exposure surface from forwarding | Topology-ownership phase (R4) | Verify: an explicit, recorded product decision exists on disclosure, distinct from the separate "invisible repasser role" decision |
| 10. Discord Activity sandbox specifics | Topology-ownership phase + admin-panel phase (R9) | Verify: forwarder-side peer creation tested inside the real Activity iframe on stg; any new fetch target checked against URL mappings |

## Sources

- [Making sense of getStats in WebRTC — BlogGeek.me](https://bloggeek.me/getstats/)
- [discuss-webrtc: googAvailableReceiveBandwidth / availableIncomingBitrate discussion](https://groups.google.com/g/discuss-webrtc/c/mhVV1GI_Gq8)
- [Bandwidth Estimation and Congestion Control in WebRTC — Forasoft](https://www.forasoft.com/learn/video-streaming/articles-streaming/webrtc-bandwidth-estimation)
- [P2P live video streaming in WebRTC — ResearchGate](https://www.researchgate.net/publication/286562014_P2P_live_video_streaming_in_WebRTC)
- [WebSocket Reconnection: State Sync and Recovery Guide — websocket.org](https://websocket.org/guides/reconnection/)
- [PLI in WebRTC: Picture Loss Indication & Keyframe Requests — BlogGeek.me](https://bloggeek.me/webrtcglossary/pli/)
- [Media Communication — WebRTC for the Curious](https://webrtcforthecurious.com/docs/06-media-communication/)
- [Real-time Networking — WebRTC for the Curious](https://webrtcforthecurious.com/docs/05-real-time-networking/)
- [Understanding WebRTC Latency — VideoSDK](https://www.videosdk.live/developer-hub/webrtc/webrtc-latency)
- [So I read that 20% of WebRTC calls fail… — Philipp Hancke](https://medium.com/@fippo/so-i-read-that-20-of-webrtc-calls-fail-67b185e49765)
- [STUN, TURN, and the Wall of Symmetric NAT in WebRTC — lazyharu.com](https://lazyharu.com/en/webrtc-nat-traversal/)
- [Challenging Tribal Knowledge — Large Scale Measurement Campaign on Decentralized NAT Traversal (arXiv)](https://arxiv.org/pdf/2510.27500)
- [PSA: mDNS and .local ICE candidates are coming — BlogGeek.me](https://bloggeek.me/psa-mdns-and-local-ice-candidates-are-coming/)
- [PSA: Private IP addresses exposed by WebRTC changing to mDNS hostnames — discuss-webrtc](https://groups.google.com/g/discuss-webrtc/c/6stQXi72BEU)
- [Network Information API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API)
- [WebRTC Security in 2025 — WebRTC.ventures](https://webrtc.ventures/2025/07/webrtc-security-in-2025-protocols-vulnerabilities-and-best-practices/)
- [Stealthy Peers: Understanding Security Risks of WebRTC-Based Peer-Assisted Video Streaming (arXiv)](https://arxiv.org/pdf/2212.02740)
- [Networking — Discord Developer Docs](https://discord.com/developers/docs/activities/development-guides/networking)
- [Discord Proxy: What It Means, How Discord Activities Use It — GloryCloud](https://www.glorycloud.com/blog/discord-proxy/)
- [embedded-app-sdk: patch-url-mappings.md — GitHub](https://github.com/discord/embedded-app-sdk/blob/main/patch-url-mappings.md)
- [docker-webrtc-test — GitHub](https://github.com/relekang/docker-webrtc-test)
- [webrtcperf — GitHub](https://github.com/vpalmisano/webrtcperf)
- [Cable Internet Stats 2026 — BroadbandSearch](https://www.broadbandsearch.net/blog/cable-internet-statistics)
- Internal: `.planning/PROJECT.md` (this milestone's requirements R1–R13, constraints, key decisions)
- Internal: `.planning/codebase/CONCERNS.md` (existing fan-out cap gap, `broadcastState()` O(N×M) issue, `P2P_ONLY` behavior, test coverage gaps)

---
*Pitfalls research for: peer-assisted WebRTC tree distribution (Discord Activity screen-sharing app)*
*Researched: 2026-08-20*
