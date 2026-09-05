## Territory and method

Read-only research into clock/sky/weather, scene lighting, shadows, material response and quality degradation. No application files, assets, server lifecycle, validation commands, tests or formatters were touched. The only retained writes are this note and its JPEG captures.

Files read, with the consequential sections:
- `AGENTS.md:1-56`, `agents/README.md:1-38`, `claudeville/CLAUDE.md:1-49`.
- `claudeville/src/presentation/character-mode/README.md:1-104`, `claudeville/src/presentation/dashboard-mode/README.md:1-45`, `claudeville/src/presentation/shared/README.md:1-54`.
- `docs/visual-experience-crafting.md:1-110`, `docs/world-visual-qa-checklist.md:1-86`, `docs/rendering-baselines.md:1-107`, `docs/building-style-contract.md:1-65`, `docs/material-channel-contract.md:1-160`, `docs/motion-budget.md:1-45`.
- `agents/plans/claudeville-fable-5.1-enhancement-implementation-plan.md:1-64`, `agents/claudeville-astra-refinement-plan.md:1-70`, `agents/plans/open-followups.md:96-114`. Previous review findings were not treated as current defects without checking source.
- `claudeville/src/presentation/character-mode/AtmosphereState.js:40-63,901-940,1055-1136,1207-1285`; `SkyRenderer.js:205-283,346-398`; `WeatherRenderer.js:119-205,919-989`; `LightSourceRegistry.js:1-48`; `NightOccupancyGate.js:1-39`; `MaterialRegistry.js:38-69`.
- `claudeville/src/presentation/character-mode/WorldFrameRenderer.js:404-762`; `IsometricRenderer.js:10225-10342`; `BuildingSprite.js:333-382,1510-1546,4060-4102`.
- `claudeville/src/presentation/character-mode/postfx/PostFx.js:33-277` and effect-gate locations `597-612,801-849,911-947`; `PostFxLadder.js:7-34,208-377`; `PostFxFeed.js:210-350,620-770`.
- `claudeville/src/presentation/character-mode/gpu/GpuWorldRenderer.js:131-203,260-295,440-475,1163-1239` and render/diagnostic locations `1254-1410,1430-1472`; `GpuSceneBuilder.js:305-338,431-590` plus structural map.

Capture method: maintained `http://localhost:4000`, helper `agents/research/claudeville-frontier-visual/tools/capture.mjs`, 1920×1080, deviceScaleFactor 1, requested zoom 1. Every run reported `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)` and no console/page errors. All retained images were opened and visually inspected. Capture timing is **loaded-host evidence**, not a renderer benchmark: sibling explorers were capturing on this host, and some of my long-running capture processes also overlapped. Chromium version, power state and exact concurrent browser count were not recorded; do not publish these as comparative performance measurements.

Capture paths below use prefix `agents/research/claudeville-frontier-visual/shots/`. Each waited **35 seconds after setup**, in addition to helper boot time. FULL=0, REDUCED=1, MINIMAL=2.

| Capture | Scene and purpose | Observed quality |
|---|---|---|
| `light-and-atmosphere-01.jpg` | `midnight-oil`, hour 23, clear; gate/Mine/Forge, four agents | Adaptive MINIMAL 2 |
| `light-and-atmosphere-02.jpg` | `dense-24-agents`, hour 6, clear; dawn Harbor/Lighthouse/Forge | Adaptive FULL 0 |
| `light-and-atmosphere-03.jpg` | `dense-24-agents`, hour 18, clear; same requested center 20,20, sunset comparison | Adaptive MINIMAL 2 |
| `light-and-atmosphere-04.jpg` | `storm-night-reduced-motion`, explicit storm; selected worker, rain, Harbor | Adaptive FULL 0; renderer motionScale=0; snapshot clock 23:40 |
| `light-and-atmosphere-05.jpg` | Real live feed, no clock/weather override; 17 residents, clear night, current host hour approximately 22:32 CEST | Adaptive REDUCED 1, within-budget |
| `light-and-atmosphere-06.jpg` | `midnight-oil`, hour 23, clear; FULL source still rather than mistaking reduced effects for absent capability | **Forced FULL 0**, override |
| `light-and-atmosphere-07.jpg` | `dense-24-agents`, hour 18, clear; FULL source counterpart to 03 | **Forced FULL 0**, override |
| `light-and-atmosphere-08.jpg` | Real live feed with native clock/weather; FULL source counterpart to 05 | **Forced FULL 0**, override; actual snapshot clock **22:33** recorded in diagnostics |

