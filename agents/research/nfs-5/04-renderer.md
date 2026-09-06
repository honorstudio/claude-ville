# Renderer performance investigation

Status: ready — read-only source audit plus isolated Node microbenchmarks; no source files or running services changed.

## Executive summary

- The top-bar “60 FPS” is a 500 ms average of renderer `requestAnimationFrame` callback count, not presentation latency, GPU completion, or a frame-time distribution; it can hide p95/p99 hitches and queued GPU work.
- Hidden tabs and Dashboard mode do stop the World loop and release the large backing stores. Active World mode has no dirty-frame idle path and redraws/simulates continuously, even when reduced motion makes the scene nearly static.
- The clearest session-age regression is Harbor traffic: docked ship history grows to 2,048 entries, yet the renderer rebuilds/sorts traffic every frame before culling or visual packing; an isolated 2,000-ship run cost 2.21 ms mean / 4.32 ms p95 while emitting only 10 drawables.
- Dense-agent cost is not just sprite drawing: every agent updates off-screen, moving agents force an `O(A log A)` Y-sort, and overlay placement has worst-case `O(A^2)` overlap/cluster scans before viewport culling.
- Dynamic drawables, GPU records, normalized GPU records, batches, diagnostics, Maps/Sets, arrays, strings, and closures are rebuilt every frame. This creates substantial young-generation GC pressure that an averaged FPS badge cannot show.
- DPR is capped correctly, but the cap still permits 7.5M pixels per full-resolution surface. The default GPU path has at least a full-resolution scene pass plus full-resolution composite; full quality adds a second scene attachment and 0.375-scale occlusion/bloom passes.
- Constructor topology itself is small; a no-op-canvas lower bound was ~5 ms p50. Cold renderer cost is synchronous foliage rasterization and WebGL setup, followed by a lazy first-frame 6.56M-pixel terrain bake/material sidecar/texture upload. Browser wall time could not be captured because the maintained server was unavailable.
- No general unbounded renderer leak was found. Most caches and histories are capped and teardown is strong; Harbor's high cap is a practical growth problem, while one biography-dedup Set is genuinely session-unbounded but unlikely to be the main slowdown.

## Scope and evidence

The audit followed `App._loadRenderer()`, `IsometricRenderer._loop()`, `renderWorldFrame()`, agent/harbor simulation, drawable construction/culling, GPU scene building/batching, post-processing, canvas budgeting, lifecycle cleanup, and the shared client performance instrumentation. Asset-file and atlas-pipeline contents were not analysed.

The maintained `http://localhost:4000` endpoint was not reachable during this investigation. Per instructions I did not start, restart, or kill a server. Runtime numbers below are therefore explicitly identified as isolated Node microbenchmarks or arithmetic estimates, not browser frame captures.

Two isolated measurements were useful:

1. `HarborTraffic.enumerateDrawables()` was exercised after reducing synthetic commit events into real Harbor state, with 20 warmups and 200 timed calls per size. On this machine it scaled as follows:

   | Retained ships | Emitted drawables | mean | p50 | p95 | max |
   | ---: | ---: | ---: | ---: | ---: | ---: |
   | 100 | 10 | 0.148 ms | 0.105 ms | 0.362 ms | 0.900 ms |
   | 500 | 10 | 0.555 ms | 0.447 ms | 1.185 ms | 3.328 ms |
   | 1,000 | 10 | 1.091 ms | 0.822 ms | 2.849 ms | 6.345 ms |
   | 2,000 | 10 | 2.206 ms | 1.736 ms | 4.319 ms | 14.044 ms |

   This isolates JavaScript layout/allocation only; it excludes Canvas drawing and the second Canvas-fallback wake enumeration. It demonstrates that visual packing caps output but not preprocessing cost.

2. `_assignAgentOverlaySlots()` was called against collocated fake sprites using the real placement methods, also 20 warmups/200 samples. At 200 agents it measured 0.941 ms mean / 1.986 ms p95 / 5.493 ms max versus 0.146 ms mean at 50. This is not a full renderer benchmark, but it confirms the worst-case overlap algorithm's super-linear shape and its allocation tail.

A third test replaced Canvas operations with no-ops and constructed the normal 40×40 world 30 times: 85 static props and 65 foliage-cache entries took 5.04 ms p50 / 9.20 ms p95. This is a **lower bound only**: it measures topology generation but deliberately excludes actual 2D rasterization, WebGL compilation/allocation, agents, and first-frame work.

## Frame-cost model

### Scheduling and update

The live frame is `IsometricRenderer._loop()` at `IsometricRenderer.js:3342-3401`. Each renderer rAF:

1. Computes a callback gap and clamps simulation `dt` to 50 ms (`:3347-3351`).
2. Runs `_update(dt)` and then `_render(dt)` synchronously (`:3361-3375`).
3. Records CPU update/render envelopes and the visible FPS counter, then requests another rAF (`:3380-3400`).

