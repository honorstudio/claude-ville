# ClaudeVille World-mode rendering review — 2026-09-01

Scope: `claudeville/src/presentation/character-mode/**` (Canvas 2D base, WebGL2 `gpu/GpuWorldRenderer`, `postfx/`), `css/character.css`, sprite manifest, rendering docs. Read-only; no repo file was edited. Every `file:line` below was read in this checkout (`e7737d5`, v0.37.0).

Evidence used:
- Code reading (anchors below).
- Coordinator screenshots: SwiftShader set (10–30, Canvas fallback) and Apple M5 Pro / ANGLE Metal set (80–99, the real GPU path).
- Two read-only probes I ran against the maintained server with Playwright on the same M5 Pro (`--use-angle=metal`, WebGL2 reports `ANGLE Metal Renderer: Apple M5 Pro`, `navigator.gpu` present): `scratchpad/probe-ladder.mjs` (26 s ladder timeline, dense-24) and `scratchpad/probe-fauna.mjs` (same camera in `webgl` vs `canvas`, crops `fauna-webgl.png` / `fauna-canvas.png`).

---

## 0. Executive verdict

The GPU path is architecturally where a 2026 pixel-art renderer should be — authored material/emissive/occluder channels, a height-encoded 2D light-occlusion pass, half-res emissive bloom, a palette-quantised key-light band, ordered-dither wetness — and the M5 Pro night capture finally reads as night. But two structural facts mean the operator almost never sees that machinery at full strength:

1. **The quality ladder never reaches FULL on healthy hardware.** On an M5 Pro at 1920x1080 dense-24 the GPU world booted at level 2 (MINIMAL: 4 lights, no occlusion pass, no bloom, weather zeroed), climbed to level 1 at ~12 s and was still at level 1 after 26 s. `gpuMs` sits at 1.2–3.3 ms and any single frame ≥ 2 ms resets the 5 s recovery probe (`postfx/PostFxLadder.js:22-27,181-197`). The "few lantern pools" the coordinator noticed at night are literally the ladder shedding lights.
2. **Most of v0.36's "Light, ground and material" package is Canvas-only.** Building sun shadows (moving solar vector), cloud shadows, the ground haze field, all dynamic water passes, roof/ground wetness marks, and the whole fauna layer are gated with `if (!gpuWorldActive)` or drawn to the base canvas underneath the opaque GPU island (`WorldFrameRenderer.js:497-535,643`). Default users (WebGL2) never see them; the Canvas fallback that does show them is what nobody runs.

Fixing those two is worth more than any new effect. After that, the honest visual gaps are compositional: a flat 40x40 diorama on a gradient ocean, plaques that scale with zoom, name-tag piles at the gate, and a night grade that is a flat blue multiply rather than a stepped, pool-lit scene.

---

## A. Graphical quality today vs 2D pixel-art state of the art (Sept 2026)