The early helper read the inactive hybrid PostFx object and returned null for resident quality. For 01–04 I added a browser-local diagnostic getter pointing to `gpuWorld.qualityLadder.getLevel()`; this did not alter its policy. The helper was subsequently fixed by the coordinator. Its hour field remained null in several outputs, so requested simulated hours are command inputs, while 04's actual clock comes from `_lastAtmosphere.clock`; 05's approximate hour is cross-checked against the host clock, not that null field. Forced captures explicitly call the existing QA `setOverride(0)`; they are not evidence of adaptive recovery. Scene fixtures may retain selection/follow framing, so these are not pixel-registered A/Bs.

## Current state

**There are three composition paths, not a single universal PostFx pipeline.** All paths start at `AtmosphereState.createAtmosphereSnapshot`: local effective date → seasonal phase resolution → deterministic/overridden weather → district influence → sky/grade/lighting/reactions/motion/clock (`AtmosphereState.js:1207-1285`). Explicit weather overrides win over event weather. `WorldFrameRenderer.js:448-479` combines actual MoodService/Director influence, updates surface wetness from precipitation, sends lighting/clock/atmosphere to the building renderer, and collects frame sources. Registry sources have explicit identity, origin, kind, hue, radius, priority, intensity and optional building ownership (`LightSourceRegistry.js:3-35`). The source census includes attention, buildings, relationships, arrivals, gate/ground lanterns and pending-branch bridge lanterns (`IsometricRenderer.js:10225-10242`).

- **Shared sky:** cached Canvas sky first, composed from background/stars/sun/moon/god rays/clouds; slower layers reuse 200 ms or 1000 ms cache buckets (`SkyRenderer.js:64-71,205-283`). The canopy repeats sky contributors at reduced strength and carries transient sky rewards (`SkyRenderer.js:346-398`). These are Canvas contributions even with a resident GPU island; do not assume hybrid shader god rays run on the resident path.
- **Canvas-only scene:** terrain → cloud-shadow ellipses → coherent ground haze → ground semantics/reflections/building shadows → depth-sorted drawables → particles (`WorldFrameRenderer.js:498-608`). With no successful GPU composition, a cached multiply grade and additive light/lantern stamps finish the scene (`WorldFrameRenderer.js:642-649`; `IsometricRenderer.js:10251-10315`). Source glows use smooth radial stamps today, not a physically transported illumination field.
- **Canvas plus hybrid PostFx:** `PostFxFeed.build` projects/culls a maximum 48 light records, prepares quarter-resolution water mask, eight heat-haze anchors, sun, incident envelope, grade and reduced-motion flags (`PostFxFeed.js:247-350,666-725`). The finished Canvas becomes a full-resolution uploaded source texture. Its shader applies source-texel-quantized water/heat offsets, grade, radial glows, coarse eight-tap god rays, water-edge reflection, channel-separated incident pulse and grain (`PostFx.js:78-229`), then bloom (`:232-277`). The reflection is a vertically mirrored source sample at the water edge, not a reflection ray tracing the associated lamp (`:209-214`). Hybrid glow and bloom are not evidence that resident light transport exists.
- **Resident WebGL2:** `WorldFrameRenderer.js:622-636` builds records and supplies atmosphere/weather/lighting. `GpuSceneBuilder.js:431-590` adds structure-grounded shadow records and albedo/material/emissive/occluder sources with an occupancy gate; `:305-338` adds the same retained haze field. The shader uses authored material pixels, weather response, dithered water state, material-wide key band, grade/cloud shadows, local-light occlusion, water reflection and emission (`GpuWorldRenderer.js:160-295`). Local occlusion samples three positions between receiver and ground-level emitter (`:134-150`); this is not multi-bounce GI. Resident bloom extracts the authored emission attachment, rather than granting emission to bright albedo (`:238-257,292-295`). It does **not** run the hybrid heat-displacement, incident chromatic-separation or grain chain; the resident call is mutually exclusive with `postFx.render` (`WorldFrameRenderer.js:622-640`).
- **Shared upper layer:** foreground weather, functional building marks, primary cues, labels, bubbles and screen effects come after composition, keeping them out of scene grading/distortion (`WorldFrameRenderer.js:655-755`). Rain/snow/fog and static district atmosphere have separate MarkGovernor/motion gating, not the PostFx quality ladder (`WeatherRenderer.js:119-205`). Reduced-motion storm keeps static rain/fog and skips flash scheduling (`:143-154,199-200`).