There is no dirty-scene test in this path. In active, visible World mode the complete update and render run even with no session delta. Continuous camera drift, weather, water, particles, villagers, and clocks justify animation while enabled, but even reduced-motion/no-agent scenes still clear and reconstruct the frame. A safe idle mode can be narrower: only when motion is disabled and no timed transition, camera move, weather transition, or pending resource work exists.

`_update()` is primarily entity-count based (`IsometricRenderer.js:3673-3816`):

- Every `AgentSprite` updates every frame, including off-screen sprites (`:3726-3743`; `AgentSprite.js:2092-2264`). The normal active path advances six gesture/mote systems before movement (`AgentSprite.js:2116-2125`). Departed sprites do have a cheap resting early return (`:2097-2113`).
- Any moving sprite changes Y and marks the cached agent order dirty, so `_snapshotSortedSprites()` rebuilds an array and sorts `O(A log A)` on most animated frames (`IsometricRenderer.js:2088-2094`, `:3739-3747`).
- Lane steering is `O(moving agents)` (`:4016-4067`). Local avoidance uses reusable spatial buckets rather than all-pairs globally (`:4069-4191`), which is good, although dense single buckets can still approach pairwise work and allocate string cell/pair keys.
- Four-times-per-second work creates bursty allocations: chat matching makes a Set, Map, and per-agent alias arrays (`:3600-3651`); visits snapshot all agents (`:2568-2583`); relationship and crowd state rebuild arrays/maps; Harbor reconcile runs (`:3692-3710`, `:3760-3788`). Stationary overlap runs every 420 ms and starts with `Array.from(...).filter(...)` (`:4265-4298`). These bursts are credible p95/GC-hitch sources even when the 500 ms FPS average stays near 60.
- `LandmarkActivity`, `VillageDirector`, buildings, seasonal effects, rain, and particles all update each frame (`:3794-3816`). Chronicle work is limited to a 1 s cadence and guards concurrent updates (`:3721-3724`, `:3819-3835`).

### Render orchestration

`renderWorldFrame()` at `WorldFrameRenderer.js:403-783` performs this full pipeline every frame:

- Setup: new viewport object, scene-category enumeration/resolution, overlay full clear, `new Date`, atmosphere/weather updates, an atmosphere spread object, and full light-source collection (`:409-475`).
- Main Canvas: full clear, cached sky blit plus live layers, distant-sea gradients, camera transform, and Canvas terrain/weather when GPU World is unavailable (`:477-527`).
- Entity prelayers: relationship marks and crowd effects iterate semantic collections before entity culling (`:529-577`).
- Collection: all buildings, all sorted agents, visible static props, Harbor category, landmarks, monuments, chronicler, familiars, pending-repo signature, and overlay slots (`:579-600`).
- Depth pass: create a combined list, fully sort it, then cull it, then draw it (`:602-630`).
- Effects and GPU/postfx: build a feed, rebuild GPU records, render full-screen GPU output or upload Canvas to legacy PostFX (`:631-702`).
- Overlay: full clear already occurred; foreground weather, trails/categories, primary marks, **all sorted agents' GPU overlays**, building labels, full per-frame diagnostics, screen particles, summaries and camera/director UI draw afterward (`:703-782`). The GPU overlay loop at `:727-730` is not limited to the culled drawable set.

### Allocation and CPU hot spots

The highest-confidence avoidable sites are:

1. **Overlay layout before culling.** `_assignAgentOverlaySlots()` allocates two occupancy arrays and `filter().sort()` over all agents every frame (`IsometricRenderer.js:4554-4567`). Each agent tests up to four rectangles against a growing occupied list (`:4595-4597`, `:4643-4658`). Full-mode name placement uses repeated `Array.some` scans (`:4608-4624`). Bubble placement allocates more filtered/sorted arrays, rectangles, and occupied arrays (`:4627-4640`, `:4667-4707`); cluster merging then scans a growing cluster list and allocates a Map and group arrays (`:4718-4769`). This is worst-case `O(A^2)`, applies before viewport culling, and calls `_activityThread()` again to build merge keys (`:4777-4783`).
2. **Depth wrappers before culling.** `createDepthDrawable()` creates an object plus a fallback closure for each dynamic building, agent, scene-category item, landmark, monument, chronicler and familiar (`DrawablePass.js:32-64`, `:105-151`). The entire list is sorted at `:151`; only afterward does culling compact it (`:227-252`). Static props are a partial exception: their wrapper objects are cached and they are screen-tested before append (`IsometricRenderer.js:2112-2129`).
3. **Harbor reconstruction.** `enumerateDrawables()` creates Maps/Sets/arrays and one ship drawable for every retained ship (`HarborTraffic.js:3558-3593`), creates per-squad Maps and anchor arrays (`:3594-3602`), and uses `findIndex` inside the squad loop (`:3655`), which is quadratic within a large squad. It then sorts departing ships, creates and sorts convoy groups, clones convoy objects, builds crates/buoys/anchorages, sorts the final list, and allocates a second filtered hit-test list (`:3667-3716`). Canvas fallback calls `enumerateWakeDescriptors()`, which calls `enumerateDrawables()` again (`:3807-3816`; `IsometricRenderer.js:6576-6595`, `:7101-7110`). Default GPU avoids that duplicate terrain/wake path but still performs the category enumeration once.
4. **GPU packet rebuilding.** `decideAtlasCategories()` builds two Maps and repeatedly spreads their values into reduce arrays every frame (`GpuSceneBuilder.js:908-950`). `buildGpuWorldRecords()` allocates record objects, filters the record array three times, then spreads three arrays together (`:992-1027`). Agent atlas packing sorts a fresh roster and resets three update arrays every frame (`:707`, `:783-785`). `buildStableGpuBatches()` maps every record into another normalized object, filters it, builds a string batch key, and allocates batch records arrays (`GpuWorldPolicy.js:178-207`). Vertex storage itself is reused and grown geometrically (`GpuWorldRenderer.js:887-920`), which is good.
5. **Always-on diagnostics.** Even with the debug overlay disabled, every frame creates culling/layer summaries, `Object.fromEntries` category counts, GPU diagnostics/resource copies, render-stat subobjects, and finally spreads the full stats object again (`WorldFrameRenderer.js:740-760`, `:779-782`; `:1380-1412`; `DrawablePass.js:255-270`). Detailed timing rings are correctly opt-in, but these structural diagnostics are not.
6. **Semantic DOM summary.** Every render calls `_syncSemanticSummary()` (`IsometricRenderer.js:4429-4438`), which does `document.getElementById`, `Array.from().map().filter()`, bucket counting, and string construction every frame; only the final DOM assignment is change-guarded (`:4441-4448`). This should be event-driven or 2–4 Hz, not 60 Hz.
7. **Canvas gradients and conditional raster work.** Distant sea/horizon creates several gradients each frame (`IsometricRenderer.js:8618-8737`); waterfalls create stream/mist gradients (`:9381`, `:9435`); cloud shadows copy/sort layers and create up to six radial gradients plus `toFixed` strings per Canvas frame (`WorldFrameRenderer.js:1215-1275`). Weather/Sky have additional live gradients, although their static background is cached (`SkyRenderer.js:247-283`, `:443-474`).
8. **Ground haze rebuilds.** Haze is a useful cache when the key is stable, but the camera key is quantized at only 0.5 px. A drifting camera can invalidate it repeatedly. Rebuild allocates a quarter-resolution `Uint8Array`, samples every cell, creates/paints an ImageData buffer, and calls `putImageData` (`WorldFrameRenderer.js:286-319`, `:1063-1135`). At 1600×1000 CSS and 0.25 scale this is 100,000 occupancy samples plus 400,000 RGBA writes per rebuild. The cache correctly suppresses rebuild under reduced motion once a field exists.
9. **Wetness geometry.** While wet, damp marks rebuild path/dock/roof/footing point arrays and mark objects (`WorldFrameRenderer.js:366-390`; `IsometricRenderer.js:6716-6810`). The ground call is Canvas-only, but roof marks still run on the GPU path (`WorldFrameRenderer.js:629`). The underlying geometry is static and can be cached; only alpha needs updating.

No per-frame `getBoundingClientRect()` was found. The only renderer reads are pointer-event handlers (`IsometricRenderer.js:1669`, `:1685`). Agent `getImageData`/`putImageData` sites belong to sprite/profile raster preparation, not the steady draw loop (`AgentSprite.js:2949-3019`, `:3936-3942`). Shader programs compile during renderer/context initialization, not per frame (`GpuWorldRenderer.js:484-506`).

### Scaling and culling verdict

| Subsystem | Scaling actually paid | Culling verdict |
| --- | --- | --- |
| Agent simulation | `O(A)` every frame, plus spatial-neighbour work; four-Hz bursts | No viewport cull; all agents simulate off-screen |
| Agent Y order | `O(A log A)` whenever any sprite Y changes | Before culling |
| Agent labels/bubbles | worst-case `O(A^2)` plus sorts | Before culling; all agents receive compact slots |
| Static props | scans static list, screen-tests, then uses cached drawables | Good pre-cull, although list scan remains |
| Buildings | enumerate all; small fixed population | Cull after wrapper creation/sort |
| Harbor | scales with retained ships/repos, not packed/visible ships | Pack/cull too late; Canvas may enumerate twice |
| GPU records/batches | scales with culled depth drawables, then multiple full-array transforms | Culling helps actual record count, but packet objects are rebuilt |
| GPU agent overlays/label hit rects | scales with all sorted agents | Not tied to culled drawables (`WorldFrameRenderer.js:727-739`) |

