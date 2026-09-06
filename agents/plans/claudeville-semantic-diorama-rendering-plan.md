# ClaudeVille semantic diorama rendering plan

**Status:** `implemented and release-verified for v0.33.0`

**Open follow-ups:** See the [live open-followups checklist](open-followups.md)
for the conditional modernization items and their measurement triggers.

**Date:** Aug 21, 2026

**Source critique:** consolidated multi-agent visual, UX, rendering, performance, and tooling review

**Baseline:** main at a10425b (v0.32.0.1 working baseline)

**Implementation verification (Aug 21, 2026):** `validate:quick` passes 141 tests; building, terrain, sprite-manifest, material-channel, context-restoration, lifecycle, and 20-image day/night visual-diff gates pass. The deterministic atlas is byte-stable. A ten-minute headed Chrome 149 / RTX 5070 Ti run at 1920×1080 recorded 77,969 frames, 12.6 ms rAF p95, 100% FULL quality, 58,830,384 peak GPU bytes under the 64 MiB gate, flat ownership, and zero console warnings or errors. Canvas fallback remains complete through `?renderer=canvas` and `?postfx=0`.

## Goal

Make World mode substantially more compelling, beautiful, spatially coherent, and glanceable without adding visual noise, losing the pixel-art identity, weakening reduced-motion behavior, or abandoning the zero-build local architecture.

The target outcome is a semantic, GPU-resident WebGL2 diorama:

- every drawable declares what it is, how important it is now, and how it receives light and weather
- routine work becomes quiet while selected and action-needed agents remain unmistakable
- terrain, landmarks, props, and agents remain resident on the GPU instead of uploading one flattened Canvas-2D frame every render
- light, fog, rain, reflections, and shadows interact with authored surfaces and occluders
- labels, bubbles, primary marks, debug information, and equivalent structured detail remain in the ungraded DOM/Canvas overlay
- Canvas-2D remains a first-class fallback until the new path proves parity and performance

## Biggest lever

Do not add another independent effect family.

Promote the current depth-drawable stream into a semantic render graph with two new contracts:

1. **Salience:** selected, needs-user, errored, recent, working, or ambient. Salience controls overlay admission, label detail, particle density, light emphasis, and camera priority.
2. **Material and elevation:** surface kind, emissive contribution, height/occlusion, and optional authored material data. These control lighting, fog, wetness, reflection, and shadow behavior.

The first vertical slice is a unified screen-space salience governor. It immediately exposes more of the existing village art.

The strategic slice is a GPU-resident WebGL2 world renderer. It removes the full-frame Canvas upload and gives the atmosphere engine enough scene information to create spatially truthful depth.

## Why this direction

### Current strengths to preserve

- The village is distinctive, authored, and emotionally on target.
- Waiting-on-user escalation already works across words, form, camera, sidebar, topbar, and dossier.
- World and Dashboard share stable provider, model, project, status, and selection identity.
- DrawablePass already centralizes painter-order rendering.
- BuildingVisualRegistry and LightSourceRegistry already hold semantic landmark and light metadata.
- WorldFrameRenderer already separates world drawing, post-processing, and ungraded overlay work.
- The post-FX ladder, Canvas budget, deterministic scenarios, context-loss handling, and reduced-motion policy provide strong engineering guardrails.

### Current bottlenecks

- World remains in full agent-render mode below 50 agents, even when projected overlays already saturate the viewport.
- Agent bubbles, building plaques, relationship marks, route text, particles, and light emphasis make separate admission decisions.
- Dashboard expands transcript/tool history before operator triage.
- The WebGL2 stage receives one flattened scene texture, a water mask, lights, haze, sun, and incident pulse. It has no material, emissive, height, or occlusion channel.
- The complete Canvas-2D scene is uploaded through texSubImage2D every frame.
- Local 1920x1080 review profiling saw the post-FX ladder reach disabled under both one-agent and dense-100 cases; the dense upload cost became much larger than the intended four-millisecond FX budget.
- Trail screen-cache repainting becomes expensive during camera motion because camera-pose changes invalidate the cache.
- IsometricRenderer.js, AgentSprite.js, and BuildingSprite.js are already large enough that cross-cutting features should use existing seams rather than add more branches.

### State-of-the-art decision

