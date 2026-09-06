# ClaudeVille Astra Refinement Plan

**Status:** `release-verified for v0.42.0`
**Reviewed:** September 5, 2026
**Baseline:** `65a4ce0` · v0.41.3, *The Steady Blade*
**Scope:** Comprehensive review and maintainer-authorized execution. Sections 1–10 preserve the original review; section 11 records implementation and supersedes the original proposed sequencing.

ClaudeVille's next substantial improvement should make its existing capabilities work together more convincingly. It already has an unusually capable rendering stack and a useful operator dashboard. The best opportunity is a village with coherent art direction, unmistakable agent state, stable motion, and reliable behavior across CLI providers. A new engine would not resolve the most consequential findings below.

This plan is deliberately at `/agents/claudeville-astra-refinement-plan.md`, the location requested by the maintainer. Source references are relative to this file; line numbers identify the reviewed revision and will drift.

## 1. Review basis and confidence

Three independent read-only reviews covered rendering, runtime/provider behavior, and frontend UX. The primary review inspected their findings against source, read the current contracts and earlier plans, exercised the maintained application, and reviewed screenshots. The checkout started clean. No application code or assets were changed.

`npm run dev` reported that port 4000 was occupied. The existing maintained server at `http://localhost:4000` was used without restarting it. Browser inspection covered the live village, mixed-tools World and Dashboard, selected-agent detail, the selected-behind-building fixture, Canvas team-gather, GPU storm-night-reduced-motion, and GPU dense-100. Live browser captures were 2204 × 1305 pixels; isolated render evidence was 1440 × 900. The dynamic fixture inspections were not synchronized frame-for-frame backend comparisons.

| Verification performed | Result | What it does not establish |
| --- | --- | --- |
| `npm run validate:quick` | Passed, including 755 tests and sprite ID audit | Complete visual correctness or exhaustive provider parity |
| `npm run verify:server` | Boot, security smoke, and fatal-cleanup checks passed | A comprehensive security audit |
| `npm run test:integration` | Both integration tests passed | The missing identity/freshness cases identified below |
| `npm run verify:render` | World, Dashboard, selection, panel, deselection passed; no console errors, page errors, or failed requests | Semantic pixel parity, motion quality, or a performance benchmark |
| Focused runtime review | 52 existing tests passed; small quota and hook-identity reproductions exposed defects | Live alteration of provider stores; none was performed |

Render-smoke evidence was written to the temporary `claudeville-render-gQSkwS/` directory, containing `world.png`, `dashboard.png`, `panel.png`, and `diagnostics.json`. This is temporary evidence, not a committed golden set. Four GPU `ReadPixels` stall warnings occurred during capture. Their cause was not isolated; screenshot readback itself can affect timing. Neither the smoke FPS sample nor the live FPS badge is used here to claim a hardware performance regression.

Findings distinguish **confirmed defects**, **source-supported risks requiring a controlled visual reproduction**, and **art-direction judgments**. This was a broad review, not a line-by-line proof of every module, full browser compatibility certification, or long-duration pressure soak.

## 2. Preserve the foundations

Keep the zero-build Node/vanilla-JS architecture, local assets, loopback/origin protection, read-only provider adapters, bounded parsing/caches, WebSocket recovery, and existing verification tools. Preserve resident WebGL2, Canvas fallback, material companions, split building passes, the quality ladder, GPU/resource diagnostics, pixel-aligned resting zoom, reduced motion, and the existing mark/relationship/crowd systems.

Dashboard already has compact rows, status/provider filters, project groups, selected inline detail, search, keyboard navigation, pin comparison, provenance, working sets, and execution relationships. Do not commission these as new features. Likewise, recent weapon-grip work, asynchronous Git enrichment, resident-profile boot loading, and provider lifecycle parsing should be assessed as shipped behavior before proposing replacements.

Model vendor, CLI provider, account, and session identity are different dimensions. For example, GLM through OMP is an `omp` session with Z.AI model identity; a GPT model through OpenCode is still an `opencode` session. Use the [adapter contract](../claudeville/adapters/README.md) and [model registry](../claudeville/src/config/models.json) to preserve that distinction throughout status, pricing, search, badges, and artwork.

## 3. Visual assessment: what would make this feel exceptional

The landmark silhouettes, animated inhabitants, bridges, harbor, and slate roofs give the village a recognizable identity. The current image is held back more by inconsistent detail and competing emphasis than by missing effects.

| Observed presentation | Refinement target |
| --- | --- |
| Detailed pixel buildings sit beside large smooth ellipse/curve foliage and simpler flat-shaded rock forms. | One pixel scale, compatible edge treatment, shared material ramps, and foliage that belongs beside the landmarks. |
| Grass, cobble, flowers, shore objects, torches, and repeated props make nearly every ground patch visually busy. | Deliberate quiet ground around agents and routes, with detail concentrated at landmarks and edges. |
| Some building plaques float far above the structure; at close zoom they can appear to name a neighboring object. | Plaques attached to the actual visible sprite bounds, with restrained collision displacement. |
| The dense-100 scene becomes overlapping masses of full-sized bodies and nameplates around work destinations. | An overview that summarizes ordinary crowds while preserving selected and action-needed individuals. |
| Storm-night maintains atmosphere, but a dark selected body and very small name compete with a broad illuminated harbor. | A readable selected silhouette and immediate attention hierarchy at every atmosphere level. |
| Large characters, small fixed labels, and a narrow detail panel can have radically different reading scales. | Intentional overview/detail framing and text sized for the operator's desktop reading distance. |
| Dashboard truncates the primary status while allocating wide areas to repeated `None` and `No files`. | Full status and useful tool context first; secondary fields quiet and proportionate. |