### What is already in the code (verified)
| Technique | Where | Status for a default (WebGL2) user |
| --- | --- | --- |
| Authored albedo/material/emissive/occluder channels, sidecar-first resolver, atlas fallback | `manifest.yaml:8-40`; `gpu/GpuSceneBuilder.js`; `MaterialRegistry.js:48-58` | Live |
| Palette-preserving key light: 4 quantised bands `[0.72,0.86,1.0,1.12]` by material response and sun facing | `gpu/GpuWorldRenderer.js:132-149` | Live (this is the right call instead of normal maps) |
| 2D light occlusion: 0.375-res occluder target, 3-tap ray from receiver to light with height test | `GpuWorldRenderer.js:95-112,200-209`; `_renderOcclusion` 990-1020 | Only at ladder level < 2 — **not running on the M5 Pro for the first ~12 s and often after** |
| Emissive bloom (MRT emission attachment, 0.375-res blur) | `GpuWorldRenderer.js:1093-1108,1110-1132,1134-1162` | Only at level < 2; strength 0.42 at level 1, 0.72 at 0 |
| Per-light water reflection columns (material 8) | `GpuWorldRenderer.js:210-216` | Only for admitted lights (4 / 10 / 16 by level) |
| Rain wetness with ordered dither and material glint | `GpuWorldRenderer.js:114-130` | Live (weather ×0.72 at level 1, zeroed at level 2) |
| Ground fog from `u_weather.y` by elevation | `GpuWorldRenderer.js:219-221` | Live but a screen-space gradient; the v0.36 geometry-derived haze field is Canvas-only (`WorldFrameRenderer.js:508,1184-1214`) |
| Moving solar vector | `AtmosphereState.js:1084-1118` | GPU consumes it only as the key-facing term (`GpuWorldRenderer.js:1043-1049`); the structural/tower shadows it drives are Canvas-only (`BuildingSprite.js:611-660`, gated at `WorldFrameRenderer.js:535`) |
| Parallax clouds (3 bands), sun/moon, stars, aurora, shooting stars, god-rays | `SkyRenderer.js:109-111,346-382` | Sky band visible; anything the canopy paints over the island area is under the opaque GPU island |
| Dynamic water (phase tint, ripples, night reflections, sea glitter, surf) | `IsometricRenderer.js:7111-7125` inside `_drawTerrain` 5540-5556 | **Canvas-only**; on GPU the whole island is one static texture record (`GpuSceneBuilder.js:266-299`) |
| PostFx water displacement/reflection, 48-light glow, grain | `postfx/PostFx.js:100-240` | **Never runs when the GPU world is active** (`IsometricRenderer.js:1533`) |

### Honest comparison
Against current pixel-art titles (the Eastward / Sea of Stars / Cassette Beasts lineage, and the 2024–26 Godot/Unity 2D-lighting stacks): the *lighting model* is competitive in design and deliberately palette-safe — a quantised facing band plus authored emissive is the correct substitute for normal-mapped sprites in a stepped palette, and the occluder-height raymarch is exactly the "2D shadow casting" those games do. What is missing is not technology but **delivery and composition**:

- No contact/ambient occlusion at building footings on the GPU path (agents have a stepped ground-shadow record, `GpuSceneBuilder.js:536-568`; buildings have nothing).
- Night is a single multiply `base=[0.50,0.59,0.77]` (luminance ≈ 0.58 of day) plus a vignette (`GpuWorldRenderer.js:28-32,150-162`). Real night scenes in the reference games are ~0.35–0.45 with lantern pools doing the lifting; here the pools are being culled by the ladder, so the multiply must stay bright to keep the scene readable. Fix the pools and the grade can drop.
- No dithered transitions: grade, fog and vignette are smooth gradients over a stepped palette. The Canvas cliff shelf gets it right (`IsometricRenderer.js:9074-9130` bands the ramp); the shaders don't.
- The ocean is a per-frame linear gradient plus four sine swell lines (`IsometricRenderer.js:9140-9190`); no distant shore, islets, or parallax. The island's two lower faces are 4+8 flat bands baked once (`:9074-9130`). This is the biggest first-impression gap and it is composition, not tech.
- Water reflections of lit windows exist on the GPU path only as the per-light column term for ≤16 admitted lights; there is no reflection of the scene itself (the PostFx vertical-flip reflection at `PostFx.js:219-225` is Canvas-path-only).

### Web tech re-evaluation (evidence, not fashion)
- **WebGL2 instancing**: not used — quads are expanded to 6 vertices per record on the CPU and uploaded with `bufferData(DYNAMIC_DRAW)` per batch (`GpuWorldRenderer.js:887-920,955`). Probe: 240 records → ~197 batches/frame, cpuMs 0.2–0.4 ms on M5. Not a bottleneck on Apple silicon; would matter on Intel iGPU laptops. Worth a small cleanup (B8), not a rewrite.
- **WebGPU**: `navigator.gpu` is present on this machine and shipped in Chrome/Safari 26/Firefox. But the measured GPU time is 1.2–3.3 ms for ~240 quads and two full-res attachments — the cost is not API-bound, it is ladder-policy-bound. WebGPU would change nothing the operator sees. The prior rejection stands; no reopen trigger is met.
- **OffscreenCanvas worker**: `appRenderMs` 2.6–4.2 ms, `hostGapMs` 3.5–5.7 ms at 120 Hz (probe `fh` rows). Main-thread contention is not material. Keep rejected.
- **requestVideoFrameCallback**: irrelevant (no video element).
- **HDR canvas / display-p3**: wrong tool for a stepped-palette contract; would widen gamut of authored colours unpredictably. Do not.
- **CSS `color-scheme`**: a Dashboard/shell concern, not World.