The current culler is real and useful, but it mostly prevents draw/GPU-record work. It does not prevent entity simulation, Harbor layout, dynamic wrapper creation, the global depth sort, overlay placement, GPU overlay loops, or label-hit-rect collection. Performance therefore scales materially with total entities and retained Harbor history, not only visible entities.

### Resolution and full-screen pass model

`effectiveCanvasDpr()` uses exact `deviceDpr / integer divisor` rungs and a 7.5M-pixel per-surface ceiling (`CanvasBudget.js:60-95`). It does cap quadratic Retina growth. Example outputs from the real function at requested DPR 2:

| CSS viewport | effective DPR | backing pixels | one RGBA surface |
| --- | ---: | ---: | ---: |
| 1280×720 | 2.0 | 3.686M | 14.1 MiB |
| 1600×1000 | 2.0 | 6.400M | 24.4 MiB |
| 1920×1080 | 1.0 | 2.074M | 7.9 MiB |
| 2560×1440 | 1.0 | 3.686M | 14.1 MiB |
| 3840×2160 | 0.667 | 3.686M | 14.1 MiB |

Thus DPR is **not uncapped**, but large high-DPR laptop windows can still reach 6.4–7.5M pixels. Cost is multiplied across main Canvas, transparent overlay, WebGL drawing buffer and GPU attachments. The budget's seven-surface count is policy/accounting, not a reduction in per-frame fill (`CanvasBudget.js:13-32`).

The default GPU path allocates two full-resolution scene attachments and bloom A/B plus occlusion at 0.375 scale (`GpuWorldRenderer.js:628-669`). Attachment memory is approximately `4 bytes × pixels × (2 + 2×0.375² + 0.375²) = 9.6875 bytes × pixels`, before cached source textures. At 1600×1000 DPR 2, this is an estimated 59.1 MiB of GPU attachments alone. Full-quality drawing includes optional 0.375-scale occlusion, a full-resolution scene/MRT pass, two 0.375 bloom passes when lit, and a full-resolution composite (`GpuWorldRenderer.js:1094-1160`, `:1202-1224`). Minimal still renders the full-resolution scene and full-resolution composite. “Disabled” is deliberately mapped back to a resident minimal GPU scene (`:1172-1180`), so there is no true zero-postprocess active level.

The legacy PostFX fallback is worse for bandwidth: it uploads the full Canvas source every frame, runs its main full-screen shader, optional bloom, and composite (`PostFx.js:906-1004`). Its own ladder explicitly states that every active level uploads/presents full resolution (`PostFxLadder.js:5-6`).

This is the most plausible explanation for “slower on large resolutions while FPS says 60”: input/presentation latency and GPU occupancy can rise substantially without reducing the renderer's half-second rAF callback count. The GPU ladder can see asynchronous timer queries when `EXT_disjoint_timer_query_webgl2` exists (`GpuWorldRenderer.js:1182-1185`, `:1237-1245`). Without that extension it falls back to CPU submission plus only a frame-gap penalty above 35 ms (`PostFxLadder.js:74-82`); a GPU that remains queued at a 16.7 ms callback cadence can therefore look healthy to both the ladder and top bar.

## FPS-measurement critique

### What the UI reports

`_trackFps()` increments once per successful renderer rAF callback and, every ≥500 ms, emits `round(callbacks × 1000 / elapsed)` (`IsometricRenderer.js:3459-3472`). This number answers “how often did this JavaScript callback begin over the last half second?” It does **not** report:

- CPU frame cost distribution or budget headroom;
- missed vsync count normalized to the display's actual refresh interval;
- GPU completion/presentation latency or queued frames;
- p95/p99/max callback gaps;
- long tasks, input delay, or GC pauses;
- update/render attribution;
- whether quality silently degraded to keep callback cadence.

A half-second bucket can show 60 after one 50–100 ms hitch if nearby callbacks bunch/recover, and TopBar history only stores those already-averaged samples. It is therefore fully capable of masking the reported regression.

### Better instrumentation already present, but off by default

`ClientPerfMetrics` is constructed at boot (`App.js:323`) but starts disabled (`ClientPerfMetrics.js:330-402`). No production `.start()` call exists; users must invoke `window.__claudeVillePerf.startClientPerf()` (`App.js:1216-1232`). Once enabled it:

- maintains a 600-sample rAF-gap buffer and intentionally uses callback-time `performance.now()` so delayed callbacks widen the gap (`ClientPerfMetrics.js:665-724`);
- reports p50/p95/max frame gaps and separates delta-associated/baseline frames (`:568-619`);
- observes long tasks and Event Timing input delay when supported (`:735-815`);
- attributes long tasks against renderer update/render windows (`:818+`).

This is materially more honest than the top-bar FPS, but it still omits p99 and dropped-frame estimates. Its rAF is a separate diagnostic callback, not proof of Canvas/WebGL presentation. The renderer frame envelope always keeps latest/EMA scalars, but p95 rings are enabled only during a frame profile or client-perf run (`IsometricRenderer.js:3517-3525`; `ClientPerfMetrics.js:164-234`). Its snapshot exposes p95 but not p50/p99 (`ClientPerfMetrics.js:237-307`). Segment timing similarly exposes p50/p95 only while profiling (`IsometricRenderer.js:3475-3597`).

The existing `world-fps-benchmark.mjs` improves on the badge by recording rAF deltas and p50/p95/max/over-50 ms, and it covers 1–200-agent fixtures (`scripts/smoke/world-fps-benchmark.mjs:137-193`, `:196-222`). It still uses a separate rAF callback, defaults to DPR 1, lacks p99/refresh-normalized dropped frames/long tasks/GC/presentation tracing, and therefore cannot close this complaint by itself.

### Required measurement contract

For a 30–60 s steady window after warmup, record all of the following per scenario (1/50/100/200 agents, clear/heavy weather, empty/no-change, young/old Harbor, DPR/resolution matrix):

- rAF gap p50/p95/p99/max and histogram, using callback-time `performance.now()`;
- estimated missed display intervals: first measure median display interval, then sum `max(0, round(gap / interval) - 1)`; report percentage of frames over 1.5× and 3× interval;
- renderer update/render/total p50/p95/p99/max and named render segments;
- long-animation-frame/long-task counts, duration, and update/render attribution;
- input Event Timing p95/p99 while panning/selecting;
- GPU timer p50/p95/p99 plus timer support/disjoint/error status, upload bytes/time, quality level/reason and transitions;
- heap/Canvas/GPU resource snapshots and allocation sampling before/after 10 and 60 minutes; correlate GC/long frames in a Chrome trace;
- Chrome FrameTimeline/DevTools trace for actual presented/dropped frames and GPU queueing. A non-blocking fence/timer-query lag diagnostic is acceptable; do not use `gl.finish()` in production.

The top bar should display at least frame-time p95 (or “frame health”), worst recent hitch, and quality level next to callback FPS. “60 FPS / p95 28 ms / GPU 14 ms / quality reduced” is honest; “60 FPS” alone is not.

## Init-cost findings

`App` serially awaits base assets, material assets, `_loadRenderer()`, and only then `_loadDashboard()` (`App.js:243-263`). Renderer loading itself combines dynamic-module evaluation, synchronous constructor work, synchronous `show()`, and setup before returning (`App.js:885-960`). There are no User Timing marks separating these phases or first presentation.

### Synchronous constructor work

`IsometricRenderer` constructs most of the subsystem graph up front (`IsometricRenderer.js:439-647`) and then performs substantial deterministic scene generation:

- 1,600 terrain-noise samples and authored path generation (`:648-662`);
- water rasterization, shore metadata/BFS, bridge/descriptors, terrain features, vegetation, trees and boulders (`:663-793`; `SceneryEngine.js:21-51`, `:136-191`, `:345-383`, `:672+`);
- static drawable caches/fast paths and prop-footprint index (`IsometricRenderer.js:794-805`);
- walkability/Pathfinder, lane index, command ambience, and emitters (`:807-830`).

An important hidden constructor cost is foliage prerendering: asking each fantasy tree for bounds calls `_getFantasyForestTreeCache()`, which creates a Canvas and procedurally paints each unique variant/scale/seed (`IsometricRenderer.js:735-756`; `FoliageRenderer.js:28-36`, `:96-123`). The normal scene produced 65 such cache entries in the isolated lower-bound run. This is renderer processing, not asset-file loading.

The no-op-canvas result (~5 ms p50 topology) shows that plain 40×40 JS generation alone cannot plausibly explain a 20–30 s cold load. It does **not** exonerate synchronous raster/GPU work.

### Synchronous `show()` and first frame

`show()` obtains three contexts, constructs the default WebGL renderer, resizes it, creates Camera/CameraDirector, attaches listeners, constructs one `AgentSprite` per live agent, creates event/relationship systems, replays active rituals, and reconciles visits (`IsometricRenderer.js:1469-1583`). `GpuWorldRenderer` synchronously compiles/links four programs and allocates targets/textures during construction (`GpuWorldRenderer.js:367-482`, `:484-520`). Each `AgentSprite` snaps to walkable terrain and picks a target/path in its constructor (`AgentSprite.js:737-937`), so `show()` scales with initial agents.