- WebGL2 multiple render targets are mature and widely available.
- WebGPU has a higher eventual ceiling but remains a compatibility and dual-backend burden for a local Linux-capable tool in August 2026.
- PixiJS is credible for a greenfield renderer, but porting ClaudeVille's custom camera, semantic simulation, painter ordering, hit testing, fallbacks, and effects would add abstraction churn without removing the need for an authored material contract.
- OffscreenCanvas is a valid conditional optimization if profiling after the GPU migration still shows main-thread contention.

References:

- https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/drawBuffers
- https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices

## Guardrails

- Keep the zero-build vanilla JavaScript architecture.
- Add no runtime framework or mandatory runtime dependency.
- Preserve local-only, read-only product behavior.
- Preserve desktop-only behavior at widths of 1280px and above.
- Keep World as the brand surface and Dashboard as the precision surface.
- Preserve integer-snapped pixel rendering and nearest-neighbor sampling.
- Do not introduce smooth PBR shading that fights the authored painterly pixel ramps.
- Keep labels, bubbles, primary attention marks, weather foreground, and debug UI outside grading and distortion.
- Preserve the current Canvas-2D fallback until the new renderer clears all gates.
- Keep reduced-motion meaning static and complete. Do not allocate continuous particles, glides, path walkers, or animated material resources when motionScale is zero.
- Use the existing event bus, camera, domain World, selection plumbing, and deterministic fixtures.
- Do not increase MAP_SIZE beyond 40 until terrain cache chunking exists.
- Do not regenerate the complete sprite inventory. Prove the material contract on a small hero set first.
- Recheck named source paths before implementation; line numbers will move.

## Non-goals

- No full WebGPU-first rewrite.
- No PixiJS port in this program.
- No mobile or responsive redesign.
- No photorealistic lighting or anti-aliased vector aesthetic.
- No new ambient effect family merely for spectacle.
- No complete rebake of all characters, props, or terrain before the pilot proves value.
- No accessibility scope expansion beyond an inexpensive semantic World summary, keyboard discoverability, legible DOM surfaces, and preserved reduced motion.

## Execution order

| Order | Package | Priority | Effort | Depends on |
| ---: | --- | --- | --- | --- |
| 0 | Freeze visual and performance baselines | P0 | 3-5 days | None |
| 1 | Repair camera-motion and FX performance floor | P0 | 1-2 weeks | Package 0 |
| 2 | Unify scene salience and overlay LOD | P1 | 1-2 weeks | Package 0 |
| 3 | Compact Dashboard triage and inspection semantics | P1 | 1 week | Package 2 vocabulary |
| 4 | Define semantic drawable and material contracts | P1 | 1-2 weeks | Packages 0-2 |
| 5 | Build deterministic atlas and sidecar tooling | P1 | 1-2 weeks | Package 4 |
| 6 | Introduce the GPU-resident World parity path | P1 | 4-7 weeks | Packages 1, 4, 5 |
| 7 | Add material-aware lighting and weather | P1 | 3-5 weeks | Package 6 |
| 8 | Roll out hero art and action vocabulary | P2 | 2-4 art-weeks | Package 7 |
| 9 | Conditional worker/WebGPU experiments and polish | P3 | 1-2 weeks | Packages 6-8 |
| 10 | Run the release verification gate | P0 | 3-5 days | All mandatory packages |

Packages 2 and 3 may proceed in parallel with Packages 4 and 5 once Package 0 freezes the same visual baselines. Package 6 must establish parity before Package 7 adds new appearance.

## Package 0 — Freeze visual and performance baselines

**Owned paths:** deterministic capture scripts, World scenarios, performance diagnostics, output-only review artifacts, world visual QA documentation

### Implementation checklist

- [ ] Select one reference Chromium build and one reference desktop machine.
- [ ] Record viewport, device-pixel ratio, browser zoom, GPU, driver, OS, and power state with each performance baseline.
- [ ] Capture normal, dense-24, dense-100, no-agent, one-agent, waiting-on-user, errored, selected-behind-building, and building-inspection-replay scenarios.
- [ ] Capture clear noon, dusk, torchlit night, rain, storm, and storm-night-reduced-motion.
- [ ] Capture at 1920x1080 and 2560x1440; retain 1440x900 for the minimum practical second-screen composition.
- [ ] Record frame/update/render p50 and p95, post-FX upload/CPU/GPU timing, ladder level, texture bytes, visible/cached canvas pixels, frame failures, and trail repaint timing.
- [ ] Freeze three north-star stills: clear day, torchlit night, and an action-needed storm/incident scene.
- [ ] Freeze one normal-live and one dense-live overlay census: visible bubbles, labels, plaques, marks, and particles by tier.
- [ ] Add a small capture manifest describing scenario, atmosphere, camera pose, zoom tier, and expected focal subject.
- [ ] Record the current Canvas fallback and post-FX output separately.