**Four authored key-light bands are 0.72 / 0.86 / 1.00 / 1.12**, with warm upper-left key color `#ffe0a0` (`MaterialRegistry.js:38-44`). This is a vocabulary, not a claim that all four are visibly reached everywhere. The current resident sun-material expression explicitly reaches only 0.86 and 1.00, with no roof/wall normals (`GpuWorldRenderer.js:189-202`; `docs/material-channel-contract.md:68-69`). District weather responses use the shared band vocabulary (`WeatherRenderer.js:304-332`). Neither adding physically reversed sunset key lighting nor smoothly multiplying every authored roof is a free improvement.

**Existing motivated light:** actual working or `tool_pending`, excluding departed residents, drives night-window occupancy; the gate starts only in the final fifth of dusk, with 400 ms rise and 1600 ms fall, snapping under reduced motion (`NightOccupancyGate.js:1-38`). Building visitor positions and status feed that tally (`BuildingSprite.js:4072-4089`), and the same gate reaches GPU emission (`GpuSceneBuilder.js:532-579`) and source intensity (`BuildingSprite.js:1537-1542`). Forge activity, watchtower distress and failed-push source hue already modulate emission (`BuildingSprite.js:1510-1526`). Do not propose occupancy-gated windows as new.

**Existing astronomical/weather sophistication:** seasonal sunrise/sunset offsets already exist (`AtmosphereState.js:40-63`), as do an approximate 29.530588853-day lunar phase and waxing flag (`:901-938`). Moon visibility changes with illumination/weather, but `buildLighting` currently derives ambient/shadows from solar phase/weather, not lunar illumination (`:1085-1118`). Rolling cloud shadows already exist in resident GPU: three cloud-layer-derived, stepped courses on foliage/earth/cobble, wind-driven and static in reduced motion (`GpuWorldRenderer.js:216-228,440-475`). Water already palette-cycles through ordered patterns and reflects local lights (`:176-186,281-286`). Lightning already has a seed-based forked bolt plus a cool-white or fleet-violet screen wash and emits `weather:storm-flash` with `{ intensity }` (`WeatherRenderer.js:919-969`). These are starting points, not new proposals.

**Quality gates:** hybrid FULL has half-resolution, two-stage bloom plus god rays/reflection/displacement/heat/pulse/grain; REDUCED uses quarter-resolution, one-stage bloom and drops rays/reflection while retaining displacement/pulse/grain; MINIMAL drops the optional chain and keeps direct grade/glows; DISABLED falls through to Canvas (`PostFx.js:597-612,801-849,911-947`; `WorldFrameRenderer.js:642-649`). Resident FULL admits up to 32 local lights, occlusion and bloom; REDUCED admits 10, attenuates weather inputs and uses lower bloom strength; MINIMAL admits four, drops the occlusion render and bloom, zeros rain/storm/wind inputs but retains fog/base scene. Resident DISABLED stays minimally resident rather than flickering to Canvas (`GpuWorldRenderer.js:1163-1221,1254-1259,1296-1339,1368-1380`). Cloud-shadow uniforms are still supplied at lower levels (`:1193-1201`). The shared ladder uses a 4 ms budget, 15-frame median, 1 s sustained overload, 3 s healthy probe/upload grace, and 1 s zero-upload FULL recovery (`PostFxLadder.js:25-34,208-328`). No ladder-policy proposal follows: I did not perform the required controlled 5/15/30 s series, and shared-host capture levels cannot diagnose startup hysteresis.

