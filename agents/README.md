# Retained agent artifacts

Committed agent outputs belong under `/agents/` only when they remain useful after the task that produced them. Use the path that matches the artifact:

- `agents/plans/<slug>.md` — implementation plans and their execution records.
- `agents/research/<slug>/` — research notes, audits, proofs, and supporting evidence.
- `agents/handover/<slug>.md` — handover memos for work that another agent must continue.

Before using or adding a retained artifact, check this index and the artifact's own status. Deleted historical artifacts are not implementation guidance. `agents/plans/open-followups.md` is the live checklist of still-open or deferred work; a plan may be implemented while items from it remain on that checklist.

## Current inventory

Statuses below are the statuses recorded in the artifacts themselves.

At the maintainer's requested root path, [claudeville-astra-refinement-plan.md](claudeville-astra-refinement-plan.md) has status `release-verified for v0.42.0`: the v0.41.3 review and all 21 refinement items, with final graphics, provider, desktop, persistence and performance evidence. The original advanced experiments remain conditional; the 10-minute browser and 30-minute server release checks are recorded for v0.42.0.

### Plans

| Artifact | Status | Purpose |
| --- | --- | --- |
| [`plans/claudeville-agentic-dx-plan.md`](plans/claudeville-agentic-dx-plan.md) | `implemented as v0.40.0` | Agentic development experience plan (*The Scriptorium*): six cross-item contracts and 23 items across four waves against `v0.39.1` — CI repair and doc-contract hotfixes, a canonical model registry with a generated browser module plus `add-model`/`add-provider` skills, agent-runnable verification (isolated render smoke, executable architecture/server checks, payload contract), and hooks, release toolchain, artifact checks, and a sprite skill. Consolidates the six Sol reviews under `research/claudeville-agentic-dx-review/`. |
| [`plans/claudeville-comprehensive-remediation-plan.md`](plans/claudeville-comprehensive-remediation-plan.md) | `implemented and verified` | Comprehensive remediation plan and verification record. |
| [`plans/claudeville-council-enchantment-plan.md`](plans/claudeville-council-enchantment-plan.md) | `shipped as v0.36.0` | Council of Six enchantment plan: 15 consolidated items, cross-item contracts, and wave sequencing against `v0.35.0.1`. Note: `CHANGELOG.md` records its items as shipped in `v0.36.0`; the artifact header was stale and is now corrected (see the Fable 5.1 plan, item 0.6). |
| [`plans/claudeville-fable-5.1-enhancement-implementation-plan.md`](plans/claudeville-fable-5.1-enhancement-implementation-plan.md) | `implemented and release-verified` | Fable 5.1 enhancement plan (*The Commander's Map*): five cross-item contracts and 29 items across five waves against `v0.37.0` — truth hotfixes (pricing, identity, cold scans, overlays), operator signal (provider-reported cost, turn timing, working set, hook ingestion), GPU-path light delivery (ladder, parity, attention lights, labels), and the chrome as an instrument. The 24 Waves 0-3 items shipped in `v0.38.0`; the 5 Wave 4 items shipped in `v0.39.0` (the generated distant-shore band was built and cut on maintainer review). |
| [`plans/claudeville-frontier-visual-plan.md`](plans/claudeville-frontier-visual-plan.md) | `implemented (Waves 0–5); 2.7 rollout and 3.3 pending measurement` | Frontier visual plan (*The Open Door*): six cross-item contracts and 36 items across six waves against `v0.44.0` — measurement instruments and asset provenance, truth-on-the-body and a calmer frame, authored action poses piloted on two characters, palette-safe light that belongs to the architecture, a selected-building interior aperture with Mine/Forge instruments, and an explicit Ambient broadcast with a shared audio-visual score. Consolidates the ten explorations under `research/claudeville-frontier-visual/`. Waves 0–1 shipped in `e2bc046`, Waves 2–5 in `b072261`; the execution record lists per-item deviations, and the maintainer decisions and open items (roster rollout, window-spill receipt) are tracked in the plan and `open-followups.md`. |
| [`plans/claudeville-opus5-improvement-plan.md`](plans/claudeville-opus5-improvement-plan.md) | `executed` | Opus 5 improvement plan, round assignments, execution record, and Wave 4 research verdicts. Its header formerly read `proposed — not started`; that was stale and was corrected 2026-08-30. |
| [`plans/claudeville-post-oom-reliability-performance-plan.md`](plans/claudeville-post-oom-reliability-performance-plan.md) | `implemented and release-verified` | Post-OOM reliability and performance plan. |
| [`plans/claudeville-semantic-diorama-rendering-plan.md`](plans/claudeville-semantic-diorama-rendering-plan.md) | `implemented and release-verified for v0.33.0` | Semantic diorama rendering plan and release record. |
| [`plans/nfs-5.md`](plans/nfs-5.md) | `implemented and verified` | NFS-5 performance plan and implementation record, backed by seven measured investigations. |
| [`plans/open-followups.md`](plans/open-followups.md) | `live checklist` | Active ledger of open, deferred, conditional, and already-landed follow-ups. |

### Research

| Artifact | Status | Purpose |
| --- | --- | --- |
| [`research/claudeville-astra-refinement/`](research/claudeville-astra-refinement/) | `ready` | Full refinement execution evidence: authored material/foliage review, crowd/occlusion captures, motion and keyboard probes, same-host profiles, and final validation. |
| [`research/claudeville-comprehensive-verification/`](research/claudeville-comprehensive-verification/) | `ready` | Comprehensive verification audit and evidence index. |
| [`research/claudeville-fable-5.1-review/`](research/claudeville-fable-5.1-review/) | `ready` | Evidence for the Fable 5.1 plan: four read-only reviews (`rendering-review.md`, `ui-review.md`, `signal-review.md`, `sol-outside-review.md`), the GPU quality-ladder timeline and probe script, and eight reference captures under `shots/`. |
| [`research/claudeville-agentic-dx-review/`](research/claudeville-agentic-dx-review/) | `ready` | Evidence for the agentic-DX plan: six read-only Codex Sol reviews over disjoint territories — model-addition surface, agent-doc accuracy, skills/hooks/CI, verification tooling, release and artifacts, sprite/PixelLab workflow. |
| [`research/claudeville-frontier-visual/`](research/claudeville-frontier-visual/) | `ready` | Evidence for the frontier visual plan: ten independent read-only explorations (light, characters, buildings, signal mapping, camera, chrome, effects/audio, outside eye with 2025–2026 technique citations, measured performance envelope, asset pipeline and PixelLab economics), 71 real-GPU captures under `shots/`, and the reusable capture helper under `tools/`. |
| [`research/nfs-5/`](research/nfs-5/) | `ready` | Seven measured investigations supporting the NFS-5 performance plan. |

There are currently no handover memos under `agents/handover/`. The checkout also contains `agents/.DS_Store`, which is macOS directory metadata, not a retained agent artifact and has no project status.