### Acceptance

- [ ] Every later visual change can be compared against deterministic source and fallback frames.
- [ ] Performance numbers identify hardware and are never presented as universal browser results.
- [ ] North-star frames are approved before material or asset production begins.
- [ ] No baseline capture mutates provider session data.

## Package 1 — Repair the camera-motion and FX performance floor

**Owned paths:** TrailRenderer.js, PostFx.js, PostFxLadder.js, PostFxFeed.js, CanvasBudget.js, DebugOverlay.js, focused unit/performance scripts

### Implementation checklist

- [ ] Profile trail repaint cost separately for a stationary camera, manual pan, selected-agent follow, and CameraDirector glide.
- [ ] Stop repainting every non-selected trail into a screen-space cache on every camera-pose change.
- [ ] Prefer a world-space trail cache transformed by the camera.
- [ ] If a world-space cache is too broad for the first slice, freeze or cull non-selected historical trails during glides and render only selected/action-needed recent segments.
- [ ] Keep live path endpoints and semantic destination cues visible while historical trails are reduced.
- [ ] Include PostFx textureBytes and every future GPU attachment in the unified renderer budget.
- [ ] Expose full-frame Canvas upload time separately from shader CPU/GPU time.
- [ ] Make the ladder explain its latest degradation reason in diagnostics.
- [ ] Confirm that post-FX level changes do not modify semantic overlay visibility.
- [ ] Keep MAP_SIZE at 40 and document the remaining terrain-cache margin.
- [ ] Add focused unit coverage for any new degradation thresholds or trail admission policy.

### Acceptance

- [ ] Normal-world frame p95 is at or below 16.7ms on the reference machine.
- [ ] Dense-100 frame p95 is at or below 25ms on the reference machine.
- [ ] Camera glides no longer spend most of the frame repainting trails.
- [ ] Waiting-on-user and selected routes remain understandable at every trail degradation level.
- [ ] No new unbounded canvas, texture, trail, or timer ownership.

## Package 2 — Unify scene salience and overlay LOD

**Owned paths:** MarkGovernor.js or a new SceneSalienceGovernor.js, WorldFrameRenderer.js, AgentSprite.js integration points, BuildingSprite.js integration points, VillageDirectorOverlay.js, CouncilRing.js, CrowdClusterOverlay.js, ParticleSystem.js, IsometricRenderer overlay assignment

### Semantic policy

| Tier | Canonical states | Contract |
| --- | --- | --- |
| Primary | needs-user, errored, selected | Never culled; language and a non-color cue survive reduced motion |
| Recent | new completion, arrival, handoff, failed push, release | Time-bounded; may preempt working/ambient but not primary |
| Working | active tool, relationship/talk, current route | Capped by screen occupancy and hidden textually unless useful |
| Ambient | idle life, decorative motes, intrinsic building activity | First to dim and cull |

### Implementation checklist

- [ ] Generalize MarkGovernor into a scene-level governor with one begin-frame admission state.
- [ ] Give agent bubbles, tool labels, name tags, building plaques, route text, relationship marks, incident marks, particles, and local light emphasis a declared semantic tier.
- [ ] Admit all screen-space annotations through shared region occupancy and collision data.
- [ ] Make primary marks bypass culling but still participate in occupied-rectangle avoidance.
- [ ] Replace the hard full-render threshold below 50 agents with a pressure score based on projected sprite occupancy, overlay area, collisions, zoom, and viewport.
- [ ] Define full, compact, and minimal annotation vocabularies independently from sprite rendering quality.
- [ ] In normal ambient mode, show routine tool text only on hover, selection, or recent change.
- [ ] Preserve building identity at zoom 1 with silhouette and a single plaque or tally, not duplicate labels.
- [ ] Merge repeated routine bubbles by semantic identity before allocating slots.
- [ ] Make selected and needs-user agents reserve their label rectangles before buildings and routine agents.
- [ ] Let primary salience lower ambient particle density and decorative light emphasis in the surrounding region.
- [ ] Preserve a static reduced-motion version of every semantic cue.
- [ ] Add pure unit tests for tier ordering, collision pressure, compact transitions, and deterministic admission.