**Art direction, from the images:**
- 01/06: the dark blue dome and water against warm gate lamps are genuinely lovely; stepping through small warm islands gives the eye places to rest. Yet much of the lawn/building mass retains the same evenly readable night exposure, and some gold pools look like circles placed on the ground rather than light escaping an aperture. The waiting beacon wins, as it should. The screenshot is foreground-weighted and cannot judge the moon itself.
- 02: dawn's cool blue surrounding atmosphere and warm stone give a convincing early-hour contrast. The Lighthouse cap and Harbor illumination become very large, soft yellow masses; at overview scale they flatten detail and rival the actual work. This is a **FULL** still, so it is not an absent-bloom complaint.
- 03 versus 07: the visible stepped sun gives sunset a clear cause, but broad phase grading carries more of the time-of-day read than directed illumination of surfaces. These must not be treated as a matched quality benchmark: 03 is adaptive MINIMAL and 07 forced FULL, with different live fixture poses.
- 04: the still storm is legible without motion, and the dark water makes warm windows valuable. Thin diagonal rain plus a rather uniform cool wash says “weather”; it does not reveal where wet surfaces receive their light. Many bright birds are visual competition, but wildlife is outside this territory. No claim about animated lightning appearance comes from this reduced-motion frame.
- 05/08: the actual operator village is busy and occupied, not a staged empty diorama. Local warm light helps divide places, but a roof halo has no obvious reason to deserve more attention than the clustered live work. The opportunity is **better receiving surfaces and bounded energy**, not more independent glowing things.

## Proposals

All costs below are engineering estimates, not measured results; CPU/GPU figures target a 1920×1080 view on the reference M5-class GPU and must be measured in isolation. No proposal requires a framework, dependency, WebGPU or worker. `FULL/REDUCED/MINIMAL` refer to the resident path; fallback descriptions include Canvas and hybrid where necessary. New atmospheric animation claims the slow band, never another working/selection pulse; static light stays static.

### P1 — Window light that reaches the street
- **Pitch:** Let an occupied window illuminate nearby cobbles through its actual opening, rather than merely gaining a larger halo.
- **What the operator sees:** A narrow amber patch crosses a doorstep, breaks at a low wall, and softly steps onto the next cobble course; when the last real worker leaves, that patch goes dark with the window.
- **Real data it renders:** Existing named emissive-source geometry and RGB/A, `_emissiveGateFor(building)`, source `id/origin/intensity/radius`, authored occluder height/strength and terrain material; working eligibility remains `NightOccupancyGate.lightsBuildingWindows`, not a new occupancy interpretation.
- **Files touched:** `gpu/GpuSceneBuilder.js:532-584` for source geometry/gate; `gpu/GpuWorldRenderer.js:134-150,271-295` for receiving light; `LightSourceRegistry.js:3-35` for an optional source-aperture descriptor; `IsometricRenderer.js:10292-10313` for fallback stamps. Paths are under `claudeville/src/presentation/character-mode/`.
- **Sketch:**
  1. Pilot one named window source and its existing authored emission, not every luminous pixel.
  2. Add a bounded ground-receiver field, capped at 256×144 with two RGBA8 targets.
  3. Seed source aperture cells with gated color; reject opaque barrier cells.
  4. Propagate only one short neighborhood hop after the direct-light estimate; no cascade tree or long-range GI.
  5. Quantize the result to three authored warmth/energy courses with world-locked ordered dither.
  6. Apply to cobble/stone/earth receivers, never UI, unlit bodies or the whole roof.
  7. Cache until source/gate/occluder/camera bucket changes; no free-running simulation.
  8. FULL enables the field; REDUCED removes the extra hop; MINIMAL keeps the source/window only.
  9. Reduced motion updates only on real state changes; Canvas/hybrid use a cached clipped stepped doorstep stamp from the same source.