### Which techniques carry signal for an operator
Signal (keep/invest): light occlusion (which villager is behind which mass), lantern pools tied to occupancy and attention (a lit forge = work; an amber pool = needs you), incident marks at overview LOD (landed), weather as pressure (landed), building plaques with tally chips (`96-gpu-night-zoom2.png` shows "1 agent"/"9 agents"). Decoration only: parallax shore, scene reflections, grain, god-rays, aurora. Rank decoration last.

---

## B. Ranked improvements (operator impact × feasibility under guardrails)

Guardrails respected: zero build, additive changes only under `gpu/**` and `postfx/**`, desktop-only, motion budget (`docs/motion-budget.md`), palette contract (`materialContract.responseBands`), 1.00 ms council reserve.

### B1. Make the ladder reach FULL on healthy hardware — **S, highest impact**
- **Operator sees**: 16 lights instead of 4, occlusion shadows, bloom, wet materials — i.e. the work that already landed in v0.36.
- **Evidence**: probe timeline (level 2 at t=0, level 1 at t=12.1 s, never level 0 in 26 s; `lastScore` 1.15–3.27 ms, driver `gpuMs`). Policy at `postfx/PostFxLadder.js:22-27` (`budgetMs 4, healthyMs 2, overBudgetFrames 60, probeMs 5000`) and `:181-197` (single frame ≥ `healthyMs` sets `healthySinceMs = null`). `GpuWorldRenderer.js:1177-1180` clamps DISABLED to MINIMAL, so the ladder's own vocabulary ("disabled:gpuMs") misdescribes what is drawn.
- **Work**: in `PostFxLadder.js` (pure, unit-testable): (a) count over-budget by elapsed ms not frames (60 frames is 0.5 s at 120 Hz); (b) score on a rolling median of the last N frames, not the last frame; (c) recovery threshold relative to budget (e.g. `healthyMs = budgetMs * 0.75`) and do not reset `healthySinceMs` on one excursion — require K consecutive over-healthy frames to reset; (d) ignore upload-driven scores during the first ~3 s after `show()` / after a texture `storageChanged` burst (boot sheets are 6 MB each, `AgentSprite.js:3735-3746`), or reset the ladder to FULL when `_frameUploadMs` returns to 0 for 1 s. Add `lastDecisionReason` values that distinguish "minimal-resident" from "disabled".
- **Acceptance**: on the M5 Pro dense-24 at 1080p, `qualityLevel` = 0 within 10 s of boot and ≤ 1 transition/minute afterwards; `lights` = 16 at night; unit tests for the ladder transitions (`scripts/tests/`); existing `frameHealth` fields cited by the capture harness unchanged.
- **Risk**: low; the ladder is pure and already tested. Watch Intel iGPUs (gpuMs may genuinely be 4–6 ms) — the budget itself is not the bug, the hysteresis is.