### Acceptance

- [ ] The normal 17-agent scene exposes materially more village art.
- [ ] The dense-24 scene has no clusters of mutually obscuring full tool bubbles.
- [ ] Needs-user, error, and selection remain immediately recognizable without motion or color alone.
- [ ] Overlay LOD does not flicker while agents move within one pressure band.
- [ ] No routine label can occlude a primary label.
- [ ] Dense-100 remains selectable and semantically truthful.

## Package 3 — Compact Dashboard triage and inspection semantics

**Owned paths:** DashboardRenderer.js, dashboard.css, ActivityPanel.js, TopBar.js, Camera.js, CameraDirector.js, IsometricRenderer selection plumbing, shared copy/formatter helpers

### Implementation checklist

- [ ] Define one operator vocabulary:
  - Needs you: explicit human intervention
  - Waiting: system, tool, quota, or external dependency wait
  - Errored: failed execution or unrecovered failure
  - Working: active session work
  - Visiting, roaming, or at a landmark: idle world behavior
- [ ] Rename ATTN to NEEDS YOU in visible copy.
- [ ] Prevent idle ambient movement from producing “Working at...” journey language.
- [ ] Add a cross-project attention queue above Dashboard project sections.
- [ ] Order the queue Needs you, errored/rate-limited, high burn, working, quiet.
- [ ] Default cards to compact dossiers: identity, actionable reason, current task, elapsed time, and burn/headroom.
- [ ] Expand message and tool history only for the selected card.
- [ ] Remove nested per-card scrolling from the compact state.
- [ ] Preserve current detailed content in the expanded state; do not discard diagnostic value.
- [ ] Save the current camera pose when an agent enters inspection.
- [ ] Compose inspection against a panel-safe viewport rectangle and keep one nearby landmark or route context visible.
- [ ] Let routine building plaques yield around the selected agent.
- [ ] Restore the saved overview pose when inspection closes unless the user manually moved the camera while inspecting.
- [ ] Add a compact World controls/grammar popover covering attention cycle, frame, pan, zoom, replay, follow, and Escape.
- [ ] Add an inexpensive DOM semantic summary for the World canvas and announce needs-user selection changes.

### Acceptance

- [ ] Dashboard shows at least twice as many normal-live agents above the fold at 1440x900.
- [ ] No card contains an inner scrollbar until explicitly expanded.
- [ ] A user can answer “who needs me, what is wrong, and what is burning context?” from one locus.
- [ ] Selection close restores orientation without fighting manual camera input.
- [ ] World shortcuts are discoverable without reading repository documentation.

## Package 4 — Define semantic drawable and material contracts

**Owned paths:** DrawablePass.js, BuildingVisualRegistry.js, LightSourceRegistry.js, AssetManager.js, SpriteRenderer.js, manifest.yaml, palettes.yaml only if required, new focused material registry modules and validators

### Drawable contract

Extend the existing drawable record without forcing every caller to author every field:

~~~js
{
  kind,
  sortY,
  sortBand,
  stableKey,
  salience,
  materialId,
  elevation,
  emissive,
  occluder,
  atlasFrame,
  drawFallback(ctx, zoom, context),
  buildGpuRecord(context)
}
~~~

### Material contract

Start with optional channels and deterministic defaults:

- albedo: existing authored sprite
- material class: stone, timber, metal, foliage, fabric, earth, cobble, water, glass/rune, fire
- emissive: zero by default; authored windows, runes, forge, lanterns, portal, beacon
- elevation/occluder: flat silhouette default; authored hero profile when it materially improves light/fog
- normal or directional response: optional and late; use only where palette-stepped light visibly improves the asset

### Implementation checklist