Expensive work is then hidden in the first rAF rather than `_loadRenderer()`:

- `_getTerrainCache()` creates and paints a static 3,280×2,000 Canvas: 6.56M pixels / about 25.0 MiB RGBA, including all 1,600 tiles (`IsometricRenderer.js:5122-5156`, `:5159+`, `:6495-6547`).
- GPU terrain record creation synchronously creates a quarter-scale procedural material sidecar before authored material arrives (`GpuSceneBuilder.js:198-264`, `:266-285`).
- the terrain, atlases, agent frame atlas, and individual sources upload on first use; agent sprite/profile sheets and equipped Codex sheets are prepared lazily during first draw (`AgentSprite.js:2614-2706`, `:3720-3970`).
- the opening establishing camera shot intentionally keeps the scene moving after first paint (`IsometricRenderer.js:2399-2415`), invalidating camera-keyed caches during warm-up.

The recent GPU fixes make steady-state channel uploads conditional and should remain: commit `3862123` eliminated repeated full atlas-channel uploads, and `05d069d` added dirty-region agent channel updates and resource release. Cold first-use uploads are still expected.

### What to defer or make progressive

First add User Timing marks for module-import, constructor, `show`, WebGL program/target setup, first rAF start/end, terrain bake, first texture upload, and first presented frame. Without these, assigning seconds to renderer init would be guesswork.

Then, in low-visual-risk order:

1. Paint a first static sky/terrain shell before constructing historical/semantic decorations (chronicle monuments/trails/chronicler, relationship replay, Harbor historical layout, director replay). These are not required for recognizing the village.
2. Move terrain-cache construction to an idle/progressive task or chunk it by terrain regions, retaining the Canvas fallback only until the cache is complete. Avoid partial checkerboarding; swap the complete cache atomically.
3. Prewarm only visible/active agents' sprite sheets before first paint; fill off-screen/inactive profiles in idle slices. Preserve stable placeholders/impostors until ready.
4. Compile the minimal GPU scene first and restore occlusion/bloom after first presentation (the quality ladder already starts at minimal at `GpuWorldRenderer.js:404-413`). If shader compilation itself is material, create the GPU renderer after a Canvas first paint and swap atomically.
5. Start `_loadDashboard()` in parallel with renderer module/constructor work after shared assets are ready, while keeping source ownership separate. Boot sequencing is owned by the other investigation, but the renderer should expose progressive-ready milestones rather than one monolithic completion point.

## Leak and growth findings

### High-confidence growth problem: Harbor history

Harbor state is bounded, but at very high limits: 2,048 ships and seen IDs, 1,024 pushes, 512 batches/quays, 4,096 tombstones, 1,024 replay floors, and 512 overflow cohorts (`HarborTraffic.js:35-43`). Docked ships have no age retirement. `pruneHarborShips()` does nothing until the ship Map exceeds 2,048, then removes by retention rank/age and records docked overflow (`:992-1022`). As a result, a long-lived session can gradually turn every frame from a 100-entry preprocessing problem into a 2,000-entry one even when visual output remains around ten packed ships.

This exactly matches “getting slower lately”: retained semantic history becomes steady per-frame CPU and allocation cost. It is not an unbounded leak, but its cap is much too high for a render-input collection. Semantic history and visual state should be separate: retain aggregate counts/tombstones for meaning while materializing only active departures plus a small per-repo packed representation for frames.

### Smaller growth/leak risks

- `VillageDirector._seenBiographyMilestones` adds `identity:milestone` keys for the renderer lifetime and has no size/age pruning (`VillageDirector.js:251-277`). Dispose clears it (`:139-150`). This is genuinely session-unbounded, but expected event volume is low and it is not on the per-frame scan path. Add a reasonable LRU/cap or persist dedup outside the renderer.
- `_pendingBiographyBanners` is also uncapped, though it drains one at a time when the scene budget permits (`VillageDirector.js:271-277`, `:293-304`). A prolonged release scene plus a burst of biography events can retain a queue. Cap/coalesce by identity.
- Ground haze Canvas data is retained in `renderer._hazeField`, but `releaseVolatileCaches()` does not release/null it (`IsometricRenderer.js:1902-1955`; `WorldFrameRenderer.js:1105-1135`). This is bounded to one field and is not cumulative, but it unnecessarily survives Dashboard/hidden suspension. At 3840×2160 CSS and 0.25 scale its RGBA mask is about 2 MiB.
- Module-level `_glideVignetteCache` is capped at 24 (`WorldFrameRenderer.js:798-802`). The scene-category diagnostic Set is bounded by the finite category/backend/code product. GPU timer queries are capped at four and deleted (`GpuWorldRenderer.js:820-864`).

### Explicitly checked and healthy

