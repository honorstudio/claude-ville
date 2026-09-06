## Territory and method

This is an enabling-infrastructure study, not an art wish list. I read the three `claudeville/src/presentation/character-mode/gpu/` modules, `WorldFrameRenderer.js`, `DrawablePass.js`, `CanvasBudget.js`, `postfx/PostFx.js`, `PostFxLadder.js`, `PostFxFeed.js`; the camera setter and profiling seams in `IsometricRenderer.js`, `Camera.js`, `App.js`, and `shared/ClientPerfMetrics.js`; `scripts/world/render-baseline-manifest.json`; and relevant sections of `scripts/smoke/world-fps-benchmark.mjs`, `performance-soak.mjs`, `agents/plans/nfs-5.md`, and `agents/plans/open-followups.md`. Orientation: `AGENTS.md`, `claudeville/CLAUDE.md`, the character/dashboard/shared READMEs, `docs/visual-experience-crafting.md`, `world-visual-qa-checklist.md`, `rendering-baselines.md`, `building-style-contract.md`, `material-channel-contract.md`, and `motion-budget.md`.

Read-only Playwright attached to the maintained HTTP server; it did not start or stop it. Chromium was independently launched using the capture helper's Metal flags. No validations, tests, formatters, runtime-source edits, or provider writes were performed. Browser-local camera, simulator atmosphere, and opt-in profiling controls were used. The only retained writes are this note and eight JPEGs.

The first four shots (`shots/performance-envelope-01.jpg` through `-04.jpg`, relative to this note) exposed a measurement trap: setting `camera.zoom` does not cancel the opening establishing glide. They are explicitly rejected as zoom-controlled measurements. The corrected four shots `shots/performance-envelope-05.jpg` through `-08.jpg` use `camera.abortDirectorGlide()`, manual input ownership, and `renderer.setCameraPose()`; every timing sample records the actual zoom. The latter are the authoritative 24/zoom1, 24/zoom3, 100/zoom1, 100/zoom3 evidence respectively. Shot 07 enables Shift-D only after profiling, so the overlay does not contaminate its measured interval.

All cases use 1920×1080 viewport, DPR 1, browser zoom 1, center tile 20,20, fixed 22:00 clear weather, live simulator evolution (not a pinned timeline), and eight five-second checkpoints over 40 seconds after pose setup. GPU values are existing asynchronous EMA timer results, not individual-frame percentiles. The app-render field is the current frame-envelope sample; the opt-in profile supplies separate CPU p50/p95. Cold start is measured from the first observable GPU renderer, not from network navigation. The 50 ms ladder observer resolves transition time only to approximately one poll interval, worse under host contention.

**Loaded-host evidence, not a hardware entitlement:** Apple M5 Pro, macOS/Darwin 25.4.0, AC attached. Other frontier explorers were capturing concurrently, as confirmed by parent coordination; exact simultaneously rendering tab count was not observable. A mid-run OS load-average sample was 101.32 / 68.30 / 35.73 (1/5/15 minutes). Therefore observed CPU and GPU latency can include contention. The first four and corrected four observer batches themselves run sequentially, never against each other. No isolated-display 120 Hz presentation claim is made.

## Current state

### Actual resident frame, not the inactive hybrid's counters