The visual ambition is a carefully authored pixel diorama with modern lighting and interaction. Use a clear priority: **action required → selected agent → active work → relationships → landmarks → scenery**. Atmospheric beauty should survive when ornamental motion is disabled. Provider identity should remain recognizable without borrowing status colors or depending exclusively on a color tint.

### Three visual approval scenes

Before broad asset production, produce three actual in-engine A/B scenes using the existing capture matrix:

1. **Clear-day working village:** one selected worker, a contrasting provider, Command/Forge, a readable route, a quiet ground patch, and one improved tree. Judge silhouette, texture scale, grounding, and label attachment.
2. **Torchlit harbor:** warm windows and water contact against a cool readable world; the selected agent is immediately identifiable. Judge emission restraint, material separation, and preservation of roof/wood detail.
3. **Storm with an unanswered approval:** the waiting agent is the first thing noticed, the reason is inspectable, and the static reduced-motion image communicates the same state.

These should be implementation proofs, not concept paintings that promise a different engine. Compare default WebGL, flattened PostFX, and Canvas for equivalent meaning; decorative differences already documented in [rendering-baselines.md](../docs/rendering-baselines.md) can remain.

## 4. Wave 0 — correct the village's claims

Do these small, high-confidence fixes before more event-driven visual effects. Their impact includes the village, attention counts, notifications, and operator trust.

### T1 · Scope quota correctly and separate pressure from enforcement — P1, small/medium

**Confirmed defect.** [usageQuota.js](../claudeville/services/usageQuota.js):337–355 returns Claude quota. [AgentManager.js](../claudeville/src/application/AgentManager.js):781–784 supplies that same usage to every session. [StatusResolver.js](../claudeville/src/domain/services/StatusResolver.js):91 applies it without matching provider/account. A reproduction with Claude utilization `.96` classified Claude, Codex, Kimi, Grok, OMP, and OpenCode as `rate_limited`.

Match the quota source to the correct account/provider. Represent high utilization as pressure, not proof that a request was rejected. Keep observed enforcement distinct and avoid masking an unanswered approval with inferred quota status.

**Acceptance:** High Claude utilization leaves unrelated providers working; an exact rate-limit event still raises attention; the waiting question remains visible. Extend the existing status tests with a cross-provider case and a pressure-versus-enforcement case.

### T2 · Join hook identity to the actual provider session — P1, medium

**Confirmed identity mismatch.** [hooks.js](../claudeville/adapters/hooks.js):157,232–245 stores a raw hook ID; [adapters/index.js](../claudeville/adapters/index.js):436 retrieves by normalized session ID. Documented Codex hooks carry a thread ID, while [codex.js](../claudeville/adapters/codex.js):1614–1632 exposes a timestamp-bearing rollout filename ID and separately retains the actual thread ID in `agentId`. Gemini has a similar filename/payload distinction.

Resolve through provider-qualified source identity, reusing available aliases. Preserve public dashboard IDs so history and selection remain stable. Simply adding `codex-` is insufficient.

**Acceptance:** POST the documented raw hook into an isolated server with realistic Codex/Gemini filenames; the intended HTTP session and WebSocket update change. Two providers sharing a raw ID must not cross-match. A successful HTTP acceptance response alone is not evidence of a working hook.

### T3 · Keep a live Grok transcript discoverable — P1, small

**High-confidence source defect.** [grok.js](../claudeville/adapters/grok.js):755–772 filters on directory/summary age before calling `sessionActivityMs()` at :779, which checks actual transcript files. Appending an existing `updates.jsonl` does not refresh its parent directory mtime.

Include real activity signatures in the prefilter using the existing helper; retain bounded discovery.

**Acceptance:** Old summary/directory plus a freshly appended existing transcript remains active. All activity sources aging out still removes the session. Unchanged polls avoid reparsing content. Use a temporary fixture, not real provider data.

### T4 · Isolate simulation from live persistence — P1, medium

**Confirmed ownership defect.** [App.js](../claudeville/src/presentation/App.js):229 initializes normal foundation before reading `sim` at :233. Chronicle, biographies, and [SpendLedger.js](../claudeville/src/application/SpendLedger.js):104,264,287 use normal events and persistent keys. REST usage also runs for simulation. Browser inspection showed simulated agents alongside the live persisted TODAY total.

Detect simulation before foundation initialization. Use memory-only stores or a fully isolated namespace for simulation, including cross-tab channels and leases. Supply synthetic usage and label the mode `SIMULATED`. The documented claim that fixture captures are isolated needs to match actual browser storage behavior.

**Acceptance:** Running and closing simulation leaves live spend, history, biographies, and founding metadata unchanged. A simultaneous live tab is unaffected. Seed nonzero synthetic tokens to make the test capable of detecting pollution.

### T5 · Give connection and renderer health honest ownership — P1, small

**Confirmed defects.** [TopBar.js](../claudeville/src/presentation/shared/TopBar.js):1282 converts `null` FPS to zero, although renderer stop deliberately emits null. Dashboard therefore shows a red `0 FPS` failure. TopBar also owns a separate connection reducer (:158,198–205) instead of consuming App's canonical `village:state` (:472), leaving simulation indefinitely `SYNCING`.

Guard null/non-number FPS before conversion, and consume one canonical connection state. Keep a genuine numeric zero distinguishable from a suspended renderer.

**Acceptance:** Dashboard hides inactive World FPS; returning to World restores it. Live, polling, stale, reconnecting, recovered, and simulated states agree across UI surfaces. Extend existing TopBar/state tests.