- Renderer `hide()` unsubscribes event-bus handlers, removes Canvas/window/channel listeners, detaches Camera/Sky/motion state, disposes semantic systems, GPU and PostFX, releases caches, and clears backing stores (`IsometricRenderer.js:1733-1790`, `:1902-1990`). Camera, BuildingSprite, GPU renderer, and PostFX pair listener installation with removal.
- Agent sprites release private canvases, profile ownership and channel records (`AgentSprite.js:940-965`). Shared processed/equipment/GPU-sheet caches have entry and pixel caps (`:166-184`, `:2942-2969`, `:3811-3843`, `:4272-4325`).
- GPU cached sources are limited to 48 MiB/512 entries and trimmed every frame only when over cap (`GpuWorldRenderer.js:24-25`, `:794-806`, `:1224`). GPU targets and timer queries are released on suspend/dispose.
- Relationship arrival/departure history is time/cap pruned and last sprite tiles are deleted on removal (`RelationshipState.js:28-60`, `:196-199`). Visit caches remove inactive agent IDs. Rituals, director scenes/tool events/replay, taskboard papers, arrival/departure cues, trails, particles and Agent activity trails are capped or TTL-pruned.
- Dashboard/hidden suspension releases the largest visible/volatile surfaces, GPU/PostFX resources, terrain and agent caches (`IsometricRenderer.js:1849-1871`, `:1967-1990`).

## Ranked remediations

| Rank | Remediation | Expected impact | Effort / risk | VISUAL CONSEQUENCE | Verification |
| ---: | --- | --- | --- | --- | --- |
| 1 | Split Harbor semantic history from render state. Cache a versioned packed frame snapshot on reconcile; keep only active departures and a bounded per-repo visual aggregate. Reuse it for wakes/hit tests instead of rebuilding from all ships. | **High for long sessions.** Removes the measured ~2.2 ms mean / 4.3 ms p95 at 2,000 retained ships; larger win on Canvas where enumeration is duplicated. Cuts GC tail. | Medium; semantic correctness around push/departure/hover must be pinned. | **None** if packed ships, counts, wakes and hit areas are byte-for-byte equivalent. | Add 100/500/1k/2k state benchmark; assert unchanged drawable snapshots; soak Harbor to cap and verify flat frame cost after visual-pack threshold. |
| 2 | Pre-cull agents to an expanded viewport before overlay slots, GPU overlays and label-hit rectangles; use a screen-space spatial hash for label/bubble reservations instead of growing-array scans. Keep selected/off-screen cue owners explicitly admitted. | **High in dense/off-screen scenes;** converts worst-case quadratic overlay work toward local-neighbour work. Isolated 200-agent slot layout was ~0.94 ms mean / 1.99 ms p95 before Canvas drawing. | Medium-high; overlay determinism and edge entrants need tests. | **None/low.** Labels outside the viewport disappear (already invisible); use a generous margin to prevent pop-in. | 50/100/200 clustered and dispersed fixtures; compare visible slot rectangles and screenshots; pan across edges; p95/p99 overlay segment. |
| 3 | Build/cull dynamic candidates before allocating closure-rich depth wrappers and before the global sort. Reuse per-agent/building/category drawable records; update mutable coordinates/metadata in place. | **High CPU/GC** across all worlds; scales with total entities currently discarded after sort. | Medium; preserve stable painter order and payload semantics. | **None.** Same surviving ordered stream. | Snapshot ordered stable keys/materials before/after for all scenarios; allocation profile and `sort/cull` p95; occlusion screenshots. |
| 4 | Make GPU scene packets versioned/reusable: cache atlas category decision until assets/drawable membership changes; partition records without three `filter`s; normalize in place or into object pools; preserve batches while source/revision/order is unchanged. | **Medium-high** steady CPU/GC, especially dense GPU scenes. | Medium-high; stale revisions/uploads are the main risk. | **None.** Identical records and batches. | Extend GPU policy/channel tests; assert zero uploads on unchanged frames; compare records/batches; allocation sampling and GPU-world p95. |
| 5 | Replace the FPS badge's truth source with frame health: enable a low-overhead bounded gap ring, expose p50/p95/p99/max/dropped intervals/long tasks, and surface GPU timer + quality state. Upgrade benchmark to DPR/resolution, Harbor-age, p99, input delay and Chrome FrameTimeline. | **Diagnostic-critical.** It will reveal rather than directly remove cost and prevents false “60 FPS” closure. | Low-medium; bounded typed rings keep overhead small. | **None** except a more informative tooltip/readout. | Synthetic 100 ms hitch must move p99/max/drop count while half-second FPS may remain high; compare GPU timer to DevTools trace. |
| 6 | Move semantic summary and detailed render diagnostics off the hot path. Update accessibility text on agent/selection events or 2–4 Hz; collect deep stats only when debug/perf is enabled. | **Medium** allocation reduction every frame; likely visible in GC tails more than mean FPS. | Low. | **None.** Accessibility summary remains current within event/cadence contract. | Mutation tests for agent/status/selection changes; allocation profile; verify `_lastRenderStats` consumers tolerate lightweight mode. |
| 7 | Add a resolution-aware GPU render scale/true minimal bypass after measuring. Keep overlay at native backing resolution; allow scene/postFX attachments to step down independently before DPR forces all canvases down. | **High at large resolutions** when fill/GPU queue dominates. | Medium-high; coordinate transforms and compositing need care. | **Low:** base world may be slightly coarser during pressure; text/labels remain crisp. A true postFX bypass may remove bloom/occlusion only while overloaded. | 1600×1000 DPR2 and 4K matrix; GPU p95/queue latency; pixel-diff thresholds at each rung; confirm no blinking when switching. |
| 8 | Make cold renderer progressive: instrument phases, atomically defer terrain bake/GPU promotion and off-screen agent/profile/history warmup until after first recognizable paint. | **High for first paint** if the 6.56M terrain bake or shader/upload phase is responsible; wall-time win must be measured. | Medium-high; first-paint state machine. | **None/low:** brief static Canvas shell or impostors, then an atomic upgrade; no partial terrain. | User Timing from module import through first presentation; cold-cache repetitions; screenshots/video for atomic swap; no server/asset sequencing regression. |
| 9 | Cache static wetness geometry; coarsen/threshold haze camera invalidation; cache cloud-shadow/distant-sea stamps where atmosphere buckets permit. | **Medium and weather-dependent.** Removes large conditional allocations and raster work. | Medium; cache invalidation correctness. | **None/low:** quantized haze/shadow movement must stay below perceptual threshold. | Clear/rain/fog camera-motion segment profiles and pixel diffs; verify reduced-motion static output. |
| 10 | Add a true static-idle frame policy only when reduced motion, no camera/transition/weather animation, no dirty entity/resource state, and no pending timed cue. Wake on events and a low-rate clock. | **Medium in idle worlds;** near-zero active renderer cost instead of 60 full frames/s. | Medium-high; missed wakeups are the risk. | **None** if eligibility is strict; clocks/weather may update on a low-rate cadence. | Instrument frames rendered in no-change reduced-motion fixture; event wake matrix; tab/mode/camera/weather/agent transitions. |
| 11 | Cap/coalesce biography milestone/banner state and release `_hazeField` on suspension. | **Low performance, small memory hygiene win.** | Low. | **None.** | Long synthetic milestone stream; Dashboard memory snapshot; resume rebuild check. |