1. `WorldFrameRenderer.js:404-431` resolves scene-category support, chooses resident GPU versus hybrid PostFx exclusively, clears the upper Canvas. `:490-541` keeps sky/horizon and related Canvas work below the island and builds retained semantic ground cues. `:543-605` gathers, sorts/culls and executes the shared drawable contract. `:610-640` constructs the feed and sends records into the selected GPU backend. `:655-710` draws foreground weather, functional building marks, talk arcs, crowd counts, lifecycle annotations, category overlays, primary marks, GPU-body annotations, x-ray and bubbles on ungraded Canvas above it. These Canvas surfaces are browser-composited; the resident backend does **not** upload the whole world Canvas every frame.
2. `GpuSceneBuilder.js:1209-1268` emits static terrain, optional haze, the retained semantic ground texture, building/prop/body records, then keeps terrain first and ground below painter-sorted subjects. The retained ground slot is already shipped: do not propose it as new (`:1218-1224`; character-mode README:66). Its intended ceiling is 1024 pixels on the long edge, with 8 Hz ornamental refresh and static reduced-motion reuse (README:66).
3. `GpuWorldPolicy.js:230-273` batches only **consecutive** records with matching albedo/material/emissive/occluder source, keys and blend. Depth correctness forbids global texture sorting. Each record expands to six vertices × ten float32 values (240 bytes) in a reused staging buffer; scene and eligible occluder geometry are uploaded in one `bufferSubData` (`GpuWorldRenderer.js:30-59,1028-1075`). This is batched quads, not instancing.
4. At night FULL and REDUCED: occlusion rasterization at 0.375 linear resolution, one draw per nonempty occlusion batch (`GpuWorldRenderer.js:1146-1161`); full-resolution scene draw per stable batch into color and emission MRT (`:1254-1272`); emission downsample plus blur, two single-triangle draws at 0.375 resolution (`:1275-1294`); final full-resolution composite, one triangle (`:1296-1321`). Total draws = scene batches + eligible occlusion batches + 3 when lights/bloom are active. MINIMAL or daylight omits the occlusion geometry and bloom work: batches + 1. These are code-derived draw counts, not an intercepted GL counter.
5. Uniforms carry camera/DPR, resolution, phase grade, weather, authored sun, three cloud courses, bounded visual time, motion scale, and light position/radius/intensity/RGB arrays (`GpuWorldRenderer.js:1163-1251`). `PostFxFeed.js:666-725` reuses the feed skeleton with atmosphere references, up to 48 candidate lights, water mask/revision, sun, haze and incident pulse. The resident shader consumes its subset; an available feed field does not establish that an effect is implemented there.
6. Scene source textures use nearest sampling, revision-keyed storage, and dirty `texSubImage2D` patches where available (`GpuWorldRenderer.js:844-925`). Building/prop atlas channels use page-scoped revisions to avoid repeated full-page uploads (`GpuSceneBuilder.js:145-154`). The retained live body atlas sizes itself to roster capacity and the largest visible source cell, with stable roster slots (`:878-927`) and same-slot albedo/material/emissive/occluder updates (`:1042-1116`). Immediate salient/pose changes versus ordinary 125 ms animation refresh are already shipped (README:72).
7. The resident ladder starts MINIMAL, with 1.5 s healthy probes (`GpuWorldRenderer.js:516-525`). Its effective healthy threshold is **3 ms**, not the apparently passed `healthyMs:2`: normalization derives `budgetMs×0.75` and ignores that supplied value (`PostFxLadder.js:25-34,52-75`). Fifteen-frame median score, 1 s sustained overload, and 3 s upload grace govern transitions (`:208-223,258-329`). Resident timing selects upload + GPU time when timer data is valid, otherwise upload + submission CPU; it does not add both CPU and GPU (`GpuWorldPolicy.js:100-139`). Frame gaps above 35 ms contribute an excess-over-33-ms penalty (`PostFxLadder.js:112-120`).
8. FULL admits 32 lights; REDUCED nominally 10 with weather amplitude scaled 0.72 and lower bloom strength, **but retains both bloom draws**; MINIMAL nominally 4 with weather effects shed, no occlusion geometry or bloom. Attention protection can exceed the nominal 10/4 up to the hard 32 (`GpuWorldRenderer.js:1168-1176,1213-1227,1306-1310`; `GpuWorldPolicy.js:339-358`). A diagnostic level 3 keeps the minimal resident world and probes recovery instead of swapping composition paths (`GpuWorldRenderer.js:1330-1340`). Targets remain allocated across resident levels (`:762-785`).
9. Hybrid PostFx is a different pipeline: full Canvas source upload every active frame; FULL main + bloom extract + blur + composite, REDUCED omits blur, MINIMAL main directly to screen (`PostFx.js:896-995`). Do not cite `renderer.postFx.getDiagnostics().level` as resident quality. Resident authority is `renderer.gpuWorld.getDiagnostics()` (`GpuWorldRenderer.js:1430-1478`).

### Memory and measurements

Resource accounting estimates RGBA8 bytes, not driver heap residency or browser RSS. Two full-resolution scene attachments plus three 0.375-scale attachments coexist; color sampling is nearest, bloom attachments use linear filtering (`GpuWorldRenderer.js:781-784,1481-1497`). The 48 MiB cached-source cap is **soft for the active working set**: eviction excludes textures used this frame (`:928-949`). `CanvasBudget.js:18-32,42-55` budgets seven screen-surface equivalents, 7.5M pixels per main surface, 7M world-cache pixels and 128 MiB GPU resources; the totals are diagnostic policy, not an allocator. Expanding map size is not justified by these GPU timings: documented terrain reserve margin is only 440,000 pixels (`docs/rendering-baselines.md:110-112`).

GPU identification for every corrected case: `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)`; `HeadlessChrome/147.0.7727.15`. Actual GPU drawing surface: **1680×1026**, 1,723,680 pixels (the DOM chrome consumes the remainder of the 1920×1080 viewport).

**40-second loaded-host table.** `appRenderMs` is read from `window.__claudeVillePerf.frameHealth()` (field contract: `shared/ClientPerfMetrics.js:339-367`); GPU/level/bytes from `gpuWorld.getDiagnostics()`; `draws` is code-derived from sampled stable and occlusion batch counts as described above. Level 0=FULL, 1=REDUCED, 2=MINIMAL, 3=minimal-resident. Time is actual elapsed seconds, rounded; exact zoom matched the heading at all eight checkpoints. Texture bytes exclude vertex buffers. These are eight checkpoints, **not** a p95 population.