### T6 · Preserve unknown and stale data explicitly — P2, medium

[adapters/index.js](../claudeville/adapters/index.js):378,420–425 can replace a provider slice with empty data on read failure; :478–480 returns cached detail without freshness. [sessionPresentation.js](../claudeville/adapters/sessionPresentation.js):68–117,222–241 and [TokenUsage.js](../claudeville/src/domain/value-objects/TokenUsage.js):61–62 can turn absent usage into zero. Grok context occupancy is not a billable input/output split.

Retain last-good provider observations for a bounded degraded interval, with observation age. Distinguish confirmed empty, failed discovery, departed, unavailable usage, partial usage, and observed zero. Add only the necessary availability/freshness fields to the current contracts. Totals should disclose incomplete coverage rather than silently treating unknowns as free usage.

**Acceptance:** One provider's failed read does not erase unrelated agents or make its last observation look fresh. Recovery clears staleness; expiry bounds retention. A context-only Grok session shows unavailable cost; an observed zero remains zero; mixed-provider totals disclose missing coverage.

### T7 · Preserve signal certainty across providers — P2, medium

Grok and Gemini still lack derived turn state in their normalized session paths. [turnState.js](../claudeville/adapters/turnState.js):63–110 can infer an approval from a long pending tool; hook overlays stop merging after ten seconds in [hooks.js](../claudeville/adapters/hooks.js):7–9,119–125. Long builds and unresolved exact approvals deserve different treatment. Kimi Code, OpenCode, and OMP already have lifecycle parsing.

Expose observed/inferred/unavailable certainty through the existing provenance presentation. Add lifecycle parsing only where recorded provider events support it. Define bounded behavior for an exact unanswered approval after hook TTL: preserve “last observed waiting” or wait for a resolving event, rather than silently asserting fresh work.

**Acceptance:** Replay a long build, an approval lasting beyond ten seconds, resolution, missing completion, and unknown format. Attention, World, and Dashboard agree on both state and certainty. Do not infer an approval solely from elapsed time.

## 5. Wave 1 — make rendering correct and stable

### V1 · Restore semantic cues across rendering surfaces — P1, medium

**Source-confirmed composition gap; controlled paired captures still required.** [WorldFrameRenderer.js](../claudeville/src/presentation/character-mode/WorldFrameRenderer.js):531–583,651–677 draws Director ground cues, relationship rings/tethers, talk arcs, and selected x-ray on the lower Canvas. The opaque GPU island is presented afterward. Upper-Canvas replay at :731–750 restores harbor categories, primary marks, and agent annotations, but does not reproduce all those semantic layers. [SceneCategoryRegistry.js](../claudeville/src/presentation/character-mode/SceneCategoryRegistry.js):313 currently registers harbor traffic.

Inventory each semantic cue's actual output surface. Move overlay-safe annotations to the existing upper Canvas and put depth-sensitive cues into the existing drawable stream. Do not blindly redraw everything on top: ground rings should not cross roofs, and relationship lines should retain intended occlusion.

**Acceptance:** Frozen team, parent-child, chat, handoff, building replay, and selected-behind-building captures preserve meaning in all three backends, without doubled marks. Cover forced fallback/context recovery as well as normal WebGL. Document intentional decorative differences separately.

### V2 · Attach building labels to visible sprite bounds — P1/P2, small

**Confirmed anchor mismatch and observed visual problem.** [BuildingSprite.js](../claudeville/src/presentation/character-mode/BuildingSprite.js):727 uses `center.y - dims.h` for the plaque origin, while sprite drawing at :1609–1612 uses the anchor. Command's height/anchor Y are 208/182, Observatory's 288/252, and Forge's 232/203: an excess upward displacement of 26, 36, and 29 world pixels before intentional gap/collision offsets. Collision displacement can make the separation harder to interpret.

Base labels on the same sprite bounds/anchor used for drawing, then apply a bounded screen-space gap and the existing collision logic. Use a short leader only when displacement makes ownership ambiguous. Do not add another independent label layout system.

**Acceptance:** Each of the nine buildings has an unambiguous label at overview and detail zoom, including hover, selected agent nearby, and harbor subrows. Labels remain inside the usable view where possible and do not cover the selected agent's name.

### V3 · Share one snapped render transform — P2, small/medium

[Camera.js](../claudeville/src/presentation/character-mode/Camera.js):770–779 rounds Canvas translation to backing pixels. [GpuWorldRenderer.js](../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js):1061–1070 sends unrounded camera translation. Layers can differ by up to half a backing pixel during movement. Existing resting zoom tiers do not eliminate this mismatch.

Reuse a single render transform convention for GPU bodies, Canvas overlays, and projected hit areas while retaining continuous logical camera state.

**Acceptance:** Fractional camera positions at DPR 1, 1.25, 1.5, and 2 produce aligned body, weapon, ring, and label anchors. Slow pan/follow recordings show no relative sliding. Include live browser zoom changes; keep the existing camera tests.

### V4 · Anchor surface detail to the surface — P2, small/medium

[GpuWorldRenderer.js](../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js):146–173,250–256 supplies `gl_FragCoord` to wet glints and water courses. This makes surface texture live in screen space while the world moves beneath it.

Use interpolated world/source-pixel coordinates for physical surface patterns. Keep screen coordinates for screen effects such as vignette or grain. Reuse the existing shader rather than adding a pass.

**Acceptance:** With motion frozen, a water patch and wet cobble retain their pattern through pan/zoom. Animation then advances naturally without crawling against shores. Preserve nearest sampling and static reduced-motion meaning.

### V5 · Keep animation bodies, attachments, and clocks in agreement — P2/P3, measured pilot