- **Cost:** L; estimated CPU 0.05–0.25 ms on changed frames, GPU 0.4–1.2 ms at FULL, approximately 0.3 MiB ping-pong storage plus a small occupancy field. No generated art; authored aperture calibration required for the pilot.
- **Risk:** This is the ambitious experiment, not permission to replatform. Earlier plan explicitly rejected radiance-cascade GI (`agents/plans/claudeville-fable-5.1-enhancement-implementation-plan.md:58`); a bounded additive one-hop field must earn its place in a real A/B and be cut if it cannot. Unknown geometry must not invent walls. Cap admitted sources before field work; 100 agents do not become 100 GI emitters. Shedding spill must not shed the original working/window cue.
- **Wow 1–5 / Informative 1–5:** **5 / 4**. Wow: emitted light finally belongs to the architecture. Informative: occupation becomes spatially visible beyond an easily occluded window, without inventing another state.

### P2 — Rain borrows the lantern's color
- **Pitch:** Extend source-specific reflections from water to genuinely wet cobble and quay material, replacing anonymous glint noise with reflected work light.
- **What the operator sees:** In rain, broken amber or existing arcane-color pixels lie below the corresponding lantern/window and end at dry timber; as rain stops, the patch slowly contracts with surface wetness.
- **Real data it renders:** `WorldFrameRenderer._surfaceWetness` driven by `weather.precipitation/type` (`WorldFrameRenderer.js:464-469`), material class and existing `MATERIAL_PROFILES` wetness/reflection (`MaterialRegistry.js:47-58`), admitted light positions/hues/intensities, occupancy gate inherited through source intensity.
- **Files touched:** `WorldFrameRenderer.js:464-479,626-630`, `gpu/GpuWorldRenderer.js:160-172,271-286`, `postfx/PostFxFeed.js:706-724`, `IsometricRenderer.js:10292-10313`; all under character-mode.
- **Sketch:**
  1. Carry the existing accumulated wetness into the resident feed rather than recomputing rain history in GLSL.
  2. Extend the existing local-light reflection receiver from water to approved cobble/stone surfaces.
  3. Use the real source hue and a world-space downward reflection footprint.
  4. Break the footprint with a stable material/position dither; no vertically mirrored whole screen.
  5. Occlusion and receiver material stop reflections crossing unrelated roofs or grass.
  6. Keep brightness below the source core and suppress generic glints where the reflection carries the read.
  7. FULL renders at most eight reflected sources; REDUCED four; MINIMAL keeps static wet darkening only.
  8. Reduced motion freezes the pattern; wetness still follows actual weather state.
  9. Canvas/hybrid draw capped cached stepped reflection stamps clipped to known wet road/quay masks.
- **Cost:** M; estimated CPU <0.1 ms, GPU 0.1–0.45 ms using the existing admitted-light loop, no new full-resolution target; Canvas cache capped below 0.5 MiB. Asset generation no.
- **Risk:** A reflection must identify its source, not imply an unsupported puddle or literal flood. Quantize on the world grid to avoid shimmer during pan. At 100 agents cap by source priority, not population. Reflection never becomes a brighter attention mark than its source.
- **Wow 1–5 / Informative 1–5:** **5 / 4**. Wow: rainy streets become a coherent illuminated place. Informative: the operator can locate active warm sources and read retained wetness without adding icons.

### P3 — The moon changes the night, not just its sprite
- **Pitch:** Use the already computed lunar illumination to select a restrained night fill, while preserving the authored upper-left key.
- **What the operator sees:** A bright-moon night has readable silver-blue stone and quieter lamp contrast; near new moon, unoccupied districts settle one palette course darker and actual work lights become more distinct.
- **Real data it renders:** `atmosphere.sky.moon.phase.illumination`, `moon.alpha`, `moon.visible`, clock date/phase, `weather.cloudCover`; these already exist at `AtmosphereState.js:901-938,1265-1267`. It is an approximate local-date lunar model, not geolocated astronomical accuracy.
- **Files touched:** `AtmosphereState.js:1085-1118,1237-1275`; `gpu/GpuWorldRenderer.js:189-215`; `IsometricRenderer.js:10251-10278`; existing shared grade table `gpu/GpuWorldPolicy.js:10-39` and darkness response `:366-374` (also read for this proposal).
- **Sketch:**
  1. Compute one moonFill scalar from visible moon illumination and cloud transmission.
  2. Limit influence strictly to night and night shoulders; no daytime relighting.
  3. Select two or three reviewed ambient palette states, never synthesize opposite-direction roof normals.
  4. Preserve minimum ground readability and the existing primary overlay layer.
  5. Apply identical semantic grade selection in resident, hybrid and Canvas paths.
  6. Cache by lunar/weather/phase bucket; no new animation, pulse band static.
  7. The base palette survives all ladder levels; optional tiny water silver course is FULL-only.
  8. Reduced motion is identical: the clock may change state, but there is no breathing exposure.