### B2. Port the ground-truth layer to the GPU path — **M, second-highest impact**
- **Operator sees**: buildings cast a sun shadow that moves through the day; mist on the river; cloud shadows crossing; water that shimmers and reflects at night; gulls and waterfalls (currently invisible).
- **Evidence**: `WorldFrameRenderer.js:497-510` (`_drawTerrain`, `drawCloudShadows`, `drawGroundFog` inside `if (!gpuWorldActive)`), `:532` (`drawBuildingLightReflections`), `:535` (`drawShadows`), `:643` (wetness marks); `BuildingSprite.js:611-660` (structure/tower shadows, Canvas 2D only); `GpuSceneBuilder.js:992-1028` (records: terrain, buildings, props, agents, agent ground shadows — nothing for building shadows/haze/clouds); fauna at `WorldFrameRenderer.js:518-522` drawn to the base `ctx` with no GPU guard (`WildlifeRenderer.js:38-46`, `IsometricRenderer.js:9879`), empirically hidden: `fauna-canvas.png` shows waterfowl on the Observatory pond, `fauna-webgl.png` at the identical camera shows none.
- **Work (all additive records/uniforms)**:
  1. Building shadow records: emit a `ground:building:<id>` record per building from `recordForBuilding`, sourced from a small stamped-ellipse texture (reuse the agent ground-shadow bake pattern `GpuSceneBuilder.js:536-568`), offset by `lighting.shadowAngleRad/shadowLength` exactly as `_drawStructureShadow` does; tower-cast as 3–4 fading stamps. Sorted into the `ground:` band that already exists (`:1018-1022`).
  2. Haze field: `ensureHazeField` already produces a quarter-res canvas; emit it as one `ground:haze` record with `blend:'add'` and alpha = field strength, after terrain and before buildings. Zero new shader work.
  3. Cloud shadows: one `ground:cloud` record per layer using an ellipse stamp with `blend:'normal'` and low alpha (or a `u_cloudShadow[3]` uniform evaluated in `applyGrade` on `material==earth/foliage/cobble` — cheaper, no records).
  4. Dynamic water: add a `material == 8.0` branch in the scene fragment driven by `u_time`/`u_motionScale` (already uniforms) and `u_weather`: ordered-dither 2-tone shimmer, phase tint from `u_gradeBase`, storm roughness from `u_weather.z`. Static under reduced motion (`u_motionScale == 0` already yields a fixed phase, `:120`). Keep the Canvas passes as the fallback.
  5. Fauna and waterfalls: route `_drawFishSchools/_drawWaterfowl/_drawTropicalWaterfalls/_drawLandBirds` through a scene category with `unsupported: 'overlay-safe'` like `HARBOR_TRAFFIC_SCENE_CATEGORY` (`HarborTraffic.js:181-194`) so they draw on the overlay canvas above the GPU island.
- **Acceptance**: `webgl` and `canvas` captures of `north-star-clear-day` and `torchlit-night` differ only in shader-grade tone, not in the presence of shadows/haze/fauna; `npm run world:capture-render-baselines` records both; visual QA checklist "Clear day: … roads, water edges, bridges" passes in `webgl`.
- **Risk**: medium — draw order within the `ground:` band; shadow alpha stacking under haze. Budget: items 1–3 are 3–12 quads; item 4 is a per-fragment branch on water pixels only. Fits the 1.00 ms reserve on M5; verify on an Intel iGPU.

### B3. Lights that carry attention — **S**
- **Operator sees**: the agent that needs you is the brightest warm pool in the village at night; errored agents are a cold red pool; quota-limited a dim amber. At overview zoom this survives where nameplates don't.
- **Evidence**: light admission is `priority → intensity → id` (`gpu/GpuWorldPolicy.js:234-244`); sources already include relationship, familiar-mote, arrival, gate and lantern-ground lights (`IsometricRenderer.js:10184-10200`); `light.night` flag scales by `beaconIntensity` (`GpuWorldRenderer.js:1082-1084`); `MAX_LIGHTS = 16` (`:18`).
- **Work**: add an `attention` light source per `SignalLedger` bucket for `needsYou/errors/quota` agents with `priority` above every ambient source; raise `MAX_LIGHTS` to 32 (uniform array; the loop already early-exits, `:201-202`); keep the shed order — under pressure ambient lights drop first, attention lights never (extend `PRESSURE_PROTECTED`, `MarkGovernor.js:21-27`). Colour from the existing attention palette, not a new one.
- **Acceptance**: `98-gpu-needs-user` night capture shows exactly one dominant amber pool; dense-100 keeps all attention lights admitted; `lights` diagnostic ≤ 32.
- **Risk**: low. Depends on B1 (at level 2 only 4 lights are admitted).