[GpuSceneBuilder.js](../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js):969–976 limits existing-agent atlas updates to 125 ms, while overlay pose can advance independently. This is a bandwidth tradeoff, not a proven visual defect. [MotionClock.js](../claudeville/src/presentation/character-mode/MotionClock.js) exists, but foliage still reads `performance.now()` and other ambient paths maintain separate phases.

Record fast turns and tool-pose transitions for equipped Codex heroes and a contrasting provider. If body/attachment lag is visible, immediately refresh direction changes and high-priority agents while preserving ambient throttling. As these paths are touched, use the existing visual elapsed clock for ambient phases; keep event age on absolute time.

**Acceptance:** Foot contact, handedness, equipment grips, and direction changes agree in motion. Pause/resume does not jump ornamental phases; frozen captures repeat. Record upload/frame p95 before changing atlas cadence. Do not rewrite the recently refined weapon-pose system without a failing sequence.

## 6. Wave 2 — art direction with the existing engine

### V6 · Unify foliage, terrain, and landmark craft — P2, medium art pass

**Highest visual return.** [FoliageRenderer.js](../claudeville/src/presentation/character-mode/FoliageRenderer.js) draws broad leaves and crowns with smooth curves and large flat fills. These read as vector shapes beside textured pixel buildings. [scenery.js](../claudeville/src/config/scenery.js):246–286 adds dense forest masses near the civic work areas, amplifying the mismatch.

First reuse suitable existing vegetation sprites. Where these cannot provide the intended silhouette, author a small coherent tree set at native pixel resolution: a few deliberate cluster shapes, three or four material tones, selective outline, and the established upper-left key. Keep tropical variety if desired; make its rendering language coherent. Cache static variation. Revisit the mine's larger flat rock planes only after the foliage pilot shows the target clearly.

In the same small district, reduce repeated ground props and high-contrast grass/cobble noise around work slots. Give roads readable edges and thresholds; reserve flowers, stones, and bright accents for intentional focal points. Preserve the existing terrain-owned grounding contract rather than adding sprite plinths.

**Acceptance:** A day/night crop of one district reads as one art style at native size and 2×. A grayscale view separates agent, building, and ground. No extra runtime dependency, per-frame terrain painting, or wholesale asset regeneration. Run sprite/terrain/building validation and review actual in-engine placement.

### V7 · Use authored materials where they will be seen — P2, medium pilot

Material infrastructure is ahead of much of its content. [author-roster-channels.mjs](../scripts/sprites/author-roster-channels.mjs):121–136 assigns a single class to most nontransparent character pixels. [GpuSceneBuilder.js](../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js):175–220 paints coarse terrain class diamonds, even in the authored-terrain helper.

Pilot mixed material masks for one Codex hero, one contrasting provider hero, and one landmark: metal versus fabric, skin versus armor, stone versus roof, glass versus timber. Start with manually reviewed existing albedo; new generation is not required. Keep terrain's cheap class map unless a controlled comparison shows visible leakage at roads/shores.

**Acceptance:** Day/dusk/rain triptychs visibly improve form and material separation without increasing bloom. The sprite remains readable with lighting disabled. Retain masks only when their improvement is visible at actual gameplay size. Approve the pilot before expanding to the roster.

### V8 · Repair height semantics, then refine lighting restraint — P2, medium

[GpuSceneBuilder.js](../claudeville/src/presentation/character-mode/gpu/GpuSceneBuilder.js):568–577 supplies building elevation/occluder defaults around `.82/.86`; [GpuWorldRenderer.js](../claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js):251,303 takes maxima with authored height. Lower authored geometry therefore cannot override those floors. Batch-wide maximum occluder values further mix strength with height.

Represent authored-height presence explicitly; use it when present and defaults when absent. Separate occlusion strength from geometric height. Prove the contract with a low-wall/tall-receiver/light fixture before painting more channels.

Then tune warm emission pools and cool ambient values to preserve selected-agent silhouettes at night. The current sun multiplier is material-wide, and its nominal four-band formula reaches only two bands over the present input range (:175–192). Correct the claim first; compare a tiny authored facing/roof-wall mask only if it improves the approved hero scene. Preserve the baked upper-left lighting convention.

**Acceptance:** Low geometry no longer behaves as a tall blocker; doors and roof masses have distinct light response. Night preserves agent outline and ground contact without turning the whole village bright. No full normal-map, PBR, SSAO, or volumetric-light pipeline is required.

### V9 · Make dense views readable and camera framing intentional — P2, medium

**Observed design failure with explicit implementation causes.** The dense-100 scene covered multiple landmarks with overlapping bodies and plaques despite existing [CrowdClusters.js](../claudeville/src/presentation/character-mode/CrowdClusters.js), [MarkGovernor.js](../claudeville/src/presentation/character-mode/MarkGovernor.js), and annotation folding. [AgentSprite.js](../claudeville/src/presentation/character-mode/AgentSprite.js):2635–2644 permits compact bodies only outside WebGL; :2714–2744 keeps real GPU bodies at full scale. The roughly eleven-second capture was also inside the twelve-second newcomer protection in [IsometricRenderer.js](../claudeville/src/presentation/character-mode/IsometricRenderer.js):5381–5389. This proves arrival overload, not that every name remains visible indefinitely. At low population, close camera framing can also magnify characters while fixed-size labels remain tiny.