- [ ] Add optional manifest fields for atlas frame, material sidecar, emissive sidecar, height/occluder sidecar, and declared material class.
- [ ] Define deterministic path rules for companion assets.
- [ ] Extend manifest validation for dimensions, frame count, anchors, alpha bounds, and known material identifiers.
- [ ] Ensure missing sidecars use safe defaults and never produce checkerboard output.
- [ ] Reuse existing BuildingVisualRegistry window, light, emitter, grounding, and effect anchors to seed hero metadata.
- [ ] Preserve LightSourceRegistry as the semantic light authority.
- [ ] Define the warm upper-left authored key-light convention and quantized response bands.
- [ ] Specify that nearest sampling is mandatory for albedo and sidecars.
- [ ] Specify where low-resolution masks are acceptable and where one authored pixel must remain one renderer pixel.
- [ ] Pilot Command, Portal, Harbor, Forge, lantern/brazier props, water, one Claude agent, and one Codex agent.
- [ ] Add channel-debug visualization to Shift-D.
- [ ] Document the contract before bulk art generation.

### Acceptance

- [ ] Assets without sidecars render identically through Canvas fallback and GPU defaults.
- [ ] Sidecars align at every integer zoom tier and direction/frame.
- [ ] Every emissive region has a named semantic source.
- [ ] No new building type requires a branch in IsometricRenderer.js.
- [ ] The pilot stays below approximately 15-20 sidecar assets.

## Package 5 — Build deterministic atlas and sidecar tooling

**Owned paths:** scripts/sprites/, manifest validator, generated atlas output under the existing sprite asset hierarchy, sprite runbook and visual-diff tooling

### Implementation checklist

- [ ] Add a manifest-driven atlas plan command with dry-run output.
- [ ] Bake committed atlas PNG plus deterministic JSON metadata.
- [ ] Preserve original stable asset IDs, anchors, source dimensions, structure masks, and animation frame tags.
- [ ] Keep character direction and animation row contracts intact.
- [ ] Pack albedo and sidecars with identical frame rectangles.
- [ ] Seed emissive masks from existing window/light anchors where possible, then require visual review.
- [ ] Provide a small channel-paint or mask-fix workflow rather than relying on automatic luminance inference.
- [ ] Generate contact sheets for albedo, emissive, material, and height/occluder channels.
- [ ] Detect atlas bleeding, filtered edges, mismatched dimensions, and orphan sidecars.
- [ ] Keep runtime atlas loading dependency-free.
- [ ] Keep broad generation opt-in by reviewed asset IDs.

### Acceptance

- [ ] Rebuilding unchanged source assets produces byte-stable metadata and deterministic frame placement.
- [ ] Sprite validation, manifest audit, and channel validation pass.
- [ ] Canvas fallback can continue loading original assets during migration.
- [ ] Atlas output adds no runtime install or build step.

## Package 6 — Introduce the GPU-resident World parity path

**Owned paths:** a new focused WebGL world renderer directory, WorldFrameRenderer.js integration, DrawablePass.js adapters, AssetManager.js atlas loading, PostFx shader/resource extraction, App.js/IsometricRenderer mount and lifecycle seams, CanvasBudget.js, DebugOverlay.js, focused renderer tests

### Architecture

Target pipeline:

~~~text
Domain World + existing presentation simulation
  -> semantic depth-sorted GPU records
  -> GPU-resident terrain, building, prop, harbor, and agent draws
  -> material-aware grade/light/weather passes
  -> WebGL presentation canvas
  -> independent Canvas-2D overlay for text, primary marks, weather foreground, and debug
~~~

Fallback pipeline remains:

~~~text
Domain World + existing presentation simulation
  -> current Canvas-2D world renderer
  -> current Canvas grade/effects
  -> independent Canvas-2D overlay
~~~

### Implementation checklist

- [ ] Add a query flag such as ?renderer=webgl while preserving ?renderer=canvas.
- [ ] Keep Canvas as the default until parity and performance gates pass.
- [ ] Reuse worldFxCanvas as the WebGL world/presentation context.
- [ ] Extract shader strings, program compilation, textures, targets, and diagnostics out of the current PostFx monolith before expanding it.
- [ ] Upload static terrain and atlas textures once per asset/camera-relevant revision, not once per frame.
- [ ] Convert existing DrawablePass records into GPU quad records while preserving sortY, sortBand, kind, and stableKey order.
- [ ] Batch consecutive records that share atlas, shader, blend mode, and material state without reordering painter semantics.
- [ ] Preserve CPU pathfinding, movement, simulation, hit testing, hover, selection, and camera calculations.
- [ ] Preserve pixel-aligned camera zoom tiers and snapped destination positions.
- [ ] Keep worldOverlayCanvas responsible for text, bubbles, primary marks, weather foreground, letterbox, and debug output.
- [ ] Keep semantic overlays readable when the GPU world is unavailable or degraded.
- [ ] Implement context loss, context restoration, resize, mode suspension, page visibility, and App destroy parity before new material effects.
- [ ] Track atlas, vertex/index buffers, framebuffers, material attachments, and auxiliary textures in diagnostics and budgets.
- [ ] Add a renderer parity capture mode that alternates Canvas/GPU from the same frozen scenario state.
- [ ] Add pure unit tests for record conversion, stable batching, draw order, resource ownership, and degradation decisions.