| Agents/zoom | t(s) | appRender ms | GPU EMA ms | Level | Records | Batches | Derived draws | Lights | Texture bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 24/1 | 5.02 | 6.50 | 2.63 | 1 | 239 | 196 | 384 | 10 | 129,621,040 |
| 24/1 | 10.02 | 4.30 | 2.80 | 1 | 239 | 195 | 382 | 10 | 129,621,040 |
| 24/1 | 15.02 | 4.70 | 6.91 | 1 | 239 | 192 | 376 | 10 | 129,621,040 |
| 24/1 | 20.03 | 4.60 | 2.79 | 1 | 239 | 195 | 383 | 10 | 129,621,040 |
| 24/1 | 25.03 | 4.00 | 2.64 | 1 | 239 | 199 | 388 | 10 | 129,621,040 |
| 24/1 | 30.04 | 4.20 | 3.73 | 0 | 239 | 199 | 388 | 32 | 129,621,040 |
| 24/1 | 35.04 | 4.40 | 4.44 | 0 | 239 | 199 | 388 | 32 | 129,621,040 |
| 24/1 | 40.04 | 4.40 | 3.32 | 0 | 239 | 199 | 388 | 32 | 129,621,040 |
| 24/3 | 5.01 | 3.40 | 2.29 | 1 | 65 | 33 | 61 | 10 | 122,538,088 |
| 24/3 | 10.01 | 3.10 | 3.52 | 1 | 71 | 34 | 63 | 10 | 122,538,088 |
| 24/3 | 15.01 | 3.30 | 3.56 | 1 | 71 | 35 | 65 | 10 | 122,538,088 |
| 24/3 | 20.01 | 4.10 | 4.25 | 1 | 71 | 39 | 72 | 10 | 122,538,088 |
| 24/3 | 25.01 | 3.30 | 2.66 | 1 | 69 | 33 | 60 | 10 | 122,538,088 |
| 24/3 | 30.02 | 3.20 | 2.39 | 1 | 69 | 33 | 60 | 10 | 122,538,088 |
| 24/3 | 35.02 | 3.70 | 2.43 | 1 | 69 | 33 | 60 | 10 | 122,538,088 |
| 24/3 | 40.02 | 3.10 | 3.48 | 1 | 69 | 33 | 60 | 10 | 122,538,088 |
| 100/1 | 5.01 | 6.70 | 5.50 | 3 | 391 | 204 | 205 | 4 | 153,141,040 |
| 100/1 | 10.03 | 6.50 | 6.20 | 3 | 391 | 209 | 210 | 4 | 153,141,040 |
| 100/1 | 15.04 | 6.40 | 6.71 | 3 | 391 | 212 | 213 | 4 | 153,141,040 |
| 100/1 | 20.05 | 6.90 | 7.60 | 3 | 391 | 214 | 215 | 4 | 153,141,040 |
| 100/1 | 25.07 | 7.00 | 6.91 | 3 | 391 | 214 | 215 | 4 | 153,141,040 |
| 100/1 | 30.08 | 6.20 | 6.35 | 3 | 391 | 209 | 210 | 4 | 153,141,040 |
| 100/1 | 35.08 | 6.30 | 3.41 | 3 | 391 | 210 | 211 | 4 | 153,141,040 |
| 100/1 | 40.10 | 7.50 | 4.19 | 2 | 391 | 209 | 210 | 4 | 153,141,040 |
| 100/3 | 5.00 | 6.60 | 8.50 | 3 | 179 | 46 | 47 | 4 | 146,058,088 |
| 100/3 | 10.02 | 6.10 | 4.03 | 3 | 183 | 47 | 48 | 4 | 146,058,088 |
| 100/3 | 15.03 | 5.50 | 3.11 | 2 | 185 | 51 | 52 | 4 | 146,058,088 |
| 100/3 | 20.05 | 5.60 | 4.33 | 2 | 185 | 53 | 54 | 4 | 146,058,088 |
| 100/3 | 25.07 | 4.90 | 2.82 | 2 | 171 | 51 | 52 | 4 | 146,058,088 |
| 100/3 | 30.08 | 5.90 | 4.33 | 2 | 175 | 53 | 54 | 4 | 146,058,088 |
| 100/3 | 35.09 | 5.10 | 3.24 | 2 | 171 | 47 | 48 | 4 | 146,058,088 |
| 100/3 | 40.11 | 5.40 | 3.07 | 2 | 175 | 44 | 45 | 4 | 146,058,088 |

**Startup/recovery:** 24/z1 first FULL at **26.40 s**, then remains FULL through the last observation. 24/z3 first FULL at **6.31 s**, but returns REDUCED at **8.05 s** and stays there to 40 s. Neither 100-agent case reaches FULL in 40 s; 100/z1 oscillates repeatedly between level 2 and level 3, which preserve the same minimal visual composition, while 100/z3 settles at level 2 after 22.97 s. The code comment's “~3 seconds” recovery is therefore not a reliable loaded-host promise. This does not prove a ladder defect or intrinsic M5 saturation.

**Final bounded profile window, not the entire 40 seconds:**