Tune the existing admission and representation policy using visible screen occupancy as well as world count/zoom. Implement equivalent compact body treatment in WebGL and bound the newcomer exception during mass arrivals. Keep selected, hovered, and action-needed agents individually legible. Fold ordinary groups into an inspectable representative/count or compact existing representation; let selection reveal members without requiring perfect clicks on obscured sprites. Preserve a route through Sidebar/Dashboard for every agent. Tune overview/detail camera framing around the actual usable canvas and open panels; retain pixel-aligned resting scales.

**Acceptance:** At 24 and 100 agents, both during arrival and after 15–20 seconds, a reviewer can identify the selected agent and the next required action within a few seconds. No action-needed member is concealed by an aggregate. Names and group counts remain stable under small movements; group expansion is keyboard-accessible. Record the existing overlay census and frame/resource metrics. Do not enlarge the map to postpone crowd handling.

## 7. Wave 3 — desktop interface and maintainability

### U1 · Improve operational typography and information allocation — P1/P2, small/medium

[dashboard.css](../claudeville/css/dashboard.css):1075 fixes the status column at 118 px, while :647 and :1213 place status and elapsed horizontally and ellipsize both. The live Dashboard visibly truncated primary state even at a wide desktop size. The existing two-font system is already present in [reset.css](../claudeville/css/reset.css); adding another typeface is unnecessary.

Stack elapsed beneath the complete status or allocate a suitable bounded column. Use the body face and adequate size for operational values. Quiet repeated empty fields and excessive outlines; give useful tool/path context more room. Keep the medieval palette and display face for branding/short headings. In the Activity Panel, favor readable useful information over many equally weighted empty sections.