### B4. Plaque and caption hygiene — **S**
- **Operator sees**: building plaques stay a readable, constant screen size at zoom 2–3 instead of covering villagers ("CODE FORGE" spans ~450 px at zoom 3 in `97-gpu-night-zoom3.png`); the "WATCHING 24 AGENTS" line stops sitting on the Command keep; one empty-state card instead of two.
- **Evidence**: plaques are drawn under `camera.applyTransform(overlayCtx)` with fixed 9 px/7 px fonts (`WorldFrameRenderer.js:750-754`, `BuildingSprite.js:691-800,1089-1104`, no inverse scale anywhere in `BuildingSprite.js`), whereas agent name tags counter-scale with `s = 1/zoom` (`AgentSprite.js:5331-5333`) — two label systems with opposite policies. Boot status line is a fixed-position DOM element at top 58 px, z-index 90, created at `App.js:768-800` and only removed on destroy (`:1694`); its text comes from `VillageState.js:225-231`. Empty state: canvas card `_drawEmptyStateWorldCue` (`IsometricRenderer.js:10011-10057`, called at `WorldFrameRenderer.js:670,741`) and DOM `#worldEmpty` (`index.html:148-152`, shown at `App.js:872-880` when `phase !== READY_LIVE && !occupied`) both render in `READY_EMPTY`; a third "THE VILLAGE AWAITS" lives in `Sidebar.js:571`.
- **Work**: `drawLabels` applies `ctx.scale(1/zoom)` around the tag like the name tag does (keep the stalk in world space); or scale plaques by `zoom^0.5` if a little growth is wanted. Hide `#bootStatusWrap` when `phase === READY_LIVE` (the top bar already shows counts) or dock it into the top bar. Delete the canvas empty card (the DOM one is the readiness-reducer-driven, accessible one).
- **Acceptance**: plaque tag height in CSS px identical at zoom 1/2/3; no DOM/canvas overlap in `no-agents`; visual QA "dense labels do not cover building labels" passes at zoom 3.
- **Risk**: low; `_labelMetrics` cache is keyed by `zoomBucket` (`BuildingSprite.js:4408-4410`) and will need the key to include the scale mode.

### B5. Crowd nameplates: collapse piles into building chips — **M**
- **Operator sees**: at the gate/forge, 20 overlapping name pills become "×12 at Forge" on the plaque chip plus names for primary-tier agents only; hover/select expands.
- **Evidence**: slot search caps at 3 (`IsometricRenderer.js:208`), merge only unifies *identical head lines* (`:5226-5241`), so distinct names can never merge; the Metal captures (`80-gpu-metal-night.png`, `94-gpu-storm-night.png`) still show 8–10 stacked pills at the forge. v0.34.1 deliberately chose "degrade by overlap, never anonymity"; the tally chips under plaques already exist (`96-gpu-night-zoom2.png`).
- **Work**: in `_mergeIdenticalClusterBubbles`, when a slot-0 cluster exceeds N (e.g. 5) and every member is `ambient/working` tier, fold the ambient members into the nearest building chip (`_buildingOccupancyInfo` already knows the count) and keep primary/recent names. Deterministic representative order is already in place. Search/select still finds folded agents (sidebar remains authoritative).
- **Acceptance**: dense-24 at zoom 1 shows ≤ 6 name pills per cluster; every `waiting_on_user/errored` agent keeps its name; 200-layout harness (v0.37) extended with a fold assertion.
- **Risk**: medium — this reverses part of v0.34.1's "names remain visible" promise for ambient agents; keep it behind the existing pressure/annotation mode so calm scenes keep names.

