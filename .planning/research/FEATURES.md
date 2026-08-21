# Feature Research: Peer-Assisted Tree Distribution of Live Video

**Domain:** Peer-assisted (P2P) live video delivery — single-hop forwarding tree over WebRTC, browser-only
**Researched:** 2026-08-20
**Confidence:** MEDIUM (mostly LOW-confidence web/blog sources cross-checked against each other and against one MEDIUM-confidence security paper and one well-documented incident; treat specific numbers as indicative, not authoritative)

**Scope note:** This milestone already has a validated star topology (relay + direct WebRTC) and a fixed requirement list (R1–R13) in PROJECT.md. This document does not re-derive requirements — it checks the domain's real-world practice against them, flags where the project's own decisions already match consensus, and flags where they diverge or where literature disagrees with production practice.

## Feature Landscape

### Table Stakes (a production peer-assisted system always has these)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Non-P2P fallback path that is always live, not toggled on failure | Every production/OSS system surveyed keeps the non-P2P path warm at all times, not as an error handler. p2p-media-loader fetches every segment over HTTP first and falls back to HTTP for any segment no peer has; Streamroot's whitepaper says it "automatically switches back to the origin/CDN server, guaranteeing at the very least the same quality of service as a CDN-only solution"; Peer5's signaling layer has the CDN edge always serve the first 2–4s cold-start window plus any gap before a chunk's playout deadline | MEDIUM | Maps to R7/R1. Confirms the project's own decision ("relay permanece como camada de baixo, sempre") is the industry-standard shape, not a hedge — the relay is not a fallback bolted onto P2P, it is a parallel always-warm layer that P2P offloads from. |
| Fan-out / capacity cap derived from measured bandwidth, not a constant | fybrrStream (WebRTC P2P live streaming, arXiv 2105.07558) computes `slots_P = upload_bandwidth_P / streaming_rate` per peer, i.e. capacity is measured, not configured; Peer5's topology map is explicitly built from measured RTT/ASN/geography rather than assumed values | MEDIUM | Maps to R1/R2. Validates the project's Key Decision "capacidade medida, nunca chutada" against a disclosed production formula, not just intuition. |
| Server/tracker-owned topology; child never picks its own parent | fybrrStream's tracker/server assigns the parent on join and reassigns on parent departure — the peer never negotiates its own placement. More broadly, every filter-then-score scheduler pattern (Kubernetes, OpenStack, OpenNebula schedulers) keeps placement authority on the control plane, not the workload, for the same reason: client-chosen placement can create constraint violations (here: cycles) that a central authority can prevent by construction | MEDIUM | Maps to R4. No P2P streaming source surveyed described client-chosen parents in a production/serious-academic system — this is a genuinely universal constraint, not a project-specific caution. |
| Orphan re-adoption path when a parent disappears | fybrrStream: orphaned children immediately open **auxiliary connections to siblings or the grandparent** while the server computes a permanent new parent. Academic literature (P2P live streaming surveys) documents the same shape under two names: **Backup Parents Table (BPT)** — each peer caches its parent's parent and sibling info supplied during the join handshake, so recovery is local, not a fresh search — and **backup links** between a parent's children and the parent's siblings' children | MEDIUM–HIGH | Maps to R4/R7. The project's simpler answer — orphan drops straight to the always-warm relay while the server recomputes — is a legitimate, simpler substitute for BPT/backup-links; it trades "peer-to-peer during the gap" for "guaranteed correctness during the gap," which is the right trade at n≤10. |
| Loop prevention | No source surveyed described an explicit cycle-detection algorithm. The consistent answer across every source is structural: single parent per node, server-assigned, so a cycle cannot form by construction | LOW (once table-stakes item above exists) | Maps to R4. This means loop prevention is not a separate feature to build — it is a free consequence of "server owns topology + single parent," and should not be over-engineered as its own detection system. |
| Sub-second recovery window during re-topology, not a visible outage | Streamroot's automatic CDN failover and Peer5's gap-filling both exist specifically so a topology recompute never shows as a stall; academic BPT/backup-link mechanisms exist for the same reason in the absence of a CDN | MEDIUM | Maps to R7. The project's target ("órfão volta ao relay em menos de um segundo") is consistent with what production systems actually guarantee — none of them promise the *peer* path resumes instantly, only that *some* path does. |
| Keyframe delivery to a newly-attached receiver | Not separately documented in the P2P-tree literature surveyed (it's usually assumed as a codec-layer concern, not a topology concern) | LOW (already exists) | The project's relay already implements keyframe-on-demand; this is inherited unchanged when a forwarding peer gains a new child — no new research needed here, it is a track-forwarding correctness property, not a topology-selection one. Flag for the execution phase to verify explicitly under R3, not this document. |

### Differentiators (this project can reasonably compete/excel on)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Explicit multi-factor weighted parent score (ASN → RTT band → headroom → room tenure → measured RTT), with hard gates evaluated first | Production whitepapers (Streamroot, Peer5) only ever disclose "geographic and topological criteria" or "measured RTT/ASN" as a black box — they do not publish an actual formula. The one source with a disclosed formula, fybrrStream, uses a flat weighted sum with no gating phase: `Score = k1·(upload/rate) + k2·(1/latency) + k3·(tenure/failures)`. The project's design — hard gates (capacity, mobile, depth) *then* a weighted score — matches the "filter, then score" pattern used by production schedulers (Kubernetes: binary filter phase excludes infeasible nodes, then a normalized weighted-score phase ranks survivors) more closely than it matches any P2P-streaming-specific precedent | HIGH | Maps to R5. This is a genuine differentiator: no P2P-video source surveyed separates hard eligibility from soft scoring the way the project's `escolherPai` is designed to. The Kubernetes-style precedent is cross-domain but directly validates the two-phase shape as sound engineering, not an invented complication. |
| Re-parenting with hysteresis tuned to avoid oscillation | Academic literature confirms the *concept* — a peer switches parent only when a candidate offers materially lower delay than the current parent, and a "POOR parent" is flagged and a replacement secured *before* the old parent is dropped (secure-new-before-drop ordering, itself a form of anti-flap protection) — but does not publish concrete thresholds. No production system surveyed discloses its re-parent thresholds either | MEDIUM | Maps to R6. The project already has a working hysteresis precedent in the encoder backpressure logic; reusing that philosophy (only switch when gain clearly exceeds cost, never on a bare threshold crossing) is consistent with both the academic pattern and the project's own prior art — a differentiator mainly because it's a designed, tested control loop rather than an ungated `if betterParent: switch()`. |
| Live admin-visible tree (who's parent of whom, capacity, RTT, last swap reason) | No consumer-facing production system surveyed (Peer5, Streamroot, Hive) publicly documents an operator-facing topology debug view — this is exactly the gap academic tooling like P2PStudio ("Monitoring, controlling and visualization tool for peer-to-peer networks research") exists to fill, and P2PStudio itself notes that getting a *global* view of a live P2P network is hard because not all peers are reachable/inspectable from outside. This project has a structural advantage the papers don't: the server already owns the whole topology (table stakes above), so a global view is just reading server state, not crawling a swarm | LOW–MEDIUM | Maps to R9. Cheap relative to academic P2P monitoring specifically *because* this project chose server-owned topology — that decision pays off twice. |
| Bandwidth instrumentation (GB/hour, % direct, transmitter peak upload) exposed to the operator | Peer5's own economics threshold (P2P offload "negligible" below ~500 CCU, "compelling" above ~5,000 CCU) and Streamroot's threshold (needs <100 simultaneous viewers to clear 30% P2P share on long-form content) are exactly the kind of number this instrumentation would let the project compute for itself instead of assuming from a vendor's published thresholds, which don't transfer to a 3–10 person Discord room with a single transmitter | LOW | Maps to R10. Differentiator less because it's technically novel and more because none of the production systems studied publish per-deployment economics — building the instrumentation in gives an evidence base competitors' operators don't have, and directly answers the project's own trigger ("100 GB em poucas horas"). |
| TURN cost instrumentation before any TURN deployment decision | Not found as a named pattern in any source, but it is the direct generalization of the CDN-threshold pattern above (measure before you commit infrastructure spend) | LOW | Maps to R11. Not a "P2P" feature per se — a general "measure before you build" discipline the project is already applying elsewhere (measured capacity vs. chutada), applied here to a currently-out-of-scope layer. |

### Anti-Features (things this domain has deliberately not built, or has built and regretted)

| Feature | Why Requested | Why Problematic | Alternative / What Sources Actually Do |
|---------|---------------|------------------|-----------------------------------------|
| Deep / arbitrary-depth trees | Looks more "scalable" — deeper trees serve more viewers per unit of root upload | Every survey source agrees tree topologies are structurally efficient but fragile to failure, and that fragility (cascading orphan events, accumulated per-hop latency, harder debugging) scales with depth, not fan-out. This is the literature's clearest point of consensus | Cap depth at 1 hop. The project has already made this call (Out of Scope: "árvore de profundidade arbitrária"); the research supports it rather than contradicting it — fan-out 3–4 at depth 1 covers 12–20 viewers, well past the target of 10 |
| Full mesh / pull-based multi-parent chunk exchange (BitTorrent-style, or academic mesh-pull) | Academic comparisons (Magharei & Rejaie, "Mesh or Multiple-Tree," INFOCOM 2007, and the broader mesh-vs-tree survey literature) report mesh-pull outperforming simple tree-push under churn at swarm scale | The coordination overhead (piece/chunk bookkeeping, multi-parent negotiation, buffer maps) that makes mesh win at scale is pure cost with no benefit at n≤10 — Streamroot itself needs ~100 concurrent viewers before P2P clears 30% of traffic on long content, i.e. mesh-style systems are calibrated for audiences an order of magnitude larger than this project's target | Stay with a single-parent tree; mesh's advantages don't activate until the peer pool is much larger than a 10-person watch party. This is consistent with the project's existing choice, not something newly discovered, but the literature explains *why* it doesn't apply here rather than just asserting it |
| Seamless / glitch-free handover on re-parent | Sounds like a UX requirement ("a stream that never blinks") | No production or academic source surveyed claims zero-glitch reparenting. Every mechanism found (CDN gap-fill, BPT, backup links, temporary-parent-then-permanent-parent) accepts a bounded visible gap and optimizes its *length*, not its *existence*. Chasing true seamlessness (cross-fade buffering, dual-decode overlap) is a cost center literature doesn't pay either | Bound and shrink the gap (target: sub-second via relay fallback), don't eliminate it. Matches the project's own decision to accept "travadinha ou loading" on switch |
| Client-chosen parent, or any negotiation where the peer picks who it connects to | Feels more "P2P-native" / decentralized, and avoids a central coordination bottleneck | Universally rejected across every credible production and academic source surveyed, for one consistent reason: client-side choice can create a cycle (or, in scheduler terms, a constraint violation) that only a central authority can prevent by construction. This is the single most consistent finding across the whole research pass | Server/tracker assigns; peer accepts. Matches R4 exactly — no counter-evidence found anywhere in the domain |
| Treating "invisible to the viewer" as equivalent to "undisclosed if asked / unaccountable" | Simpler UI, no consent flow to build or maintain | This is a process anti-pattern, not a UI one, and the domain has a real cautionary tale for it: Hola VPN's sister company Luminati resold access to Hola's own users' machines as paid exit nodes without disclosing this clearly; when a researcher traced botnet-grade abuse (DDoS, spam, illegal content) back to unwitting Hola users, the backlash was immediate and reputational, and the founder later admitted they "failed to make it clear enough." The lesson generalizes even though Hola's abuse was categorically worse than relaying a screen-share: undisclosed use of a user's uplink for someone else's benefit is what triggers backlash *once discovered independently*, regardless of how legitimate the underlying use is | The project's actual decision — invisible UI, but the "papel de repassador" is disclosed in principle as ordinary P2P behavior everyone in the room implicitly consents to (a friend's stream reaching a friend through you), not resold or exposed to any third party, and never leaves the room — is the defensible version of "invisible." The anti-feature to avoid isn't invisibility, it's silence *combined with* leaving the room boundary, which the project isn't doing. No production P2P video vendor surveyed (Streamroot, Peer5) publishes user-facing consent language either, so the project is not an outlier here — but Hola is the reference point for what "outlier in the bad direction" looks like |

**Where literature disagrees with production practice:** Academic P2P streaming papers spend most of their effort on multi-tree/mesh robustness mechanisms (BPT, backup links, POOR-parent replacement, multi-tree construction) that assume large, uncoordinated swarms without a central always-on fallback. Production browser-based systems (Peer5, Streamroot, p2p-media-loader) largely sidestep that whole research area by keeping a CDN/relay permanently warm underneath — which is a strictly stronger guarantee than anything the academic recovery mechanisms provide, achieved with far less protocol complexity. This project's architecture (relay always underneath, server-owned single-parent tree, orphan drops straight to relay) sides with production practice over academic completeness, and the research supports that choice rather than flagging it as a shortcut.

## Feature Dependencies

```
Non-P2P fallback path (table stakes)
    └──required-by──> Capacity cap / fan-out limit (table stakes)
                           (a cap without a live fallback produces black screens, not offload)
    └──required-by──> Orphan re-adoption (table stakes)
                           (orphan's immediate safety net while server recomputes)

Server-owned topology, single parent (table stakes)
    └──enables (by construction)──> Loop prevention (table stakes)
    └──required-by──> Admin-visible tree (differentiator)
                           (global view is just reading server state, not crawling a swarm)

Measured capacity (table stakes)
    └──required-by──> Weighted parent score (differentiator)
                           (headroom/RTT/ASN score needs a measured input, not a constant)

Weighted parent score (differentiator)
    └──required-by──> Re-parenting with hysteresis (differentiator)
                           (hysteresis needs a comparable score to gate against, not just a raw metric)

Bandwidth instrumentation (differentiator) ──independent of the tree──> validates whether
    fallback + capacity cap are actually reducing GB/hour, i.e. it's the acceptance test
    for table-stakes items 1–2, not merely an add-on

TURN instrumentation (differentiator) ──conflicts-with──> deploying TURN itself
    (explicitly out of scope this milestone: measure first, decide later)
```

### Dependency Notes

- **Capacity cap requires the fallback path:** every production source treats the CDN/relay as always-warm, never as an error handler wired up after the fact. Building the cap before the fallback is provably solid inverts the dependency order every system surveyed uses.
- **Weighted score requires measured capacity:** fybrrStream's formula and Peer5's topology map both take measured bandwidth/RTT as an input, not a constant — a "dumb" boba parent-selection function (already the project's own stated first step) can ship before this, but the *weighted* version cannot precede measurement.
- **Hysteresis requires a score to compare, not a raw metric:** the academic "POOR parent" pattern and the project's own encoder-backpressure precedent both gate on a comparison (candidate clearly better than incumbent), which presupposes a comparable score already exists.
- **Admin visibility is cheap because of server-owned topology:** this is a case where two requirements reinforce each other rather than compete — the same architectural choice (R4) that prevents loops also makes R9 nearly free, unlike academic P2P monitoring tools which fight to get a global view precisely because their systems *don't* have a central authority.

## MVP Definition

This milestone's requirements list (R1–R13) already fixes scope; the useful MVP question here is which *behaviors* within that list are load-bearing from the first tree deployment vs. safe to layer in after.

### Non-negotiable from the first tree deployment

- [ ] Always-warm relay fallback (R7) — every production/academic source treats this as the precondition for everything else, not an afterthought
- [ ] Fan-out cap with overflow to relay (R1) — without this the tree provides no bandwidth benefit and can make things worse (an oversubscribed forwarding peer drags its children down, per the project's own Key Decision)
- [ ] Server-owned topology, single parent, no client choice (R4) — universal across every source; this is also what makes loop prevention free
- [ ] Track forwarding without decode/recode (R3) — the project's own "peça que decide tudo"; if this doesn't hold, no other item in this document is buildable

### Add once the above is proven (v1.x)

- [ ] Measured capacity replacing a constant fan-out (R2) — dumb-then-smart is explicitly the project's own sequencing decision, and matches how fybrrStream's design separates capacity accounting from scoring
- [ ] Weighted, gated parent selection (R5) — the two-phase filter-then-score shape is worth building once there's a population of real candidates to select among; a boba (round-robin/first-fit) selector is adequate before that
- [ ] Re-parenting with hysteresis (R6) — depends on R5 existing first; premature without a score to compare against
- [ ] Admin tree visibility (R9) and bandwidth instrumentation (R10) — these are the operator feedback loop that validates whether R1/R2/R5/R6 are working; sequence them right after the mechanics they're meant to observe, not at the very end

### Explicitly deferred, and the research agrees

- [ ] TURN deployment (only instrument, per R11) — no source surveyed suggests deploying relay-equivalent infrastructure (TURN) is urgent when a working relay already exists; measure the gap first
- [ ] Deep trees / mesh topology / seamless handover / client-chosen parent — see Anti-Features; the domain has already tried these paths at larger scale and the tradeoffs don't clear at n≤10

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Always-warm relay fallback (R7) | HIGH | LOW (mostly already exists) | P1 |
| Track forwarding, no decode/recode (R3) | HIGH (blocking — proves the whole approach) | MEDIUM–HIGH (unproven) | P1 |
| Fan-out cap + overflow (R1) | HIGH | MEDIUM | P1 |
| Server-owned topology, no client choice, orphan adoption (R4) | HIGH | MEDIUM | P1 |
| Measured capacity (R2) | MEDIUM–HIGH | MEDIUM | P2 |
| Weighted gated parent selection (R5) | MEDIUM | HIGH | P2 |
| Re-parenting with hysteresis (R6) | MEDIUM | MEDIUM–HIGH | P2 |
| Admin tree visibility (R9) | MEDIUM (operator-facing, not viewer-facing) | LOW–MEDIUM | P2 |
| Bandwidth instrumentation (R10) | HIGH (this is the success metric itself) | LOW | P1–P2 |
| TURN instrumentation (R11) | LOW (measurement only, decision deferred) | LOW | P3 |

**Priority key:**
- P1: Load-bearing — the tree does not safely exist without these
- P2: Needed for the tree to be *good*, not merely safe
- P3: Deferred measurement, not a launch blocker

## Competitor / Prior-Art Feature Analysis

| Feature | Peer5 / Streamroot (commercial, browser-based) | fybrrStream / academic (WebRTC research) | This Project's Approach |
|---------|--------------------------------------------------|-------------------------------------------|--------------------------|
| Fallback | CDN edge, always-warm, per-segment or gap-fill | Assumed reliable overlay, less emphasis on a non-P2P floor | Relay, always-warm, same shape as commercial systems — a better fit here than academic assumptions since a relay already exists |
| Capacity input | Measured RTT/ASN/topology (method undisclosed) | Disclosed formula: `slots = upload_bw / stream_rate` | `availableOutgoingBitrate`-derived, shrinks on measured child loss — closer to fybrrStream's transparency than to the commercial black boxes |
| Parent selection | "Geographic and topological criteria" (undisclosed detail) | Flat weighted sum, no gating phase | Two-phase: hard gates first, then weighted score — matches general scheduler pattern (Kubernetes) more than either P2P-specific precedent |
| Re-parenting | Not disclosed | Delay-triggered switch, "POOR parent" secure-before-drop | Hysteresis reusing the project's own existing encoder-backpressure pattern |
| Operator visibility | Not publicly documented | Academic tooling exists (P2PStudio) precisely because it's hard without central topology ownership | Cheap here because topology is already server-owned (R4 pays for R9) |
| Viewer disclosure | None found (Streamroot whitepaper has zero consent language) | Not a topic academic papers address | Invisible UI, but not silent-and-boundary-crossing (see Hola VPN anti-feature) — the project's stance is consistent with commercial practice, with an explicit boundary commercial vendors don't bother stating |

## Sources

Confidence tiers below reflect `gsd-tools query classify-confidence` output for the provider used (websearch/webfetch, both baseline LOW; MEDIUM where a claim was cross-checked across ≥2 independent search results).

- **[MEDIUM]** Tang, Alowaisheq, Mi, Chen, Dou — "Stealthy Peers: Understanding Security Risks of WebRTC-Based Peer-Assisted Video Streaming," arXiv:2212.02740 (also published as DSN 2024, "Stealthy Peers: Understanding Security and Privacy Risks of Peer-Assisted Video Streaming") — https://arxiv.org/abs/2212.02740 — first security study of production PDN/P2P-CDN providers; found 3 major providers serving 134 websites + 38 mobile apps, reports PDNs offload up to 95% of bandwidth, documents free-riding, segment pollution, viewer IP exposure to other peers, and resource squatting as the real risk categories (not the specific company-backlash claims an earlier low-quality fetch attributed to this paper, which could not be corroborated and were discarded)
- **[MEDIUM]** Hola VPN / Luminati bandwidth-reselling incident (2015) — https://www.pcworld.com/article/427726/, https://en.wikipedia.org/wiki/Hola_(VPN), https://www.techradar.com/news/networking/-hola-if-your-vpn-was-busted-selling-your-bandwidth-for-botnets-1295421 — cross-checked across multiple independent outlets; canonical case of undisclosed reuse of user upload capacity causing public backlash once discovered independently
- **[MEDIUM]** p2p-media-loader (Novage / Chocobozzz fork) — https://github.com/Novage/p2p-media-loader, https://github.com/Novage/p2p-media-loader/blob/main/FAQ.md — open-source, browser HLS/DASH P2P engine; confirms always-HTTP-first, P2P-as-overlay design and small-deployment (1,000–2,000 CCU) viability with zero extra infra
- **[LOW]** fybrrStream — arXiv:2105.07558, "fybrrStream: A WebRTC based Efficient and Scalable P2P Live Streaming Platform" — https://arxiv.org/pdf/2105.07558 — only source surveyed with a disclosed parent-selection formula and slot/capacity formula; single-source, not independently corroborated, treat formula as illustrative not authoritative
- **[LOW]** Peer5 (now folded into Microsoft eCDN for Teams) — https://blog.peer5.com/peer-to-peer-the-multi-cdn-approach/, https://docs.peer5.com/faq/ — architecture description and CCU thresholds via secondary blog sources, not Peer5 primary technical documentation (service is defunct as of 2025)
- **[LOW]** Streamroot whitepaper — https://www.slideshare.net/ssuser6b4faa/streamroot-whitepaper-peer-assisted-adaptive-streaming — vendor whitepaper, self-reported thresholds and behavior, no independent verification
- **[LOW]** Hive Streaming — https://www.hivestreaming.com/products/ecdn, https://learn.microsoft.com/en-us/microsoftteams/streaming-ecdn-enterprise-content-delivery-network — vendor material; enterprise/LAN-contained eCDN model, self-reported 99% WAN savings figure
- **[LOW]** LiveSky, Kankan, PPLive (Chinese hybrid CDN-P2P systems) — https://www.researchgate.net/publication/220214430_LiveSky_enhancing_CDN_with_P2P, https://www.researchgate.net/publication/273161823_Unreeling_Xunlei_Kankan — secondary summaries of primary papers, not the primary papers themselves
- **[LOW]** BitTorrent-family peer/churn handling — general knowledge cross-checked against multiple ResearchGate/arXiv summaries of BitTorrent streaming adaptations (e.g. https://arxiv.org/pdf/1310.2166, https://arxiv.org/pdf/1402.2187) — no single authoritative primary source for "BitTorrent Live" specifically (BitTorrent Inc.'s "BitTorrent Live" product had limited public technical documentation)
- **[LOW]** Backup Parents Table (BPT), POOR-parent replacement, backup-link, multi-tree recovery patterns — general P2P live streaming survey literature (e.g. https://www.diva-portal.org/smash/get/diva2:310089/FULLTEXT02, review/survey papers found via search); pattern descriptions synthesized across multiple non-primary summaries, not read from one canonical source
- **[LOW]** Magharei, Rejaie, Guo — "Mesh or Multiple-Tree: A Comparative Study of Live P2P Streaming Approaches," INFOCOM 2007 — http://mirage.cs.uoregon.edu/pub/infocom07-treemesh.pdf — full text not machine-readable in this pass (PDF extraction failed); finding ("mesh-based systems more efficient than tree-based") taken from secondary description of the paper's abstract/contribution, treat as directionally correct but not independently verified against the primary text
- **[LOW]** P2PStudio — "Monitoring, controlling and visualization tool for peer-to-peer networks research," https://www.researchgate.net/publication/221454022 — cited to support the claim that operator/global visibility into a live P2P network is a known-hard, separately-tooled problem in the academic world, contrasted with this project's server-owned-topology advantage
- **[MEDIUM]** Filter-then-score scheduler pattern (Kubernetes/OpenStack/OpenNebula) — https://khimananda.com/blog/the-kubernetes-scheduler-explained, https://learnkube.com/kubernetes-scheduler-explained, https://blog.kubesimplify.com/kube-scheduler-deep-dive — cross-domain (not P2P-video-specific), cross-checked across multiple independent write-ups of the same well-documented, widely-deployed pattern; used here only to validate the *shape* of R5 (hard gates then weighted score) against established distributed-systems practice, not as a P2P-streaming source
- **Explicitly discarded/unverified:** a claim surfaced once that "~30% of viewers opt in" and "several EU broadcasters required explicit P2P opt-in in late 2025" could not be traced to any primary source in this research pass and is not used anywhere above — flagged here so it is not accidentally treated as fact downstream

---
*Feature research for: peer-assisted tree distribution of live video (WebRTC, browser-only, single-hop)*
*Researched: 2026-08-20*