| Case | Render p50/p95 ms | Update+render p50/p95 ms | Cached sources MiB | GPU with buffers MiB | Unified estimated MiB |
|---|---|---|---:|---:|---:|
| 24/1 | 4.10 / 4.60 | 4.60 / 5.30 | 107.70 | 123.72 | 507.29 |
| 24/3 | 3.20 / 3.80 | 3.70 / 4.40 | 100.94 | 116.90 | 491.05 |
| 100/1 | 6.10 / 7.60 | 7.60 / 9.20 | 130.13 | 146.20 | 861.93 |
| 100/3 | 5.00 / 6.20 | 6.30 / 7.90 | 123.37 | 139.39 | 854.81 |

All cases retain four **2048×2048** `world-pilot` channel textures (64 MiB together). The live body atlas is four **700×700** RGBA textures at 24 agents (7.48 MiB), four **1400×1400** at 100 (29.91 MiB): +22.43 MiB before other changes. The retained terrain is **3280×2000** (25.02 MiB), terrain material **820×500** (1.56 MiB), semantic ground **1024×626** (2.45 MiB). Source sizes were read directly from `_textureEntries` after each run, not inferred from compressed files. Scene color and emission are **1680×1026**, 6,894,720 bytes each; each bloom/occlusion target is **630×384**, 967,680 bytes. Attachments total **16,692,480 bytes**, unchanged by ladder level. There are additional small prop/source textures; the aggregate table includes them.

The 100-agent resident GPU totals exceed the 128 MiB diagnostic GPU ceiling, and every sampled unified estimate exceeds its **378,217,728-byte** budget. At 100/z1 the largest reported ownership leaf is CPU-derived, **637,725,328 bytes**, versus **98,979,712 CPU-decoded bytes**. These are reported estimates, not a proven leak or process RSS; verify attribution before changing allocation policy. They are nevertheless a strong reason **not** to budget another 16 MiB companion page on the assumption the 48 MiB source cap was enforced.

### Headroom and effect-class admission

A 120 Hz frame is **8.333 ms**, a 60 Hz frame **16.667 ms**. CPU work and GPU execution can overlap; subtracting GPU EMA from measured app CPU time would be wrong. For a deliberately conservative allowance, compute each checkpoint's `C = appTotalMs + gpuMs`, then compare the median C and largest observed C with those display periods. This is a serialized upper-bound model, not a prediction of presentation latency; GPU EMA is asynchronous and browser compositing is not instrumented. Negative slack means **no budget**, not negative render time. The level groups also contain different crowd mixes and cannot be treated as a controlled FULL→MINIMAL savings test.

| Observed level group | Checkpoints | Median / largest C ms | 120 Hz slack median / worst ms | 60 Hz slack median / worst ms |
|---|---:|---|---|---|
| FULL (24 only) | 3 | 8.53 / 9.34 | -0.20 / -1.01 | 8.13 / 7.32 |
| REDUCED (24 only) | 13 | 7.42 / 12.41 | 0.91 / -4.07 | 9.24 / 4.26 |
| MINIMAL / resident3 (100 only) | 16 | 12.66 / 17.20 | -4.33 / -8.86 | 4.01 / -0.53 |

**Admission conclusion:** no sustained new-effect allowance is demonstrated at 120 Hz. At 60 Hz, 24-agent cases expose arithmetic room, but the ladder's independent ~4 ms GPU/upload envelope is already near or over budget, so even there it is not all spendable. The 100-agent worst checkpoint does not leave a conservative 60 Hz margin. Prefer work substitution and source-memory reduction; price a new effect with P1 before accepting it.

| Effect class | Feasibility within this evidence |
|---|---|
| One extra full-screen post pass | **Conditional at 60 Hz/24, not admitted at 120 or stressed100.** At this surface one RGBA target costs 6.58 MiB; a minimal one-texture read + write is 13.79 MB/frame nominal traffic, before additional taps/blending/compositor work. Engineering target: ≤0.2–0.5 ms GPU for a very simple pass, **not measured**. Current timer reports whole GPU work, so there is no defensible measured “cost of one pass”; the combined observed 2.29–8.50 ms is not that cost. |
| Quarter-linear-resolution light propagation | **Prototype only.** 420×256 RGBA target = 430,080 bytes; two ping-pong targets ≈0.82 MiB. Each propagation iteration is another pass; estimate ≤0.1–0.3 ms for a small bounded experiment, not measured. A 16th as many pixels is not guaranteed a 16th the GPU time. Preserve discrete palette and meaningful emitter input; static reduced-motion field. |
| Per-sprite normal-lit shading | **Not currently contract-ready.** Existing channels are material, emissive, occluder, with flat/albedo fallback; no normal channel (`material-channel-contract.md:109-124`). Prefer P7's authored stepped plane pilot in the existing scene pass. A new full-size RGBA companion is 16 MiB per2048² page, currently unacceptable without offsetting memory savings. |
| N additional dynamic lights | **No universal N admission.** Current FULL hard cap32 is already filled in24/z1. New attention lights should displace ambient ones, not raise the cap. Shader adds N distance tests per surviving fragment, and up to3N occlusion samples where radii overlap (`GpuWorldRenderer.js:134-150,271-287`). Need measured slope by radius/overlap, not count alone; P5 only if this becomes the blocker. |
| Additional Canvas overlay uploaded every frame | **Reject by default.** A full surface is6.89 MB/upload, ≈827 MB/s at120 Hz or414 MB/s at60 Hz before producer synchronization. Existing steady upload EMA was0.01–0.19 ms, but comes from retained/patch updates, so scaling it to a full-canvas upload is invalid. Use the existing retained cue slot and patches instead. |
| Instanced crowd bodies | **Feasible experiment, weak measured need.** Same compatible batches, fewer staged vertices; does not fix fragment light cost, texture churn, simulation or Canvas annotations. z1/100 records391 but batches≈204–214 versus z1/24 records239 but batches≈192–199: extra bodies already amortize in the atlas. Require a measured ≥0.1 ms CPU gain before keeping P6. |