### B6. Night grade as a stepped, pool-lit scene — **S**
- **Operator sees**: night reads darker and warmer at the pools with dithered banding that matches the art, not a flat blue wash.
- **Evidence**: three duplicated grade tables — `GpuWorldRenderer.js:28-32`, `PostFx.js:17-22`, `IsometricRenderer.js:144-149` — all a smooth multiply; night base luminance ≈ 0.58; `applyGrade` vignette is a smooth radial (`GpuWorldRenderer.js:150-162`).
- **Work** (GPU fragment only, after B1/B3): quantise `applyGrade` output to 3 luminance bands with the same 4-pixel ordered dither used for wetness (`:121`); lower night base toward `[0.40,0.48,0.66]` once pools are admitted; keep `u_edgeAlpha` but step it. Unify the three tables into one exported constant in `GpuWorldPolicy.js` consumed by all three paths (parity contract).
- **Acceptance**: `torchlit-night` north-star still approved; primary marks survive (they draw post-grade on the overlay, `WorldFrameRenderer.js:733-737`); Canvas fallback parity within tone.
- **Risk**: low; art-direction sign-off needed.

### B7. Island edge and ocean depth — **M, composition only**
- **Operator sees**: a coastline, not a floating tile; distant islets/shore band with parallax; the island's cliff reflected in the water.
- **Evidence**: `_drawDistantSeaHorizon` (`IsometricRenderer.js:9140-9190`) is a gradient + 4 swell lines; cliff shelf is baked bands (`:9074-9130`); sky has 3 parallax cloud bands (`SkyRenderer.js:109-111`) but no ground-level parallax.
- **Work**: (a) a cached distant-shore sprite band in `SkyRenderer` at parallax ~0.15 (same cache discipline as clouds, `:249-260`); (b) reflect the cliff: draw the bottom 60 px of the terrain cache vertically flipped, quantised to 3 alpha steps, under the SE/SW faces — baked once with the shelf; (c) dithered waterline (2–3 px) where face meets sea. All static → reduced-motion safe.
- **Acceptance**: `north-star-clear-day` still; no per-frame cost increase (`terrain-surface` stage unchanged).
- **Risk**: low; needs an authored shore asset (sprite pipeline) — rank below the signal items.

### B8. GPU lane hygiene — **S, invisible on Apple silicon**
- **Evidence**: per-frame allocations in `buildStableGpuBatches` (`GpuWorldPolicy.js:178-207`: `.map().filter()`, string joins, batch objects) and `buildGpuWorldRecords` (`GpuSceneBuilder.js:1017-1022`: three `filter`s and a spread); `bufferData(DYNAMIC_DRAW)` per batch (`GpuWorldRenderer.js:955`), ~197 batches for 240 records (probe) because the batch key is per texture and agent sheets are per profile; `clampGpuLights` sorts per frame (`GpuWorldPolicy.js:236-243`); `_trimTextureCache` walks every entry every frame (`:794-797`).
- **Work**: one VBO sized for the frame, `bufferSubData` once, `drawArrays(first,count)` per batch; reuse batch objects; stable-sort records by texture inside the depth band where depth allows (agents interleave with buildings, so only within runs).
- **Acceptance**: `cpuMs` and allocation count in the GPU lane at zero per frame; identical pixels.
- **Risk**: low. v0.37's "1,778 allocations → 0" claim covers the overlay path, not this lane.

---

## C. Verified defects

