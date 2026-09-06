# Rendering Baselines

ClaudeVille's renderer baselines are deterministic review evidence, not universal browser benchmarks. Every report records the exact Chromium build, viewport, DPR, browser zoom, GPU/driver string, OS, CPU, machine label, power-state label, and host load.

The maintained app server must already be running at `http://localhost:4000`. All captures use `?sim=1` fixtures and never read or mutate provider session data.

## Capture manifest

[`scripts/world/render-baseline-manifest.json`](../scripts/world/render-baseline-manifest.json) is the review matrix. Each entry declares:

- scenario and deterministic timeline cut;
- atmosphere, weather seed, and reduced-motion state;
- viewport, DPR, browser zoom, and camera pose source;
- expected agent population and focal subject;
- whether the frame is a north-star still or needs an overlay census.

The matrix covers the practical 1440x900 second-screen composition, 1920x1080 reference desktop, and 2560x1440 large desktop. It includes normal, dense-24, dense-100, empty, one-agent, needs-user, errored, selected-behind-building, building replay, and reduced-motion storm states. Clear noon, dusk, torchlit night, rain, and storm are represented.

Every manifest case expands to three outputs now that the GPU-resident path is available:

- `webgl`: load the GPU-resident World renderer with `?renderer=webgl`;
- `postfx`: measure the adaptive ladder, then pin FULL for the deterministic source still;
- `canvas`: load with `?renderer=canvas&postfx=0` and record the allocation-free Canvas fallback independently.

## Commands

Validate the matrix without opening a browser:

```bash
npm run world:capture-render-baselines -- --dry-run
```

Capture one review case while developing:

```bash
npm run world:capture-render-baselines -- \
  --only=north-star-clear-day \
  --profile-ms=1500 \
  --machine="workstation-name" \
  --power-state=ac
```

Run the full matrix:

```bash
npm run world:capture-render-baselines -- \
  --machine="reference-workstation" \
  --power-state=performance
```

Artifacts go to `output/render-baselines/current/` by default. Each PNG has a same-name JSON record; `capture-run.json` lists the full run. Output is review-only and is not a committed golden set unless a release task explicitly approves and relocates selected frames.

## Recorded diagnostics

Each capture records:

- requestAnimationFrame p50/p95/max;
- profiled update, render, and total p50/p95 plus render-stage segments;
- full-frame Canvas upload, water-mask upload, setup CPU, shader CPU, and GPU timings;
- adaptive PostFX level, score, driver, last degradation reason, and source-frame override;
- named GPU textures/attachments and total bytes;
- resident-GPU quality level and reason, the C3 effect-budget shed list with named modes and the shed reason, per-pass GPU/CPU timings for `upload`, `occlusion`, `scene`, `bloom`, `present` (opt-in per-pass sampling via `EXT_disjoint_timer_query_webgl2`, one pass per 12 frames in rotation, disjoint samples discarded), and pinned versus evictable texture bytes with the live body-atlas size;
- visible and cached Canvas pixels, terrain strategy, and frame failures;
- trail policy, cache space, repaint totals, high-water pixels, and per-camera-mode timing;
- a versioned approximate overlay census for requested normal/dense frames.

The census is deliberately descriptive. It freezes the current vocabulary until the scene-salience governor exposes authoritative admission counts.

## Canvas and WebGL2 effect parity

The ground-truth signals below must be present in both renderer modes. WebGL2 keeps them inside existing scene records, overlay-safe categories, or the scene-grade shader; it does not add a pass.

| Effect | Canvas path | WebGL2 path |
| --- | --- | --- |
| Building sun/contact shadows | Stepped structure shadows | One `ground:building:<id>` stepped-ellipse record per building; tower textures bake three or four fading stamps into that record |
| Coherent ground haze | Quarter-resolution haze field | One additive `ground:haze` record using the same cached field and live strength |
| Cloud shadows | Terrain-clipped cloud ellipses | Three stepped `u_cloudShadow` courses in `applyGrade`, restricted to earth, foliage, and cobble |
| Water state and night reflection | Canvas water animation and light-reflection layer | Material `8.0` ordered-dither shimmer plus the existing local-light reflection branch; reduced motion holds a fixed phase |
| Surface wetness | Material darkening plus discrete damp marks | Material weather response on authored material pixels, including terrain and water |
| Fish, waterfowl, gulls, land birds, waterfalls, and harbor traffic | Overlay-safe category in the Canvas depth stream | The same category is replayed above the GPU island |

The following decorations are intentionally Canvas-only and must not be mistaken for a missing state signal during paired review:

- the ten low-fog wisp sprites; WebGL2 carries the coherent haze field;
- discrete ground and roof damp-mark stamps; WebGL2 carries material wetness instead;
- building activity and hover ground-footprint decoration;
- the directional lighthouse beam; WebGL2 retains the lighthouse local light and water reflection;
- baked quantised cliff reflection and stepped, four-pixel dithered waterline; both are decorative composition cues, so WebGL2 intentionally omits them rather than treating them as operator signal.

## Trail camera benchmark

Persisted movement history remains available to diagnostics and replay, but routine history is not painted over the live village. Only a short recent route for the selected or action-needed agent draws directly; camera motion never allocates or repaints an ambient trail cache.

Profile the four camera modes against the same dense-100 history:

```bash
npm run world:benchmark-trails -- --duration-ms=2200
```

The benchmark fails when any camera mode allocates or repaints an ambient historical cache. It reports frame p50/p95, semantic trail draw time, cache pixels, render-stage timings, and PostFX diagnostics for stationary, manual-pan, follow, and director-glide modes.

## Review gate

Before material, atlas, or GPU-world work begins:

1. Approve the clear-day, torchlit-night, and action-needed storm north-star stills.
2. Retain WebGL, flattened PostFX, and Canvas records from the same manifest revision.
3. Record the reference hardware and power state; never publish the numbers without them.
4. Confirm the normal and dense overlay census can be compared after salience changes.
5. Confirm every camera mode reports zero ambient trail-cache pixels and repaints.
6. Keep `MAP_SIZE` at 40. `npm run world:validate-terrain` remains the authority for cache strategy and margin before any map expansion.

At the Package 0 baseline, the validator reports a 6,560,000-pixel single-surface estimate against the 7,000,000-pixel world-cache reserve: 440,000 pixels (about 6.3%) of remaining margin. The active cache plan is 3x3 chunks of 16 tiles. Re-record these figures whenever terrain geometry or the cache planner changes.