### Art-director judgment of inspected evidence

- `shots/performance-envelope-05.jpg`: genuinely attractive high-contrast warm landmarks against cold water; crisp masonry and labels feel like a coherent diorama. But the unselected body crowd around Forge is physically oversized relative to the buildings, and distant group tags float over water. The broad water and terrain pattern is visually flat; buying more full-screen atmosphere is less valuable than protecting readable depth and identities.
- `shots/performance-envelope-06.jpg`: zoom3 reveals beautiful authored bridge/stone/roof detail, but 24-agent bodies become enormous foreground obstructions. This is an existing scene-reading issue, not proof that instancing or GPU lighting would help it. The centered “9 agents” badge remains more useful than additional sparkle.
- `shots/performance-envelope-07.jpg`: Shift-D confirms zoom1 and the100-agent population, and exposes the cost of diagnostic noise: checker terrain, contact boxes, reservations and labels swamp the scene. The visible **postfx n/a/0 bytes** rows are an inactive-hybrid readout, not evidence that the resident GPU has zero resources. P1 must avoid conflating backends.
- `shots/performance-envelope-08.jpg`: the100-agent closeup is paradoxically more legible in body scale because crowd bodies are smaller; “36 agents” conveys useful concentration without a percentage. Existing source art retains detail even with the minimal resident path. More unique animated channels for every body are not the obvious next investment.
- `shots/performance-envelope-01.jpg` and `-02.jpg` were also visually inspected and rejected for controlled zoom comparison because the opening glide restored nearly identical views. Captures03/04 are retained failed-pose diagnostics only; no artistic conclusion relies on them.

## Proposals

All cost figures below are **engineering admission targets/estimates, not measured implementation wins**. This research did not inject new shaders or wrap draw calls into a live renderer. A prototype must be rejected if it exceeds its stated envelope. No proposal requires WebGPU, OffscreenCanvas, a build system, a dependency, or a framework.

### P1 — Name every millisecond before buying another pass

- **Pitch:** Add opt-in per-pass timing to the existing GPU diagnostics so visual work can be admitted with evidence instead of total-frame folklore.
- **What the operator sees:** Shift-D names `scene`, `occlusion`, `bloom`, `present`, and `upload`, each with recent milliseconds, draw counts and bytes; the ordinary village is unchanged.
- **Real data it renders:** Existing `GpuWorldRenderer.gpuMs`, `uploadMs`, `qualityTimingSource`, `records`, `batches`, plus new asynchronous timer queries bracketing actual pass submission.
- **Files touched:** `gpu/GpuWorldRenderer.js:952-1023,1366-1383,1430-1478`; `WorldFrameRenderer.js:1428-1463`; existing `DebugOverlay.js` screen diagnostics integration. Paths under character-mode unless stated otherwise.
- **Sketch:**
  1. Retain the whole-frame timer as the production ladder authority.
  2. On opt-in, sample one named pass per chosen frame; never nest disjoint elapsed queries.
  3. Rotate pass ownership to avoid query churn every frame.
  4. Use fixed-capacity result rings; discard disjoint samples explicitly.
  5. Record timer availability and sampled draw/byte counters beside results.
  6. Snapshot UI at low cadence; no per-frame strings or DOM churn.
  7. Reduced motion: diagnostic numbers remain static between updates, no animation.
  8. Canvas fallback: show existing CPU segments and label GPU unavailable, never zero.
- **Cost:** S/M; target <0.05 ms CPU averaged when enabled, zero additional render pass; <64 KiB bounded query/ring bookkeeping. No generated assets. The present evidence reports only combined GPU EMA, which cannot price one new full-screen pass.
- **Risk:** Queries perturb the workload; sampling must remain opt-in and not feed an inconsistent score into the ladder. At 100 agents it must remain constant-size. Display no timing percentages.
- **Wow 1–5 / Informative 1–5:** Wow 2 — invisible infrastructure makes later ambitious effects defensible. Informative 5 — directly answers which rendering stage is expensive.