- **Cost:** S–M; negligible per-frame CPU/GPU beyond existing grade operations; a few cached palette entries, <16 KiB. Asset generation no; existing lunar assets stay.
- **Risk:** New moon must not make an operator's monitor unusably dark. This is time context, not agent health; never use it to infer productivity. At 100 agents nothing scales with population. Reject directional moon shadows until a real authored-light compatibility design exists.
- **Wow 1–5 / Informative 1–5:** **4 / 2**. Wow: the same village has truthful, distinct nights. Informative: it strengthens real clock context but carries little new operational state, so it is not a first implementation pick.

### P4 — Fog receives light without swallowing work
- **Pitch:** Make the existing spatial haze field receive bounded, stepped source color while carving clear space around the focused subject and roads.
- **What the operator sees:** Harbor haze catches a low amber fan beneath its windows, stays blue in unlit water, and parts around a selected crossing; there is no new fog sheet pasted across labels.
- **Real data it renders:** Existing `_hazeField` and `_gpuHazeStrength`, water/lowland anchors, road and focused-subject carve geometry, `weather.fog`, `motion.windX`, and admitted source hue/intensity. The shared ground-field constants and carve contract are at `WorldFrameRenderer.js:29-40`; resident record at `GpuSceneBuilder.js:305-338`.
- **Files touched:** `WorldFrameRenderer.js:511-514` and existing haze field functions; `gpu/GpuSceneBuilder.js:305-338`; `gpu/GpuWorldRenderer.js:271-295`; Canvas field draw seam `WorldFrameRenderer.js:1249-1300`.
- **Sketch:**
  1. Reuse the quarter-resolution occupancy field; do not create a second fog simulation.
  2. Admit at most four nearby lights to a small field-color update.
  3. Multiply source contribution by existing haze occupancy and occlusion, not screen Y alone.
  4. Use three density/color courses and world-locked ordered dither at the boundary.
  5. Preserve the road/subject carve after light coloration.
  6. FULL includes colored crests at at most 5 Hz; REDUCED freezes crests and retains source-color changes; MINIMAL uses the existing neutral field.
  7. Drift, if admitted, uses the slow band and shared wind, not another sine per source.
  8. Reduced motion allocates no drifting state; recalculate only real input changes.
  9. Canvas/hybrid reuse a cached tinted field image below depth-sorted subjects; UI is never fogged by this pass.
- **Cost:** M; estimated CPU 0.1–0.4 ms on 5 Hz field refreshes, GPU 0.1–0.3 ms, ≤0.5 MiB additional retained field data at the reference viewport. Asset generation no.
- **Risk:** The existing haze already communicates fog; the delta must be visible source reception, not another additive wash. Colored fog can imply a false incident if arbitrary colors are invented, so inherit only real source colors. At 100 agents freeze ornament under pressure, keep carve and ground readability, cap source count.
- **Wow 1–5 / Informative 1–5:** **5 / 3**. Wow: shafts and colored crests suggest volume without smooth volumetric rendering. Informative: it locates the actual sources through adverse visibility, although it is less operationally valuable than window spill.