**Acceptance:** All status words and meaningful durations remain readable at 1280, 1440, and 1920 CSS pixels, including long project/model names. No mobile breakpoints or text shrinking. Measure contrast on rendered composited surfaces: target 4.5:1 for ordinary text and 3:1 for essential controls/marks; these are test targets, not a claim that current colors have been audited. See [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

### U2 · Complete existing search and identity presentation — P2, small

[SearchIndex.js](../claudeville/src/presentation/shared/SearchIndex.js):76 excludes provider, project, team, and session ID. A direct probe found the name/model but not those exact identity fields. Extend `liveFields()` and the existing tests. Match CLI and model vendor separately, including OpenCode/OMP hosted-model examples.

[AgentPresentation.js](../claudeville/src/presentation/shared/AgentPresentation.js):85 falls back to a Claude badge for an unknown provider. Use a neutral badge and truthful raw label instead.

**Acceptance:** Search locates an agent by CLI, model, project, team, or session ID; unknown providers never acquire Anthropic identity by default. Reuse existing filtering/search infrastructure.

### U3 · Make detail inspectable and visibly fresh — P2, small/medium

[SessionDetailsService.js](../claudeville/src/presentation/shared/SessionDetailsService.js):419,432 can return cached fallback. Dashboard reads `detailCacheState`, while [ActivityPanel.js](../claudeville/src/presentation/shared/ActivityPanel.js):2250–2285 omits the freshness indication. The panel also hashes and truncates messages at 60 characters (:2350–2374) without a full available-text expansion.

Reuse cache state for “Cached · updated … ago.” Provide native disclosure for full available messages and tool inputs; preserve expansion across refresh and identify upstream truncation. Ensure tool inspection works by keyboard rather than only mouse `title`.

**Acceptance:** A failed detail request preserves useful content with age; recovery clears the marker. Long questions/tool inputs can be read and copied without losing selection. No new fetch loop, cache, or detail service.

### U4 · Normalize avatar fitting and repeated icons — P2/P3, small

[AvatarCanvas.js](../claudeville/src/presentation/dashboard-mode/AvatarCanvas.js):240–243 independently caps width while fixing height, squeezing wide frames. Fit using a single scale from both bounds; preserve aspect ratio and deliberate pixel rounding. Test broad weapons, tall hats, and wings in the real niche.

Repeated OS emoji in [ToolIdentity.js](../claudeville/src/domain/services/ToolIdentity.js) and AgentPresentation look inconsistent beside pixel sprites and custom topbar SVGs. Reuse the existing pixel SVG vocabulary for the few most frequent tool/district icons. Preserve text labels and accessible names; decorative icons should not duplicate speech output.

**Acceptance:** Avatars preserve proportions within pixel rounding, and repeated operational icons have consistent stroke/baseline treatment. No icon dependency or runtime asset generation.

### U5 · Delete proven dead work; reconcile owner docs — P2/P3, small

[DashboardRenderer.js](../claudeville/src/presentation/dashboard-mode/DashboardRenderer.js):1861 fetches detail for the selected agent only, yet :623,690,1867–1892 maintains an obsolete visibility observer/state and per-card rectangle scan. Remove that work after confirming no readers; keep selected-detail behavior intact.

Update nearest-owner documentation with the touched changes. Renderer docs still describe Canvas as the default and frame-counted water; Dashboard docs describe an obsolete broad detail-candidate policy; some runtime docs still say Node 18 despite `package.json` requiring `>=22.7.0`. The open-followup ledger also understates resident-profile loading and Gemini byte-bound cache work already present.

**Acceptance:** No card-visibility scan remains for the selected-only policy; interaction/detail behavior is unchanged. Architecture/artifact checks pass. Do not split large files merely because of their line count; extract only a demonstrated shared responsibility when the corresponding implementation changes.

## 8. Implementation order and review gates

Effort labels above are relative to this repository, not calendar promises. Small means a local fix with a focused regression; medium means cross-surface behavior or an art/renderer pilot.

| Batch | Work | Completion gate |
| --- | --- | --- |
| **A: Trust repairs** | T1–T5; U1 status-column fix | Reproductions become regressions; isolated integration and render checks pass; live mode-switch/status judgment |
| **B: Rendering correctness** | V1–V4, T6 freshness/availability contract | Paired semantic captures; label ownership; transform and surface-pattern motion review |
| **C: Visible craft** | V6, then V7/V8 pilot; V9; U1 remaining polish and U4 | Approve the three in-engine scenes; dense desktop judgment; sprite and world validators |
| **D: Operator depth** | T7, U2/U3, measured V5, U5 | Cross-provider lifecycle replays; keyboard detail/search review; deterministic capture and doc checks |

T4 precedes new persistent simulator tests. V1 precedes judging missing relation effects. V8's height fix precedes authored-height production. V3 precedes evaluating apparent equipment jitter. T6 defines freshness/coverage semantics that U3 should display rather than independently invent. U5 documentation updates should accompany each affected batch, with a final reconciliation afterward.

### Verification additions: use the maintained harnesses

- Add focused cases to existing status, hook, adapter, search, TopBar, avatar, camera, and detail tests. Test boundaries and outcomes, not private implementation structure.
- Extend the current render matrix with a true multi-provider cast: Claude, Codex, Gemini, Kimi, Grok, OpenCode carrying a contrasting model vendor, and OMP carrying Z.AI. The default mixed-tools fixture currently emphasizes Claude/Codex, so it cannot establish visual parity for the entire product.
- Add frozen relationship and exact waiting-state cuts, plus short pan/turn/transition recordings. An image of a scene that has already moved away from the intended occlusion is not proof of the occlusion case.
- Keep 1280 × 800, 1440 × 900, and 1920 × 1080 desktop review points, open/closed side panels, DPR variants, day/night/storm, reduced motion, empty/one/24/100 agents, and GPU fallback/recovery.
- Run `verify:render` for every `src/` tranche and judge it on the maintained server. Asset changes also require `sprites:audit-refresh`, fresh captures/visual diff, and appropriate building/terrain validation.
- Use existing performance captures with Chromium/GPU/OS/hardware, viewport/DPR/zoom, power state, warm-up, p50/p95, uploads, and resource bytes. Require no unexplained regression against the same scenario/hardware; do not advertise universal FPS from a badge or screenshot run.
- Keep the long pressure soak as a release gate. This review did not run it and does not close OF-006.

## 9. Advanced graphics: worthwhile experiments and explicit deferrals

“State of the art” here should mean excellent visual judgment backed by stable rendering. The best advanced experiment is already enabled: a small, carefully authored material/height pilot with coherent light and surface coordinates. The next step, only if that falls short, is a bounded facing-mask experiment on a hero landmark. Measure the image improvement and cost before expanding it.

| Idea | Decision and reopening condition |
| --- | --- |
| WebGPU rewrite | Defer under existing OF-008 until measured WebGL2 batching/attachment/material limits block a valuable result. WebGPU offers modern GPU facilities but does not fix composition or art inconsistency. Feature-detect any future optional path. [MDN WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) |
| OffscreenCanvas/worker renderer | Defer under OF-007 until profiling demonstrates unresolved main-thread contention after removing known dead work. Preserve existing ownership and fallback rather than adding synchronization prematurely. |
| Full PBR/normal maps, SSAO, depth of field, stronger bloom, more particles | Defer. Current source art and operator readability need improvement first; these can obscure silhouettes or conflict with baked lighting. Reopen only for a specific approved scene that simpler material masks cannot deliver. |
| Larger map or elaborate biome system | Defer. Improve existing work-area spacing and crowd representation. `world:validate-terrain` is the authority on cache reserve; increasing map size is not a crowd UX fix. |
| Whole-roster regeneration | Defer until the small art pilot is approved in motion and actual UI niches. Preserve recognizable provider families and recent grip improvements. |
| Another renderer abstraction, ECS, frontend framework, runtime dependency | Not justified. Reuse existing drawable, category, material, event, cache, and identity contracts. |
| More caching/schedulers | Revisit only demonstrated remaining cold/change paths. The async Git worker, bounded parser caches, and several old deferred optimizations already exist. Continue OF-001's residual synchronous paths rather than building a second worker. |

GPU tuning should continue to respect texture/resource budgets, compatible draw batching, optional capabilities, and avoidance of blocking readback in normal frames. These principles match [MDN's WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices); the repository already implements many of them. No benchmark or API trend overrides the requirement that the resulting image communicate work clearly.

## 10. Recommended first implementation scope

Start with **T1–T5, V2, and the U1 status-column fix**. They address specific defects with reviewable outcomes and establish a reliable baseline. Then complete **V1/V3/V4** and the **V6 art pilot**. This sequence delivers visible improvement and better provider trust without committing the project to a new rendering platform or another broad rewrite.

The complete refinement succeeds when an operator can identify who needs them, understand why, inspect the relevant detail, and enjoy watching the village—across all supported CLI/model combinations, ordinary desktop sizes, renderer fallback, and reduced motion.


## 11. Execution record · September 5, 2026

The maintainer authorized the full plan. The primary agent coordinated independent Astra runtime, renderer, and UI work, then reviewed their combined behavior. The checkout remains on the original branch, without a release/version bump, commit, or push. No runtime dependency or build step was added. Existing live provider stores were not edited; write-path regressions use isolated synthetic homes and browser contexts.

### Implemented work

| Item | Result | Evidence / maintained owner |
| --- | --- | --- |
| T1 | Broad account pressure no longer impersonates exact session enforcement. An unanswered question survives unrelated exhausted quota. Exact transcript enforcement remains authoritative. | `usageQuota.js`, `StatusResolver.js`, `astra-runtime.test.mjs` |
| T2 | Hook lookup is provider-qualified and resolves Codex rollout filename/thread aliases and Gemini payload aliases. Identical raw IDs in different CLIs cannot cross-apply. | Realistic filesystem fixtures through HTTP and the actual WebSocket client; `hooks.js`, adapters, `astra-runtime.test.mjs` |
| T3 | Grok discovers recent transcript writes inside old directories and invalidates cached presentation on transcript changes. | Old-directory/fresh-transcript, append/cache-hit/result fixtures |
| T4 | Simulation chooses its database before foundation boot and uses separate BroadcastChannel and capture/biography/affinity leases. It does not request real account usage. | `simulation-isolation.test.mjs`; `verify:render` now exercises real simulated token/cost, founding and biography writes while a second tab's live history and leases remain unchanged |
| T5 | TopBar consumes canonical village state; simulated sessions say SIMULATED. Unknown/non-numeric FPS is hidden. Snapshot timestamps and polling provenance remain explicit. | Village reducer, TopBar and render regressions |
| T6 | Failed provider/detail reads preserve bounded last-good content for 60 seconds with freshness/age, including through watcher invalidation. Residency cannot extend that retention. Token/cost availability is explicit, unavailable cost is null, and totals disclose incomplete current-session coverage. | Failure, recovery, empty success and expiry fixtures; `TokenUsage.js`, ActivityPanel, Dashboard and TopBar |
| T7 | Lifecycle certainty, source time and stale signals are preserved. Supported Grok/Gemini native events and hooks distinguish working/approval/result states. Approvals stale after 10 seconds, expire within 30 minutes, and clear on resolving events; dwell alone cannot invent approval. | Cross-provider lifecycle fixtures, hook residency tests and updated adapter/troubleshooting docs |
| V1 | GPU renders ground semantic cues in terrain order and upper annotations/x-ray once. The shared cue surface is bounded to 1024 pixels on its longest edge, omitted when empty and reused until dirty, including relationship/crowd/lighting changes under reduced motion. Selected occlusion covers the actual behind-building range. | `WorldFrameRenderer.js`, renderer semantic fixtures, controlled council GPU readback and corrected pinned occlusion capture |
| V2 | Plaques anchor to sprite anchors and the existing first-opaque-row mask; gaps/collision offsets use CSS-pixel scale, and leaders reconnect to the owning structure. | `BuildingSprite.js`; day/night landmark captures |
| V3 | Canvas, GPU and inverse hit testing share one snapped render translation across DPR variants. | Camera/GPU regressions and maintained DPR verification |
| V4 | Water and wet-surface detail sample stable world/surface coordinates, eliminating camera-attached pattern phase. | GPU shader and pan review |
| V5 | Ornament timing uses the shared motion clock. Measured body/direction lag justified priority atlas refreshes while ordinary animation retains its bounded cadence. | Controlled Codex turn probe, motion recording and renderer regressions |
| V6 | Forest canopies reuse authored oak/pine/willow pixel art at integer scale instead of smooth procedural fills. Static variants share at most six cached surfaces. Central canopy density and ground accents are quieter. | Foliage/scenery source, sprite and terrain/building checks, district day/night captures |
| V7 | Retained a narrow exact-palette material pilot: Terra cloth/armor/skin, Sonnet cloth/fittings/skin/crystal, and Command stone/crimson cloth/foliage. Albedo and emission bytes remain unchanged. Explicit class-zero material presence is fixed in the shader. | Three day/dusk/rain cuts, Canvas lighting-off control, uniform-material comparison, channel authoring audit and GPU class-zero readback |
| V8 | Authored coverage overrides default height in both directions, including zero. Strength has its own raw channel and is per record. An authored source is submitted even when its fallback defaults are zero. | Direct GPU readback: low 26, zero 0 and tall 230 remain distinct; the same receiver is darker behind tall geometry; reduced strength weakens that shadow |
| V9 | GPU supports compact ordinary bodies; crowded local groups and mass arrivals use bounded individual protection. Selected, hovered and action-needed agents remain individually visible. Automatic framing is restrained while explicit user/detail zoom remains available. | 24/100-agent arrival/settled captures, crowd census, group interaction and short same-host benchmark |
| U1 | Body text, status and elapsed columns remain legible at fixed desktop widths. The header shows exact NEEDS YOU separately from generic WAITING. Long panel statuses wrap, provenance gets a complete line, and healthy-empty World becomes a compact banner with duplicate boot chrome removed. | 1280/1440/1920 checks; sampled composited text contrast 5.28–8.60:1, status 6.82:1 |
| U2 | Search includes session/model/CLI/vendor/project/team identity. Unknown providers use a neutral badge. | Search tests and the seven-CLI fixture, including OpenCode-hosted OpenAI and OMP-hosted Z.AI |
| U3 | Native disclosures expose available long messages/tool inputs without destructive refreshes; cached detail retains age. Same-content refresh preserves disclosure state, keyboard focus and selected text. | Enter-key and 1,202-character selection regression; upstream explicitly truncated content remains labeled as an excerpt |
| U4 | Avatars preserve source proportions. Repeated DOM tool/district marks use existing pixel SVGs; canvas/domain identity stays in its existing owner. | Avatar and UI regressions |
| U5 | Selected-only animation no longer performs obsolete visibility scans. Ownership/contract docs were reconciled. Deferred panel construction now honors current mode and the collapsed sidebar count updates immediately. | UI lifecycle tests and architecture/artifact checks |

### Review decisions and limits

The foliage and three-asset material pilots were reviewed in-engine. Retain their restrained separation and the existing albedo; do not expand to the roster without another visible comparison. Command's shared masonry/door palette stays stone because exact RGB alone cannot identify those regions reliably. Existing character occluders remain flat authored height zero; this work does not claim raised anatomical depth. Full facing masks, normal maps, PBR, stronger bloom, WebGPU, workers and map enlargement remain the explicit conditional deferrals in section 9.

The capture harness now actually applies each declared camera center. Static material/occlusion studies explicitly pin actor poses; previously the arrival system could put the intended subject at the gateway. Such pinned stills are art/semantic evidence, not a locomotion performance benchmark. Sprite art captures suppress onboarding/empty-state chrome, which the interactive smoke verifies separately. A repeated art comparison exposed adaptive quality changing night-lighting under host load; the art harness now pins FULL, while performance runs keep the normal adaptive ladder.

The long pressure soak remains a release gate under OF-006. It is not closed by short frame profiles or the implementation tests. No universal FPS, complete browser certification or measured whole-UI contrast compliance is claimed.

### Final validation

All 21 implementation items above are complete within their stated pilot boundaries. [Retained evidence](research/claudeville-astra-refinement/README.md) includes the material/occlusion/crowd cuts, 1280 desktop review, motion recording, keyboard enumerations, renderer diagnostics and raw performance profiles.

| Final check | Result |
| --- | --- |
| `npm run validate:full` | Passed: 781 unit tests, both integration replays, architecture/syntax/adapter/theme checks, server boot/security/fatal smoke, world buildings/terrain, sprite manifest |
| `npm run verify:render` | Passed after the combined implementation: World, Dashboard, selection, panel, deselection and real simulator history-write isolation; no console/page errors or failed requests |
| `npm run sprites:audit-refresh` | Passed: 28 authoring profiles, 92 expected companion PNGs; zero channel errors/warnings |
| Fresh captures + `sprites:visual-diff` | All 20 reviewed day/night baselines passed repeat capture with zero changed pixels at pinned FULL quality |
| `node scripts/smoke/astra-height-smoke.mjs` | Passed actual GPU geometry, strength and explicit material-zero readback |
| `world:verify-dpr` | All five viewport/DPR combinations passed; camera unit coverage also includes 1, 1.25, 1.5 and 2 |
| Maintained desktop judgment | World/Dashboard and seven-provider identities reviewed; detail/search/keyboard checks at 1280/1440/1920; selected occlusion and 24/100-agent access verified |
| Documentation/artifacts/diff hygiene | Final owner docs and retained-artifact index reconciled; checks passed |

The turn probe originally reproduced three stale atlas poses out of three rapid direction changes; the final direction/tool/pan sequence had zero stale poses over 24 changes. A public `Agent.update({ lastMessage })` getter-assignment defect found by the fixture probes was also corrected at the shared update boundary, with a simulator→World regression.

The same-host short benchmark compared archived `65a4ce0` with the final renderer. At 24 agents, frame p95 changed **50.4 → 42.2 ms** and resident textures **99.65 → 120.75 MB**; at 100, **117.1 → 66.6 ms** and **117.29 → 144.27 MB**. Extra geometry and ground-cue textures raise upload EMA from **0.551 → 1.343 ms** / **3.824 → 4.349 ms**, respectively. Each is one five-second sample following three seconds of warm-up on the shared M5 Pro host; 100-agent timing is still above 60 ms p95. These results support the bounded tradeoff without claiming universal smoothness or release-soak completion.

The maintained port-4000 process was left running because it predated this task. Frontend changes were judged there; isolated servers loaded and verified the new backend modules. Restart the maintained server to activate those backend changes. The explicit advanced experiments and OF-006 release soak remain deferred as originally specified; this implementation does not close them.


## 12. Release verification · v0.42.0 — The Astral Lens

The maintainer requested publication as v0.42.0. This record supersedes the deferred-soak status in the initial implementation record above. The advanced graphics experiments remain conditional; OF-006 is satisfied for this release and remains a recurring check for future releases.

Release verification found and fixed two additional lifetime issues: repeated reduced-motion reads retained native query listeners, and completed image loads retained their callbacks. Browser probes changed 100 motion reads from 100 retained listeners to one, and retained 103 loaded/fallback images with zero completed load listeners. Success, failure, fallback and abort regressions pass. The Git-worker queue test now waits for bounded completion instead of sampling after a fixed 900 ms.

The final `gate:release` passed **783 unit tests**, both integration tests, version/architecture checks and server smoke. Render smoke passed after the image cleanup. The prior 20/20 art baselines and graphics checks remain applicable; the release corrections do not alter art.

The [release soak report](research/claudeville-astra-refinement/release-soak.json) records a complete 10-minute browser run and a separately validated 30-minute server trace from identical backend code. The final frontend ran on a second fresh process; earlier browser traces are not claimed as passes. Browser retained listeners started and ended the steady window at 145, event-bus listeners remained 138, and worst projected heap growth was 1.81 MB against the 8 MiB limit. The server's event-loop p95 peaked at 24.527 ms and steady reconnect latency at 433 ms. Both server RSS slopes were negative.

The audit itself needed two corrections. Native listener sampling now waits behind pending Chronicle writes and takes a bounded three-sample floor; regression controls preserve detection of a truly retained listener. RSS now compares its final sample with the second-half median rather than a single GC trough. The 64 MiB allowance and both rolling slope limits remain unchanged; ten controls reject sustained growth, late growth, growth with troughs and a terminal spike. The same immutable 31 server checkpoints pass the corrected metric. This is a measurement correction, not a claim that the original command passed unchanged.

Release metadata was prepared by the maintained helper; changelog notes are the publication source of truth. The maintained port-4000 process was left untouched. Restart it to load the new backend after updating.