### P2 — A budget receipt for each optional effect

- **Pitch:** Extend the existing ladder with a small declared-cost admission table, not a general render graph.
- **What the operator sees:** Semantic marks remain; expensive embellishment disappears in a deliberate order, and Shift-D says which effect was shed and why.
- **Real data it renders:** `qualityLevel`, `qualityReason`, upload/GPU timing and admitted attention count; each new effect declares its measured CPU/GPU/bytes and existing semantic source.
- **Files touched:** `gpu/GpuWorldRenderer.js:1163-1272,1323-1410`; `postfx/PostFxLadder.js:208-329`; `CanvasBudget.js:42-55`; existing `DebugOverlay.js` integration.
- **Sketch:**
  1. Keep a plain constant table for the few concrete effects actually approved.
  2. Store per-level enablement, maximum dimensions, and static fallback.
  3. Register measured cost bands by backing-pixel tier, never one universal ms.
  4. Preserve the existing total-cost hysteresis; no second competing ladder.
  5. Admit no optional pass at MINIMAL by default.
  6. On reduced motion select its static representation before allocating motion resources.
  7. Canvas mode calls the existing effect fallback rather than uploading a full frame.
  8. Report active/shed counts and named reason only in diagnostics.
- **Cost:** S/M; target <0.02 ms CPU/frame, no new GPU pass or texture by itself, <8 KiB metadata. No assets. Justification: REDUCED currently reduces intensity/light count but still pays both bloom passes; levels are not equal slices of free time.
- **Risk:** A registry without actual consumers is needless abstraction: land with the first accepted effect only. Protected attention can exhaust the nominal light budget, so do not spend a presumed 28-light MINIMAL saving. At 100 agents all optional effects share one bounded budget.
- **Wow 1–5 / Informative 1–5:** Wow 3 — richer scenes can degrade without looking broken. Informative 4 — operators retain truthful priority signals under pressure.

### P3 — Patch semantic ground instead of repainting its whole envelope

- **Pitch:** Extend the already-shipped retained ground texture with dirty-region uploads only if cue churn proves material.
- **What the operator sees:** Selected routes and truthful relationship marks remain behind buildings without becoming less responsive when one agent changes direction.
- **Real data it renders:** Existing `villageSnapshot`, relationship/crowd route state and sprite positions consumed by `drawGroundSemantics`; `_semanticGroundRevision` and texture update byte counts.
- **Files touched:** `WorldFrameRenderer.js:529-539` and its `prepareSemanticGround` seam; `gpu/GpuSceneBuilder.js:1218-1224`; `gpu/GpuWorldRenderer.js:869-904` existing patch uploader.
- **Sketch:**
  1. Do not add a second full-screen cue texture by default.
  2. Retain previous cue bounds and union old/new dirty rectangles.
  3. Redraw intersecting semantic marks into bounded region canvases.
  4. Attach the already-supported `textureUpdates` list to the ground record.
  5. Camera/scale changes invalidate the whole retained surface once.
  6. Keep immediate primary state changes and the existing 8 Hz ornament cap.
  7. Reduced motion reuses static cue frames until semantic change.
  8. Canvas fallback draws the same ground routine directly; no added texture.
- **Cost:** M; target <0.1 ms CPU for dirty-region bookkeeping, no added shader pass; bounded patch scratch ≤ existing retained cue texture size. No assets. Savings are conditional: the existing long-edge cap is much cheaper than another full-resolution upload.
- **Risk:** Overlapping alpha marks require redraw of all intersecting content, not naive pixel erasure; crowded all-moving cues can make full redraw cheaper. Choose full versus patch by dirty pixel count, and preserve painter order.
- **Wow 1–5 / Informative 1–5:** Wow 3 — depth-correct routes stay fluid during bursts. Informative 4 — frees budget without removing relationships or selection.

### P4 — Atlas admission priced by active channels, not PNG size

- **Pitch:** Make proposed sheet/sidecar additions disclose their actual resident working-set cost before asset production.
- **What the operator sees:** The same crisp village, with Shift-D naming atlas pages, live body atlas dimensions, active bytes and genuinely evictable bytes rather than one misleading cap.
- **Real data it renders:** `_textureEntries` width/height/lastUsedFrame; `cachedTextureBytes`, `textureEvictions`; live agent atlas dimensions and authored channel presence.
- **Files touched:** `gpu/GpuWorldRenderer.js:844-949,1481-1497`; `gpu/GpuSceneBuilder.js:878-927,1128-1171`; `CanvasBudget.js:142-159`; `scripts/world/render-baseline-manifest.json:1-13` as evidence metadata seam.
- **Sketch:**
  1. Count each uploaded channel once using actual texture dimensions.
  2. Separate current-frame pinned bytes from idle evictable bytes.
  3. Show soft-cache overage and total GPU budget separately.
  4. Price four 2048² RGBA channels as 64 MiB, even if compressed PNGs are tiny.
  5. Before broadening an atlas, compare page upload against visible individual sources.
  6. Reuse existing category admission rather than force every asset into the atlas.
  7. Reduced motion retains the same accounting and stops unused animation updates.
  8. Canvas fallback counts decoded/derived ownership separately, not as GPU bytes.