### Acceptance

- [ ] Clear-day GPU captures match approved Canvas composition before new lighting is enabled.
- [ ] The default GPU path performs no full-resolution Canvas-2D-to-GPU scene upload.
- [ ] Integer sprite pixels remain crisp at zoom 1, 2, and 3.
- [ ] Canvas hit testing agrees with GPU-visible positions and occlusion.
- [ ] Mode switches, context loss, hidden tabs, and App teardown leak no canvas, texture, listener, or callback ownership.
- [ ] ?renderer=canvas remains visually and functionally complete.
- [ ] Normal mode remains FULL or REDUCED and dense-100 remains MINIMAL or better on the reference machine.

## Package 7 — Add material-aware lighting and weather

**Owned paths:** focused GPU material/light/weather passes, PostFxFeed semantic data, AtmosphereState integration, BuildingVisualRegistry/LightSourceRegistry data, focused shader/policy tests, visual QA scenarios

### Visual rules

- Baked pixel art remains the albedo authority.
- Lighting modifies authored ramps in restrained quantized bands.
- Bloom follows emissive pixels, not generic bright terrain.
- Local light respects occluders.
- Weather changes receiving surfaces, not the entire frame uniformly.
- Fog respects elevation and never grades overlay text.
- Primary semantic cues remain clearer than all material effects.

### Implementation checklist

- [ ] Add diffuse/material and cached or low-resolution emissive attachments.
- [ ] Start with emissive masks and occlusion; add normal/directional sidecars only when the pilot demonstrates visible value.
- [ ] Make windows, portal runes, forge fire, lanterns, and the lighthouse beacon survive global grading correctly.
- [ ] Add height/occluder-aware local light so landmarks block or attenuate light behind them.
- [ ] Quantize sun response and shadow edges to preserve the pixel vocabulary.
- [ ] Keep contact shadows tied to the existing grounding profiles.
- [ ] Let water, wet cobble, roofs, vegetation, metal, and fabric react differently to rain and phase light.
- [ ] Use material class and elevation to control puddle/reflection eligibility.
- [ ] Use elevation to composite ground fog behind agents/buildings and in front of lower terrain where appropriate.
- [ ] Replace final-frame mirrored reflection hints with receiving-surface-aware reflection.
- [ ] Keep light color roles semantic; status colors do not become decorative illumination.
- [ ] Define degradation order: secondary reflections/rays, weather richness, local occlusion, emissive bloom, grade-only, Canvas fallback.
- [ ] Ensure reduced motion freezes all animated shader phases while retaining static material meaning.
- [ ] Add diagnostics for active attachments, pass timing, light count, occluder count, and degradation reason.

### Acceptance

- [ ] Day, dusk, night, rain, and storm visibly alter materials rather than merely tinting the same frame.
- [ ] No light appears through an authored hero occluder in the pilot scenes.
- [ ] No bright non-emissive terrain enters the bloom chain.
- [ ] Waiting-on-user, error, and selection remain the highest-salience visual states.
- [ ] Pixel edges and authored palette relationships remain intact.
- [ ] Reduced-motion captures convey the same semantic state without animated material phases.
- [ ] Canvas fallback remains equivalent to the current v0.32 meaning.

## Package 8 — Roll out hero art and action vocabulary

**Owned paths:** selected manifest entries, sidecar assets, character/equipment overlays, sprite validation/contact sheets, BuildingVisualRegistry metadata, no broad renderer branching

### Implementation checklist

