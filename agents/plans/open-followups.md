# Open follow-ups

**Status:** `live checklist`

**As of:** 2026-09-06, release `v0.45.0` — The Open Door

This is the active ledger for deferred work extracted from completed plans. A
source plan can remain `implemented` or `release-verified`; an item belongs
here only when that plan explicitly retained it or gave it a conditional
revisit trigger. The original audit checklists are evidence/specification, not
an additional source of open work.

`[ ]` means open/deferred until its trigger is observed. `[x]` means the
relevant work is already implemented and must not be carried forward as open.

## Artifact-policy note

The repository instructions reference this `agents/README.md` index. It follows
the existing retained-artifact convention of `agents/plans/<slug>.md` and is
linked from each source plan below.

## Open / deferred

- [ ] **Async stale-while-revalidate Git worker / bounded async Git refresh**

  - **ID:** `OF-001`
  - **Added:** 2026-07-26
  - **Last reviewed:** 2026-09-02
  - **Trigger:** Git timeouts, user-visible stalls, cold/change enrichment above 50 ms p95, Git in broadcast p95, or Git commands during an unchanged warm run.
  - **Source:** [comprehensive remediation plan — CV-PERF-003](claudeville-comprehensive-remediation-plan.md#package-9--small-cleanup-and-explicit-deferrals) and [post-OOM plan — retained follow-ups](claudeville-post-oom-reliability-performance-plan.md#retained-follow-ups).
  - **Reopen when, from the comprehensive plan:** post-Package-8 runtime measurements show Git timeouts or sustained user-visible event-loop/broadcast stalls. The execution record restates this as isolated timeouts or user-visible stalls reproducing.
  - **Reopen when, from the post-OOM plan:** cold/change Git enrichment exceeds **50 ms p95**, Git appears in broadcast p95, or an unchanged warm run launches any Git command.
  - **Current status:** Partially closed. The bounded async stale-while-revalidate worker **is now implemented** in `claudeville/adapters/gitEvents.js` (2 concurrent jobs, 32-deep queue with shedding, request coalescing, 750 ms subprocess timeout, 256 KiB output cap, 1 s–30 s retry backoff, telemetry at `/api/perf` under `gitWorker`). Two synchronous paths remain and are the residual work: `claudeville/adapters/index.js:210-216` (`execFileSync('git', …)`, which was outside the implementing task's file ownership) and the fallback at `claudeville/adapters/gitEvents.js:1656`. Close this item once those two are migrated or explicitly justified as safe.
  - **Current measurement:** recorded cold enrichment was **17.02 ms / 4 commands** and unchanged warm enrichment **0.34 ms / 0 commands**; the comprehensive release gate recorded steady Git activity at **2.50 commands/second** and event-loop p95 at **22.9 ms or below**. No listed trigger is currently evidenced.

- [ ] **Provider/model lazy asset loading**

  - **ID:** `OF-002`
  - **Added:** 2026-07-26
  - **Last reviewed:** 2026-09-02
  - **Trigger:** Cold readiness exceeds 2 seconds or memory pressure is reproduced.
  - **Source:** [comprehensive remediation plan — CV-PERF-004](claudeville-comprehensive-remediation-plan.md#package-9--small-cleanup-and-explicit-deferrals).
  - **Reopen when:** cold readiness exceeds **2 seconds** or memory pressure is reproduced. The retained baseline was cold readiness near **1.23 seconds** with bounded caches.
  - **Current status:** Open — deferred. World resource suspension/reload is implemented, but broader provider/model lazy-loading infrastructure was not added. Current boot still awaits `AssetManager.load()` and, for the material renderer, `loadMaterialAssets()` before loading the renderer (`claudeville/src/presentation/App.js`).

- [ ] **Identity-aware native-surface registry and staged asset groups**

  - **ID:** `OF-003`
  - **Added:** 2026-07-28
  - **Last reviewed:** 2026-09-02
  - **Trigger:** A new surface owner shares World assets with Dashboard, diagnostics cannot attribute overlap, or Dashboard becomes a direct boot mode.
  - **Source:** [post-OOM plan — retained follow-ups](claudeville-post-oom-reliability-performance-plan.md#retained-follow-ups).
  - **Reopen when:** a new surface owner shares World assets with Dashboard, diagnostics cannot attribute overlap, or Dashboard becomes a direct boot mode.
  - **Current status:** Open — deferred architecture. The simpler explicit owner lifecycle is implemented and reaches zero World canvas/decoded-resource checkpoints, but current `CanvasBudget` is aggregate accounting and `AssetManager` has no identity-aware owner registry or staged `ensure()` groups.
  - **Current measurement:** the recorded World → Dashboard → World checkpoint was **1,286,560 → 0 → 1,286,560** main-canvas pixels, **15,717,856 → 0 → 15,717,856** decoded World asset pixels, and **3,385,600 → 0 → 3,385,600** composited agent-sheet pixels. No listed trigger is currently evidenced.

- [ ] **Durable Claude aggregate checkpoints and a global provider cold-work scheduler**

  - **ID:** `OF-004`
  - **Added:** 2026-07-28
  - **Last reviewed:** 2026-09-02
  - **Trigger:** A cold restart scans more than 64 MiB synchronously, takes more than 2 seconds, or provider diagnostics show a growing deferred-age backlog.
  - **Source:** [post-OOM plan — retained follow-ups](claudeville-post-oom-reliability-performance-plan.md#retained-follow-ups), corresponding to Package 7 Phase B.
  - **Reopen when:** a cold restart scans more than **64 MiB synchronously**, takes more than **2 seconds**, or provider diagnostics show a growing deferred-age backlog.
  - **Current status:** Open — deferred. Current Claude code has bounded signature/aggregate caches, guard/append aggregation, and a concurrency-one async scan queue, but no durable ClaudeVille-owned checkpoint or global provider cold-work scheduler. The large-fixture evidence was about **52.5 MiB** and an unchanged second detail read added zero parsed lines, so the trigger was not met.

- [ ] **Conditional P3 provider whole-file caches and incremental indexes**

  - **ID:** `OF-005`
  - **Added:** 2026-07-28
  - **Last reviewed:** 2026-09-02
  - **Trigger:** Oversized fixtures demonstrate material savings.
  - **Source:** [post-OOM plan — Package 7, Phase C](claudeville-post-oom-reliability-performance-plan.md#phase-c-conditional-p3-whole-file-caches).
  - **Scope:** byte-bound Gemini’s whole-history cache and derive all consumers from one compact pass; incrementally parse growing Codex/Kimi session indexes with last-write-wins semantics instead of full read/split/parse on each signature change.
  - **Reopen when:** oversized fixtures demonstrate **material savings**; the plan records that current local index files were small and no Gemini corpus was present.
  - **Current status:** Open — conditional P3. The measured provider discovery/cache bounds are implemented, but current source still full-reads/splits the Codex index on a signature miss, parses Gemini session JSON as a whole, and rereads the bounded Kimi index tail on a signature miss. No oversized-fixture trigger is recorded.

- [ ] **Long pressure soak before a release push**

  - **ID:** `OF-006`
  - **Added:** 2026-07-28
  - **Last reviewed:** 2026-09-05
  - **Trigger:** Before a release push, run and pass the long pressure soak against the correct server process.
  - **Source:** [post-OOM plan — Definition of done](claudeville-post-oom-reliability-performance-plan.md#definition-of-done) and [release verification gate](claudeville-post-oom-reliability-performance-plan.md#package-9--release-verification-gate).
  - **Reopen when:** before a release push, run the long pressure soak against the correct server process and pass both the JavaScript heap/RSS gates and deduplicated native-resource gates.
  - **Current status:** Satisfied for v0.42.0; recurring before the next release push. The final 10-minute browser run passed, and the immutable 30-minute trace from an identical backend was independently revalidated after correcting the RSS baseline. [Release evidence](../research/claudeville-astra-refinement/README.md#v0420-release-verification) records the separate processes, measurement repairs, and unchanged limits.
  - **Current gate values:** **8 MiB** browser-heap projected-growth limit, **64 MiB** server-RSS allowance above the second-half median, with steady and trailing growth-slope limits, **250 ms** event-loop p95 limit, plus native canvas/asset drift checks in `scripts/smoke/performance-soak.mjs`.

### Additional conditional follow-ups from the semantic rendering plan

The semantic rendering plan also contains two explicit conditional
architecture follow-ups. They are included here because the task brief asked
for them if that completed plan contained open follow-ups; its stale unchecked
implementation checklist is not otherwise treated as open work.

- [ ] **Evaluate OffscreenCanvas for remaining main-thread contention**

  - **ID:** `OF-007`
  - **Added:** 2026-08-21
  - **Last reviewed:** 2026-09-02
  - **Trigger:** Profiling after the GPU-resident path is complete shows main-thread contention remains material.
  - **Source:** [semantic diorama rendering plan — Package 9](claudeville-semantic-diorama-rendering-plan.md#package-9--conditional-modernization-and-polish).
  - **Reopen when:** profiling after the GPU-resident path is complete shows main-thread contention remains material.
  - **Current status:** Open — conditional and not implemented. Current source has no `OffscreenCanvas` path; the plan’s recorded post-GPU verification was **12.6 ms rAF p95** at **100% FULL** quality, so no trigger is recorded.

- [ ] **Prototype WebGPU behind the existing fallback**

  - **ID:** `OF-008`
  - **Added:** 2026-08-21
  - **Last reviewed:** 2026-09-02
  - **Trigger:** WebGL2 batching, attachment limits, or material passes remain a measured blocker.
  - **Source:** [semantic diorama rendering plan — Package 9](claudeville-semantic-diorama-rendering-plan.md#package-9--conditional-modernization-and-polish).
  - **Reopen when:** WebGL2 batching, attachment limits, or material passes remain a measured blocker.
  - **Current status:** Open — conditional and not implemented. Current source contains the WebGL2 GPU path but no `navigator.gpu`/`GPUDevice` implementation, and no measured WebGL2 blocker is recorded.

- [ ] **Strip-less characters and the authored wait row**

  - **ID:** `OF-009`
  - **Added:** 2026-09-06
  - **Trigger:** A PixelLab rig (or a re-rigged character) can produce an empty-handed held pose, or a strip-less character's rig is regenerated so its read frames land within ±2 px of the base idle footprint.
  - **Source:** [frontier visual plan — 2.7 roster rollout decision](claudeville-frontier-visual-plan.md#27-roster-rollout-decision) and items 2.1–2.3.
  - **Current status:** Open — partial. The authored `read` group shipped for **16 of 24** characters (`0fe37ee`): all `agent.codex.*` except `gpt55.high`, `claude.sonnet`, `claude.base`, `kimi.base`, all three `deepseek.*`, `grok.composer`, both `zai.*`. **Six are strip-less** after their one allowed regeneration still failed the ±2 px feet rule (`codex.gpt55.high` SW +3 px, `claude.fable` S +3 px, `claude.opus` NE +3 px, `claude.haiku` all directions ~12 px small/high, `gemini.base` NW −3 px, `grok.base` W −3 px); they render byte-identically to before with the procedural read prop. The `wait` held-palm row was generated four times across the two pilots (v3/v4 prompts: planted/sheathed weapon, both hands empty) and rejected every time because the rigs re-draw the staff or spear into a hand; no character carries `wait`, so 2.3's letter/slip/plan props draw on the procedural held pose. 324 generations spent; balance 1,013 / 2,000.

- [ ] **Window light that reaches the street (3.3)**

  - **ID:** `OF-010`
  - **Added:** 2026-09-06
  - **Trigger:** The scene-shader apply path for the spill field produces a pixel-measurable warm gain on the Command doorstep; then the C3 protocol (3× 30 s on/off, forced FULL, `dense-24-agents` hour 23) resolves a band inside `[0.4, 1.2]` ms on a quiet host.
  - **Source:** [frontier visual plan — 3.3 window light that reaches the street](claudeville-frontier-visual-plan.md#33-window-light-that-reaches-the-street-pilot-conditional).
  - **Current status:** Open — cut twice, for two different reasons, and the tree carries none of it. First attempt (Wave 3, shared host): seven concurrent capture agents put the per-pass noise floor at 0.35–1.5 ms, wider than the band, so nothing was landed. Second attempt (quiet host): the full pipeline was built and ran — `EFFECT_BUDGET` row, aperture descriptor in `LightSourceRegistry`, `spillSource` on the Command record, seed + one-hop shaders over a cached 256×144 RGBA8 ping-pong field, a `spill` pass in the Shift-D ring, a clipped stepped Canvas stamp — and the field read back a correct world-anchored shaft that rose and fell with the occupancy gate. But the **scene-pass apply produced no visible output**: an in-page on/off screenshot A/B over the expected patch rect measured mean warm gain −0.59 vs 8.39 for the control, so the receiver branch consumes the field and discards it. Root cause not isolated; the implementation was removed entirely because an effect without a measured receipt is not admitted. Retry hints from that run: check the terrain fragments' `materialNear` id at the patch (1/6/7) and the `smoothstep(0.22, 0.5, elevation)` gate — one of these is likely eating the contribution on the cobble apron; the hop pass must scatter alpha only (scattering colour saturated the aperture toward white); reseed keys on `records.length` (≈4 reseeds / 9 s with 4 agents). Only the `SPILL_FIELD_*` byte-offset constants remain in `GpuWorldRenderer.js`.

## Already landed; do not carry forward as open

- [x] **Change-driven Git enrichment:** scoped signatures, cache reuse, nested-remote handling, ref invalidation, and zero-command unchanged warm refresh are implemented. This does not close the async-worker item above.
- [x] **World resource suspension:** Dashboard releases the World canvas, decoded World assets, masks/outlines, and composited agent sheets; World reloads them on a generation-current resume.
- [x] **Bounded Claude parsing:** compact signature-keyed tail/aggregate projections, byte caps, append/guard handling, and concurrency-one async large-file scans are implemented. This does not close the durable-checkpoint/scheduler item above.
- [x] **Measured provider discovery hot paths:** bounded caches, active-first lookups, Kimi’s bounded old-index fallback, and OpenCode’s avoidance of the all-history active-part scan are implemented. This does not close the conditional Phase C cache/index work above.
- [x] **Pressure measurement infrastructure:** process identity, warm-up, rolling slopes, native-resource checkpoints, and the default 10/30-minute soak are implemented and release-verified; only the explicitly pending pre-push gate remains above.