### P5 — Lightning reveals structure instead of bleaching the screen
- **Pitch:** Let the already scheduled weather strike illuminate terrain-facing edges and then recede, rather than only placing a bright screen wash over the village.
- **What the operator sees:** One brief cold course picks out stone edges and wet quay pixels under the visible bolt, while the selected/action-needed marks remain steady; the afterglow is restrained, not a second alarm.
- **Real data it renders:** Existing seeded strike cycle, intensity and `weather.cause` in `WeatherRenderer._drawStormFlash` (`WeatherRenderer.js:919-959`), plus authored material/occluder data. Existing `weather:storm-flash` exposes only intensity (`:941`); a source origin/envelope descriptor would be an explicit additive event contract, not a field that exists today.
- **Files touched:** `WeatherRenderer.js:919-969`; `WorldFrameRenderer.js:448-479,626-640`; `postfx/PostFxFeed.js:711-724`; `gpu/GpuWorldRenderer.js:189-215,260-295`; `postfx/PostFx.js:126-146`.
- **Sketch:**
  1. Derive bolt origin and scene-light envelope from the existing deterministic strike schedule.
  2. Publish one renderer-local descriptor before scene draw; keep the existing audio event exactly once per strike.
  3. Replace, rather than stack on, most of the screen-wide wash energy.
  4. Apply one short, bounded material palette lift to visible stone/cobble/water receivers.
  5. Quantize edge response; do not add a moving normal-map key or screen-wide white flash.
  6. Preserve the existing short event cadence: fast band, one-shot only.
  7. FULL uses silhouette-aware response; REDUCED uses one material course; MINIMAL keeps a capped existing sky cue.
  8. Reduced motion has no strikes, matching the current policy; static storm palette remains its complete fallback.
  9. Canvas/hybrid use cached material/structure silhouette stamps, never redraw dynamic UI into a lighting texture.
- **Cost:** M–L; estimated CPU <0.1 ms steady, 0.2–0.6 ms on strike setup; GPU 0.05–0.25 ms during the short envelope; cache ceiling 0.5 MiB. Asset generation no; requires careful reviewed receiver masks if current geometry is insufficient.
- **Risk:** Photosensitivity and false urgency are the dominant risks. Do not increase strike frequency/intensity. Timeline storms cannot claim an agent incident, and fleet storms must retain their documented cause rather than target an arbitrary building. At 100 agents no per-agent work; primary marks remain unchanged. This needs motion/video review, not only the static storm capture.
- **Wow 1–5 / Informative 1–5:** **5 / 3**. Wow: a real lighting event briefly reveals the diorama's construction. Informative: it clarifies weather and geometry, not the cause of a particular agent failure.

### P6 — One dusk exposure contract
- **Pitch:** Choreograph sunset as a transfer from sky illumination to occupied-source illumination with one bounded energy budget, not several independently brightening effects.
- **What the operator sees:** As the sky cools, window cores become readable first, then their small street spill and reflection; empty places settle quietly, while the Lighthouse no longer becomes a diffuse yellow competitor to live work.
- **Real data it renders:** Clock `phase/phaseProgress`, `lighting.ambientLight/lightBoost/beaconIntensity`, `grade.buildingGlowScale`, `NightOccupancyGate` working gate and the named source's existing intensity/priority. It does not schedule fictitious lamplighters or turn on empty offices.
- **Files touched:** `AtmosphereState.js:1055-1118`; `BuildingSprite.js:1510-1542`; `NightOccupancyGate.js:8-38`; `gpu/GpuWorldRenderer.js:253-257,1203-1240,1296-1313`; `postfx/PostFx.js:149-167,801-849`; `IsometricRenderer.js:10292-10313`.
- **Sketch:**
  1. Define an explicit source-energy envelope shared by core, local receiver and bloom consumers.
  2. Keep the existing working-window gate authoritative; do not re-propose or bypass it.
  3. Allocate most energy to the emissive core and near receiving material, less to broad bloom.
  4. Advance through a few reviewed clock/exposure buckets instead of multiplying several continuous boosts together.
  5. Source geometry and priority cap halo area; brightness does not grow with a crowd count.
  6. Preserve action-needed overlays outside this budget and outside scene grade.
  7. FULL receives core/spill/reflection/bloom; REDUCED sheds bloom first; MINIMAL retains the same readable core.
  8. Reduced motion snaps bucket transitions; no decorative per-building pulse or simulated switch-on parade.
  9. Canvas/hybrid consume the same envelope with cached quantized stamps, preventing a second exposure convention.