| # | Defect | Evidence |
| --- | --- | --- |
| C1 | GPU quality ladder starts degraded and cannot recover to FULL on an M5 Pro; the operator runs at REDUCED/MINIMAL (4–10 lights, no occlusion below level 2, bloom 0.42 or off). | Probe rows t=0…25 s; `PostFxLadder.js:22-27,181-197`; `GpuWorldRenderer.js:1071-1077` (light limits), `:1093-1096` (bloom gate), `:1204-1213` (occlusion gate). |
| C2 | Sun shadows, cloud shadows, ground haze field, dynamic water, wetness marks, building light reflections: Canvas-only. v0.36 items 11/12 shipped to the fallback path. | `WorldFrameRenderer.js:497-510,532,535,643`; `BuildingSprite.js:611-660`; `GpuSceneBuilder.js:992-1028` has no counterpart. |
| C3 | Fauna, waterfalls and sky-canopy effects are painted on the base canvas beneath the opaque GPU island (fx canvas z-index 1, `css/character.css:14-27`). | `WorldFrameRenderer.js:515-522`; `fauna-canvas.png` vs `fauna-webgl.png` (same camera; waterfowl present only in Canvas). |
| C4 | Two empty-state cards render simultaneously in `READY_EMPTY` (canvas + DOM), plus a sidebar copy. | `IsometricRenderer.js:10011-10057`; `WorldFrameRenderer.js:670,741`; `App.js:872-880`; `index.html:148-152`; `30-empty-world.png`, `fauna-*.png`. |
| C5 | Boot status line ("WATCHING N AGENTS") persists forever at fixed top-centre, z-index 90, overlapping the Command keep and plaques. | `App.js:768-800` (created), `:1694` (only removal); `VillageState.js:225-231`; all captures. The visually-hidden `.world-semantic-summary` (`css/character.css:164`) is a different, correct a11y element. |
| C6 | Building plaques scale with zoom (world-space text) while agent name tags counter-scale; landmark plaques additionally block agent rectangles at zoom ≥ 3. | `BuildingSprite.js:691-800,725,1089-1104`; `WorldFrameRenderer.js:750-754`; `AgentSprite.js:5331-5333`; `97-gpu-night-zoom3.png`. |
| C7 | Name-pill pile at gate/forge: merge only collapses identical head lines; slot cap 3; least-overlap fallback stacks distinct names. | `IsometricRenderer.js:208,5180-5241`; `80-gpu-metal-night.png`, `94-gpu-storm-night.png`. |
| C8 | PostFx (`u_reflectionEnabled`, 48-light glows, displacement, grain) is unreachable for GPU-world users; three grade tables duplicated across paths. | `IsometricRenderer.js:1533` (`postFx` only when `!gpuWorld`); `PostFx.js:17-22,219-225`; `GpuWorldRenderer.js:28-32`; `IsometricRenderer.js:144-149`. |
| C9 | Texture cache "cap" is advisory: 104.4 MB resident on dense-24 against `MAX_CACHED_TEXTURE_BYTES = 48 MB` because entries used this frame are exempt; diagnostics still report the cap. | Probe `texMB 104.4`; `GpuWorldRenderer.js:24,794-809,1234`. Combined with 3 full-res attachments this is ~130 MB GPU at 1080p — over `MAX_GPU_RESOURCE_BYTES` (`CanvasBudget.js:32`). |
| C10 | GPU lane per-frame allocations and per-batch `bufferData`. | `GpuWorldPolicy.js:178-207`; `GpuSceneBuilder.js:1017-1022`; `GpuWorldRenderer.js:955`. |
| C11 | Ladder vocabulary misleads: at level 3 the renderer still draws at MINIMAL but reports `disabled:*`; the capture harness (and an operator reading `frameHealth`) reads it as "GPU off". | `GpuWorldRenderer.js:1177-1180`; `PostFxLadder.js:172-174`. |
| C12 | `resolveGpuWorldRendererMode(params, { webgl2: true })` hard-codes support; harmless (`createGpuWorldRenderer` returns null on failure) but the policy function's `webgl2` branch is dead in production. | `IsometricRenderer.js:1529`; `GpuWorldPolicy.js:100-108`. |
| C13 | Command "doorstep spill" glow is anchored above/behind the roof, reading as a floating blob rather than light from the door. Art-direction, not code, but visible in every night capture. | `96-gpu-night-zoom2.png`, `80-gpu-metal-night.png`. |