- **Cost:** S/M; snapshots only, target <0.1 ms per diagnostic refresh, no per-frame GPU work, <16 KiB metadata. No asset generation for accounting; later rebakes only after measured admission.
- **Risk:** Do not “fix” a soft cap by evicting textures needed this frame, which causes upload thrash. A 100-agent roster can enlarge every channel even when only some bodies are visible. Memory accounting remains estimated, not browser RSS.
- **Wow 1–5 / Informative 1–5:** Wow 2 — asset ambition becomes sustainable. Informative 5 — answers exactly why one extra sidecar or atlas page is expensive.

### P5 — A bounded light-cell lookup before increasing light count

- **Pitch:** Prototype a small screen-cell light index only when new truthful lights exceed the existing per-fragment loop envelope.
- **What the operator sees:** Simultaneous real work/attention emitters can illuminate their neighborhoods without making distant pixels test every lamp.
- **Real data it renders:** `feed.lights[].x/y/radius/intensity/r/g/b/priority/attention`, already admitted by `clampGpuLights`; never decorative fabricated activity.
- **Files touched:** `postfx/PostFxFeed.js:706-724`; `gpu/GpuWorldPolicy.js:304-358`; `gpu/GpuWorldRenderer.js:271-287,1213-1251`.
- **Sketch:**
  1. Keep global attention-first admission and hard maximum 32 initially.
  2. At light/pose revision, bin admitted circle bounds into a small fixed grid.
  3. Store bounded light indices, not baked smooth illumination.
  4. Shader tests only the cell list, preserving existing stepped material output.
  5. Overflow cells use the original list, never silently drop attention.
  6. Benchmark against the current radius-reject loop before accepting complexity.
  7. Reduced motion uses unchanged static cell lists; no new pulse or propagation timer.
  8. Canvas keeps the existing light registry and bounded stamps.
- **Cost:** M; hypothesis target <0.15 ms CPU/rebuild and <0.1 ms GPU lookup overhead, 16×9×8 one-byte indices plus counts (roughly 1.3 KiB; texture packing may round upward). No new art or full-screen pass. Existing shader performs one distance reject per light and three occlusion samples per in-radius light; the measured total GPU timer is not a per-light slope.
- **Risk:** Light motion/camera motion can erase CPU savings; eight lights per cell is a prototype parameter, not an artistic cap. Do not use uniform arrays without checking fragment uniform capacity. Crowded primary lights must stay protected. This is conditional, not a prerequisite for every lighting proposal.
- **Wow 1–5 / Informative 1–5:** Wow 4 — enables concurrent meaningful pools of light. Informative 4 — preserves local source identity rather than an indiscriminate wash.

### P6 — Instance only consecutive compatible bodies

- **Pitch:** Trial instanced quad submission behind the existing stable batches, not a second crowd renderer.
- **What the operator sees:** Exactly the same body depth, identity and selection at 100 agents, with less repeated vertex staging.
- **Real data it renders:** Existing normalized GPU record x/y/width/height, atlas UV rectangle, material/elevation/emissive/occluder and gate values.
- **Files touched:** `gpu/GpuWorldPolicy.js:230-273`; `gpu/GpuWorldRenderer.js:30-59,1028-1075,1089-1143`; `DrawablePass.js:77-100` preserved contract.
- **Sketch:**
  1. Keep the existing sorted records and batch boundaries unchanged.
  2. Share a six-vertex unit quad; stage one record of instance attributes.
  3. Use `vertexAttribDivisor` and `drawArraysInstanced` only for compatible runs.
  4. Preserve separate scene and occluder admission, authored zero heights and alpha.
  5. Compare CPU staging and buffer bytes using P1 before retaining the prototype.
  6. If records are fragmented by scenery, accept that draw-call count will not fall.
  7. Reduced motion changes no geometry contract; no animation state is added.
  8. Canvas fallback and hit-testing stay unchanged.
- **Cost:** M; expected GPU saving small at 100 agents, CPU target saving must exceed 0.1 ms/frame to justify maintenance; instance data estimate 64–80 bytes versus 240 bytes per current quad, small tens of KiB total. No assets. This is a conditional experiment, not an assumed performance fix.
- **Risk:** Instancing does not reduce texture changes or per-fragment lights and cannot batch through intervening buildings. Enlarging scope into all animated systems is rejected. Crowd bodies are already shared-atlas batched, so wins may be too small.
- **Wow 1–5 / Informative 1–5:** Wow 2 — indirect headroom rather than spectacle. Informative 3 — keeps full semantic identity rather than paying for performance by removing entities.

### P7 — A stepped face-orientation channel pilot, not normal-map PBR