- [ ] Review the pilot in clear day, torchlit night, rain, and storm before expanding art scope.
- [ ] Author material/emissive/height data for all nine landmarks.
- [ ] Prioritize lanterns, braziers, portal, forge, harbor, bridges, wet paths, and hero vegetation.
- [ ] Audit procedural tropical/broadleaf scenery against the asset-backed pixel edge, silhouette, and shading language.
- [ ] Replace procedural scenery only where it remains a visible style outlier.
- [ ] Define a shared action vocabulary: read, type/work, think, talk, and celebrate.
- [ ] Prototype actions on one Claude and one Codex class using modular overlays or a small hero sheet.
- [ ] Keep the simulation cadence and semantic event sources unchanged.
- [ ] Do not multiply action sheets across all models until the first classes improve comprehension and delight.
- [ ] Regenerate only assets that fail the approved material/scale contract after sidecars are applied.
- [ ] Produce contact-sheet and in-world day/night evidence for every rollout batch.
- [ ] Commit assets in small semantic batches.

### Acceptance

- [ ] All nine landmarks remain distinguishable at zoom 1 in clear day, night, and storm.
- [ ] Every visible emissive feature has a corresponding authored source.
- [ ] Action poses read at medium distance without relying on tool text.
- [ ] Character identity remains stable across reload, direction, animation, Dashboard avatar, and World.
- [ ] No broad sprite refresh ships without visual-diff evidence.

## Package 9 — Conditional modernization and polish

**Owned paths:** only paths justified by measurements after Package 8; controls/legend UI; small CSS and token fixes; experimental renderer code remains behind flags

### Implementation checklist

- [ ] Reprofile main-thread time after the GPU-resident path is complete.
- [ ] Move appropriate rendering work to OffscreenCanvas only if main-thread contention remains material.
- [ ] Preserve DOM input, selection, and accessibility ownership on the main thread.
- [ ] Prototype WebGPU only if WebGL2 batching, attachment limits, or material passes remain a measured blocker.
- [ ] Keep WebGPU experimental until browser support, context behavior, and fallback cost are acceptable on the actual target systems.
- [ ] Do not duplicate visual logic across WebGL2 and WebGPU; share semantic records, material data, and visual policy.
- [ ] Correct the active mode-button hover contrast state.
- [ ] Replace the Activity Panel context-bar width animation with a transform-based fill.
- [ ] Move the eight plausible semantic color literals onto the canonical theme authority.
- [ ] Leave specialized foliage, light, monument, and seasonal art colors local when they are intentionally authored.
- [ ] Remove duplicate empty-state legend copy.
- [ ] Collapse empty token cells into one “No usage data” row.
- [ ] Run a final overlay census and remove any effect that does not improve meaning or emotional payoff.

### Acceptance

- [ ] Every modernization task cites a before/after measurement or a concrete visual defect.
- [ ] No experimental backend becomes mandatory without equivalent fallback behavior.
- [ ] Detector rerun has no unresolved plausible token drift, contrast conflict, or layout-property animation.
- [ ] Empty, normal, attention, dense, and inspection states retain one clear focal hierarchy.

## Package 10 — Release verification gate

**Owned paths:** validation scripts, deterministic baselines, focused unit tests, release notes and version files only when a release is explicitly requested

### Required commands

Run validation appropriate to touched files:

~~~bash
npm run validate:quick
npm run world:validate-buildings
npm run world:validate-terrain
npm run sprites:audit-refresh
npm run sprites:capture-fresh
npm run sprites:visual-diff
~~~

Run focused renderer and performance coverage added by this program. Keep expensive matrices opt-in, documented, and reproducible.

### Browser matrix

- [ ] World and Dashboard at 1280x800, 1440x900, 1920x1080, and 2560x1440.
- [ ] Canvas fallback and GPU path.
- [ ] Zoom tiers 1, 2, and 3.
- [ ] Clear day, dusk, fixed night, rain, storm, and reduced motion.
- [ ] No-agent, one-working, real normal-live, dense-24, dense-100.
- [ ] Waiting-on-user, errored, failed-push, release-parade, team-gather, parent-subagents.
- [ ] Selected-behind-building and panel-safe selected inspection.
- [ ] Camera glide, manual pan/zoom interruption, follow, deselect, and pose restore.
- [ ] World to Dashboard transitions and repeated renderer suspension/resume.
- [ ] WebGL context loss/restoration and forced Canvas fallback.
- [ ] Browser console clean after every representative case.

### Release acceptance