### On the coordinator's eight observations
1. **Night barely darker than noon** — true for the SwiftShader/Canvas-fallback set; on Metal the night reads as night (base multiply luminance ≈ 0.58 plus vignette), but the pools are thin because of C1. SwiftShader forced neither the Canvas path nor PostFx-off by policy; it drove the ladder to DISABLED (`disabled:gpuMs`), which still renders MINIMAL (C11). Real users get WebGL2.
2. **Flat diorama on a gradient ocean** — verified (`IsometricRenderer.js:9074-9130,9140-9190`). No shore, no parallax below the cloud bands.
3. **Plaques scale with zoom** — verified (C6).
4. **Name pile at the gate** — verified (C7).
5. **"WATCHING 24 AGENTS" overlaps** — verified (C5); it is the boot status line, not the semantic summary.
6. **Double empty card** — verified (C4).
7. **Zoom/DPR** — tiers are `[1,2,3] × round(dpr)/dpr` in backing pixels (`Camera.js:31-67`), transform is `zoom*dpr` (`:771-781`), so one art pixel is always an integer number of device pixels and the *apparent* size is the same as on a 1× display (2×2 device px at DPR 2). Backing store is `deviceDpr / n` with n grown until `css² × dpr² ≤ 7.5 M` (`CanvasBudget.js:12-31,69-96`, `App.js:1476-1491`): a 16" MacBook keeps native 2×; a 4K monitor at 100% or a 5K at 2× drops to n=2 and is upscaled ×2 crisply. Sky cache is pinned at DPR 1 in fast mode (`SkyRenderer.js:471-474`). Retina users get crisp integer scaling, never higher-resolution art; nothing wrong here.
8. **Water** — on the GPU path the island (including all water) is a single static texture record; the only per-frame water effects are the per-light column reflection (`GpuWorldRenderer.js:210-216`) and rain glint. Lit-window reflections exist only as those columns for admitted lights (≤ 4–16). Everything else is Canvas-only (C2).

---

## D. Do not do

- **Do not adopt WebGPU, an OffscreenCanvas worker, or radiance-cascade GI.** Measured GPU time is 1.2–3.3 ms for ~240 quads on M5; `appRenderMs` ≈ 3 ms; the visible deficits are policy and parity, not API ceilings. No reopen trigger in `open-followups.md:73-83` is met.
- **Do not add normal-mapped sprites or smooth per-pixel lighting.** The 4-band facing term is the palette-safe equivalent and is already authored into `materialContract.responseBands`.
- **Do not raise the night multiply darker before B1/B3.** With 4 admitted lights the scene would become unreadable; the flat-but-bright night is currently compensating for the ladder.
- **Do not add a fourth grade table or a fourth label system.** Unify the three existing tables (C8) before touching tone; make plaques follow the name-tag scale policy (B4) rather than inventing a third.
- **Do not fix the ladder by raising `budgetMs`.** The failure is hysteresis (frame-count windows, single-frame probe reset), not the 4 ms budget; raising the budget hides genuine Intel-iGPU overload.
- **Do not chunk or enlarge the 40x40 map for depth.** The terrain cache is at 6.56 M of a 7 M pixel reserve (`docs/rendering-baselines.md`); the "floating diorama" is solved by a cached distant-shore band and a baked cliff reflection, not by more tiles.
- **Do not render fauna as GPU records with per-frame texture updates.** Route them through an overlay-safe scene category (like harbor traffic); their motion budget is already Canvas-shaped.
- **Do not re-propose** the landed council items (moving sun, haze field, wetness, mine/portal windows, resolver, one clock, pressure governor, overview incident marks). Their remaining problem is delivery to the GPU path (B2), not design.

---

## Appendix: probe data (M5 Pro, ANGLE Metal, 1920x1080, DPR 1, dense-24)

`probe-ladder.mjs` (1 Hz samples): level 2 at t=0–11 s (`lights 4`), level 1 from t=12.1 s (`lights 10`), never level 0 through t=25.1 s. `lastScore` per second: 1.84, 1.47, 2.38, 1.68, 1.85, 2.05, 1.65, 1.71, 1.63, 3.27, 1.40, 1.15, 2.31, 1.23, 1.45, 2.16, 1.70, 1.45, 1.59, 1.50, 1.48, 1.92, 2.17, 1.92, 2.75 ms (driver `gpuMs`, `gpu-timer`). `uploadMs` ≤ 0.03, `cpuMs` 0.18–0.42, `records` 240, `batches` 192–200, `textureBytes` 104.4 MB. `frameHealth`: `appUpdateMs` 0.4–1.0, `appRenderMs` 2.6–4.2, `hostGapMs` 3.5–5.7. Console: no errors.

`probe-fauna.mjs 18 7`: identical camera pose in both modes (`x -12, y -163.5, zoom 2`); `webgl` level 1; waterfowl visible only in the `canvas` crop.