- **Pitch:** Define an optional tiny face-orientation vocabulary before anyone generates normal-lit sheets.
- **What the operator sees:** An approved sprite's authored roof and side planes can respond coherently to existing light direction while keeping discrete palette bands.
- **Real data it renders:** Authored face orientation plus existing `feed.lighting.sunDirIso`, local light records and material ID; geometry metadata, not invented session mood.
- **Files touched:** `docs/material-channel-contract.md:109-124` contract extension; `gpu/GpuSceneBuilder.js:80-111,1042-1116`; `gpu/GpuWorldRenderer.js:189-202,237-259`. Existing packing must be reviewed before using any nominally reserved byte.
- **Sketch:**
  1. Start with one approved landmark, not all agent sheets.
  2. Define flat/default and a few authored face classes, not continuous normal vectors.
  3. Preserve albedo as authority and the upper-left key convention.
  4. Audit raw versus runtime-packed material bytes before selecting storage.
  5. Quantize light response to approved palette bands in the existing scene pass.
  6. Absence retains exactly today's material-wide response.
  7. Reduced motion uses the same static lighting snapshot; no new time-varying effect.
  8. Canvas falls back to authored albedo, with no new full-sheet per-frame composition.
- **Cost:** M/L including contract/tooling review; shader target <0.2 ms for a small visible pilot, not a promise for a full atlas. Zero extra resident bytes only if a genuinely unused packed byte can be safely assigned; otherwise a 2048² RGBA companion costs 16 MiB and must pass P4. Asset authoring yes: reviewed discrete plane masks, no bulk generative normal maps.
- **Risk:** Material G/B are reserved in raw channels but runtime packing already has material/emission/height semantics, so casually reusing G is wrong. Continuous normals and smooth highlights violate the art contract. At 100 agents remain albedo-only unless measured benefit warrants channel growth.
- **Wow 1–5 / Informative 1–5:** Wow 4 — geometric coherence is a new capability rather than more particles. Informative 3 — improves reading physical depth but must not masquerade as a new operational signal.

## Top three

1. **Name every millisecond before buying another pass.** The real frontier is no longer whether WebGL can show an effect; it is whether anyone can price it. Combined GPU EMA cannot distinguish a cheap full-screen copy from costly overlap lighting. A small opt-in pass sampler prevents every visual idea from buying the same “spare” milliseconds twice.

2. **A budget receipt for each optional effect.** The village already has multiple graceful fallbacks, but intensity reduction is not necessarily work reduction. A tiny table attached to actual new effects makes the artistic hierarchy explicit and keeps attention truthful under load without inventing a generic engine.

3. **Atlas admission priced by active channels, not PNG size.** Pixel-art source files look tiny while expanded channel pages are large. The active-working-set exception means a nominal 48 MiB cap is not a safe production allowance. Precise attribution protects both rich new assets and startup quality from upload churn.

## Rejected

- **WebGPU now:** no attachment/batching limit was demonstrated as the blocker; OF-008 remains conditional (`agents/plans/open-followups.md:106-114`).
- **OffscreenCanvas now:** a heavily contended shared-host run does not isolate transferable renderer main-thread contention; OF-007 remains conditional (`open-followups.md:96-104`).
- **A second full-resolution Canvas overlay uploaded each frame:** recreates a producer/upload tax avoided by the resident path; dirty retained cues are the narrower seam.
- **“Add another ground texture” as a new feature:** the existing retained semantic texture already carries this role (`GpuSceneBuilder.js:1218-1224`).
- **Global sorting by atlas for one draw call:** violates painter-order interleaving (`GpuWorldPolicy.js:230-243`).
- **100 dynamic lamps for 100 agents:** presence/working status does not justify one light per resident, and the shader hard maximum is 32 (`GpuWorldRenderer.js:19,271-287`).
- **Quarter-resolution propagation by default:** iterations imply extra passes and an ambiguous smooth light field; an index grid that preserves actual emitters is the more conservative first experiment.
- **Bulk normal-map generation:** no current normal channel contract; would amplify memory and undermine the authored upper-left key (`docs/material-channel-contract.md:68-69,109-124`).
- **A distant decoration layer to spend spare GPU time:** no operator question answered; the rejected distant-shore precedent is binding.

## Open questions for the coordinator

- Obtain an isolated foreground run at native DPR on the intended 60 Hz and 120 Hz operator displays before turning the headroom arithmetic into admission guarantees. This run deliberately reports shared-host evidence.
- Per-pass GPU elapsed time and a per-light cost slope are not exposed by current read-only diagnostics. P1 is needed before assigning trustworthy milliseconds to another full-screen pass or N lights.
- Browser-driver/native compositor memory is not the RGBA accounting total. Long-lifetime plateau evidence still belongs to the existing soak, which this research was forbidden to run (`scripts/smoke/performance-soak.mjs:8-18,53-55`).
- Which specific semantic art proposal needs an additional channel/pass? P2/P5/P6 must not land as unused speculative infrastructure.
- Confirm discrete plane metadata offers enough visual benefit over the current authored bands before expanding material contracts; unreviewed albedo-derived normals are not acceptable.