## Ruled out

- **World loop continuing behind Dashboard:** ruled out. Mode changes call `setWorldModeActive(false)`, which stops rAF and suspends resources (`IsometricRenderer.js:1724-1725`, `:1849-1863`).
- **World loop continuing in a hidden tab:** ruled out. The loop itself refuses hidden documents (`:3343-3347`), and App visibility handling stops/suspends then only resumes World when appropriate (`App.js:1204-1213`).
- **Unbounded DPR quadratic growth:** ruled out. `effectiveCanvasDpr` uses a 7.5M-pixel ceiling. High-resolution fill cost remains important, but it is bounded and steps down in exact integer device-pixel rungs.
- **Shader compilation every frame:** ruled out. Programs compile/link in GPU/PostFX initialization/context restoration, not render.
- **Full atlas channel pages re-uploaded every frame:** ruled out in current code by `3862123`; current `_textureFor` revisions and dirty agent-channel updates avoid the prior steady-state upload bug. Verify `uploads/frame == 0` after warmup rather than assuming future regressions cannot recur.
- **Synchronous GPU readback in the hot path:** ruled out. No `readPixels`/`getImageData` occurs in steady GPU rendering; timer queries are polled asynchronously and capped.
- **Per-frame DOM layout reads:** ruled out. `getBoundingClientRect` is confined to pointer handlers. The semantic summary does a DOM lookup/string rebuild per frame, but not a layout measurement.
- **No viewport culling at all:** ruled out. Static props are pre-culled and the combined depth stream is culled. The problem is culling order and coverage: much simulation/layout/allocation happens before it, and several overlay paths ignore it.
- **General cache/listener leak as primary regression:** not supported. Teardown and most caps are strong. Harbor's bounded-but-large history is the much better session-age explanation; biography dedup is the only clearly unbounded renderer collection found and is low volume.
- **Constructor's 40×40 pure JS generation alone causing 20–30 s:** not supported by the ~5 ms no-op-canvas lower bound. Actual Canvas raster, shader/target setup, first-frame terrain/profile work, uploads, and serial boot await still require browser timing before responsibility can be assigned.