- **Cost:** M; estimated CPU <0.05 ms, GPU neutral or lower if redundant boosts/bloom energy are removed; <32 KiB retained scalar/cache state. Asset generation no.
- **Risk:** This is an artistic unification, not proof of a numeric exposure bug. The dawn/Golden screenshots differ in adaptive quality, so do not calibrate against their brightness delta. Calibrate forced-FULL and Canvas time-series separately; preserve authored emission hues. 100 agents must not raise the village's ambient exposure or dim a lone waiting cue.
- **Wow 1–5 / Informative 1–5:** **4 / 4**. Wow: an evening reads as one deliberate scene rather than a stack of effects. Informative: actual occupied sources become more legible as environmental light recedes.

## Top three

1. **Window light that reaches the street.** This is the largest frontier: not a new decorative object, but visible causality between actual work, the existing window gate and nearby material. The midnight source frames already have attractive lamps; they do not need more lamps. They need a small, occlusion-respecting consequence. Start with one landmark and reject the experiment if its extra hop looks like an expensive halo. Its ambition is spatial evidence of occupancy, not a generic GI engine.

2. **Rain borrows the lantern's color.** The existing water branch gives a low-risk seam for a visually dramatic step. In the storm still, most rain information is carried by overlay streaks and a cool wash. Source-colored wet cobbles would make weather physically legible while strengthening the same truthful lamps. It scales with capped admitted sources rather than residents and has a straightforward static Canvas fallback.

3. **One dusk exposure contract.** This should accompany either experiment rather than wait for a new rendering platform. Dawn's very broad Lighthouse/Harbor light and the busy live night's roof halo show why stronger effects alone can degrade the instrument. A shared energy contract lets existing warm cores, future spill, and wet reflections cooperate. It preserves attention hierarchy and makes the high-tech additions feel authored.

## Rejected

- New moon-phase sprites, seasonal day lengths, rolling GPU cloud shadows, occupancy-gated windows, generic palette-cycling water: already implemented at the source anchors above.
- Unbounded radiance cascades, screen-space path tracing, WebGPU or OffscreenCanvas: not justified by this research; no OF-007/OF-008 trigger measured. P1 is explicitly a capped additive experiment, not a back door to any of them.
- Smooth physically rotated sunset normals on every roof: conflicts with the authored warm upper-left light and would expose missing geometry rather than improve it.
- More generic bloom, film grain or chromatic aberration: the current source frames need less competition and better light reception, not another camera defect.
- Night sky that turns red because one agent failed: it falsely promotes local state to a shared world condition; source-specific attention already exists.
- Fog that encodes quota percentages, inferred anxiety or a made-up mood: violates the real-data/attention-count contract and makes natural weather ambiguous.
- Animated lamplighters, fake room silhouettes and idle window flicker: invented activity, additional motion owners, no new truthful information.
- A better-looking distant shore: expressly rejected by the maintainer and carries no meaning here.
- Ladder retuning based on these captures: 35-second loaded-host snapshots, including genuine FULL examples, do not establish a startup-policy deficit. No 5/15/30-second series was performed; no policy change is proposed.

## Open questions for the coordinator

- Measure an isolated, native-clock daytime/nighttime 100-agent budget before accepting P1. This note supplies visual evidence and estimates, not GPU headroom proof.
- Confirm which named window apertures have sufficient reviewed geometry for a one-landmark spill pilot. Existing source/sidecar geometry is authoritative; missing geometry should block that source, not be inferred from brightness.
- Agree whether a shared source-energy contract may reduce Lighthouse/Harbor halo radius while preserving their present semantics. The visual critique is grounded in 02/05, but exact tuning requires matched forced-FULL frames and Canvas review.
- The original helper's hour diagnostic was null; the scene inputs and explicit `_lastAtmosphere.clock` probe are the authoritative time evidence. Do not use null diagnostics to infer clock failure.
- The reduced-motion storm capture verifies the static result, not a lightning animation. Any P5 implementation needs real-GPU motion review and flash-safety judgment.
- The earlier Fable plan prohibited radiance-cascade GI. The current exploration explicitly invites frontier light transport, so P1 is recorded as a conditional bounded alternative, not an approved reversal of that policy.