- [ ] No full-resolution Canvas-2D-to-GPU scene upload in the default GPU path.
- [ ] Post-FX/material rendering remains FULL or REDUCED for at least 95% of a ten-minute normal session.
- [ ] Dense-100 never reaches DISABLED on the reference machine.
- [ ] Normal-world p95 is at or below 16.7ms and dense-100 p95 at or below 25ms on the recorded reference configuration.
- [ ] Dashboard shows at least twice as many normal-live agents above the fold at 1440x900.
- [ ] Needs-user, error, and selection are recognizable without color or motion alone.
- [ ] All nine landmarks remain distinct at zoom 1 across clear day, night, and storm.
- [ ] Reduced motion allocates no continuous particles, camera glides, path walkers, or animated material resources.
- [ ] Renderer, texture, canvas, listener, timer, and worker ownership return to baseline after mode switches and App teardown.
- [ ] A new landmark requires registry, manifest, and authored assets rather than new IsometricRenderer branches.
- [ ] Canvas fallback remains complete and documented.

## Milestones

### Milestone A — Quiet village, stronger triage

Packages 0-3.

Expected duration: 2-3 engineering weeks.

Ships independently if approved. This is the fastest meaningful visual improvement and validates the semantic salience contract before the renderer migration.

### Milestone B — GPU parity

Packages 4-6.

Expected duration: 6-10 engineering weeks after Milestone A, with atlas/tool work parallelized where ownership is disjoint.

Does not add new visual effects until screenshot parity, lifecycle, and performance gates pass.

### Milestone C — Material village

Packages 7-8.

Expected duration: 3-5 engineering weeks plus 2-4 technical-art weeks, with hero batches reviewed independently.

This is the major visual-ceiling release: spatially truthful light, fog, rain, reflection, and emissive response.

### Milestone D — Conditional modernization and release

Packages 9-10.

Expected duration: 1-2 engineering weeks plus the release verification window.

Only measured bottlenecks enter this milestone.

## Parallel ownership opportunities

After Package 0:

- Salience/overlay owner: Package 2
- Dashboard/inspection owner: Package 3
- Manifest/material-contract owner: Package 4
- Atlas/tooling owner: Package 5 after the schema freezes

After GPU parity foundations stabilize:

- Renderer core owner: Package 6
- Shader/material owner: Package 7
- Technical-art owner: Package 8
- QA/performance owner: continuously maintains captures and metrics without changing renderer policy

Avoid concurrent edits to WorldFrameRenderer.js, DrawablePass.js, AssetManager.js, and the post-FX resource core unless ownership boundaries are agreed in advance.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Renderer migration becomes an open-ended rewrite | High | Require Canvas/GPU parity and query-flag delivery before new appearance |
| Material effects wash out the authored pixel style | High | Quantized ramps, nearest sampling, small hero pilot, explicit north-star approval |
| Extra attachments recreate the existing memory problem | High | One documented texture-byte budget, ladder diagnostics, small sidecar scope |
| Painter-order batching changes occlusion | High | Stable record conversion, batch only consecutive compatible records, parity captures |
| Sidecar production balloons across 151 assets | High | Limit pilot to landmarks/hero props; defaults for everything else |
| New beauty reduces glanceability | High | Salience governor ships first and remains authoritative over effects |
| Camera cinematics become distracting | Medium | Preserve idle gates, manual interruption, reduced motion, and saved-pose inspection |
| WebGL path breaks Canvas hit testing | High | Keep CPU world positions authoritative and test visible/hit alignment at every zoom |
| WebGPU exploration forks visual logic | Medium | Share semantic records/material policy; keep backend experimental |
| Dashboard redesign becomes a separate product rewrite | Medium | Compact/expanded dossier only; retain existing detail content and project grouping |

## Definition of done

The program is complete when:

- routine work is calm enough that the village art is visible in normal and dense sessions
- needs-user, errors, selection, and recent consequential events dominate the semantic hierarchy
- Dashboard defaults to triage and expands into transcript detail only on demand
- the default GPU renderer keeps asset-backed world data resident and no longer uploads one flattened Canvas scene each frame
- light, fog, rain, reflection, and shadows react to authored materials and occluders
- the pixel-art palette, integer snapping, silhouettes, and landmark identity remain intact
- performance, memory, context-loss, reduced-motion, lifecycle, and Canvas fallback gates pass
- the implementation uses stable registries and drawable records rather than enlarging the renderer monoliths
- deterministic visual evidence and performance measurements support the release
