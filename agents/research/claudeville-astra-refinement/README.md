# Astra refinement implementation evidence

**Status:** `ready`
**Recorded:** September 5, 2026
**Scope:** Supporting evidence for the [execution record](../../claudeville-astra-refinement-plan.md#11-execution-record--september-5-2026), against `65a4ce0` / v0.41.3.

These are selected review captures and probes, not a second golden-image suite. Maintained art goldens remain in `scripts/sprites/baselines/`. All pictured scenes use synthetic provider identities and data. The release soak observes live provider sources read-only; its retained metrics contain no session content. Screenshots were taken at different implementation checkpoints; the short final header-count change is shown separately.

## Visual review

- Material pilot: [day](material-pilot-day--webgl.png), [dusk](material-pilot-dusk--webgl.png), [rain](material-pilot-rain--webgl.png), and [Canvas day control](material-pilot-day--canvas.png). Each has a matching JSON capture/environment record. The two actors are explicitly pinned for this static art study. Emission/albedo source bytes are unchanged; the improvement is restrained material separation, not additional bloom. Character anatomical height remains flat.
- Crowds: [24 settled](dense-24-webgl-20s.png), [100 arriving](dense-100-webgl-arrival.png), [100 settled GPU](dense-100-webgl-20s.png), [100 settled Canvas](dense-100-canvas-20s.png). Matching JSON records contain body/crowd/annotation census and errors. These are separate time-based runs, not pixel-synchronized GPU/Canvas comparisons. Named-slot census at 100/20 seconds was 35 GPU and 50 Canvas; every agent remained keyboard-reachable. The later NEEDS YOU header count is demonstrated separately below.
- Selected occlusion: [GPU](selected-behind-building-night--webgl.png), [Canvas](selected-behind-building-night--canvas.png), with matching JSON. The actor is pinned behind Command; the previous unpinned gateway arrival did not test occlusion.
- Team relationships: [GPU](team-gather-relations--webgl.png), [Canvas](team-gather-relations--canvas.png), with matching JSON. Actor positions are pinned; transient message timing and decorative effects are not synchronized. A separate [controlled council readback](council-ground-readback.json) removed team membership at the same pose and changed 7,597 cue pixels and 7,511 composed-scene pixels, confirming ground cues reach the GPU scene. The final cache regression covers in-place relationship, crowd and lighting changes with reduced motion while preserving static reuse.
- Desktop UI: [1280 detail](desktop-detail-1280.png), [1280 NEEDS YOU count fit](needs-you-fit-1280.png). The count image is an early boot frame used to inspect header geometry, not settled panel content. Separate maintained-browser checks at 1280/1440/1920 preserved disclosure focus and 1,202 selected characters across refresh. Sampled composited normal text contrast was 5.28–8.60:1; this is not a whole-UI compliance certification.
- Motion: [Codex turn/pan recording](codex-turn-pan.webm), [before probe](turn-before.json), [after probe](turn-after.json). A selected Codex body initially lagged all three fast direction changes; the final 24-direction/tool sequence reported zero stale atlas poses.
- The four `dense-*-keyboard.json` records enumerate every visited session: 24/24 and 100/100 in both backends.

## Performance and correctness

[Archived HEAD profile](performance-head.jsonl) and [final profile](performance-final.jsonl) use the existing world FPS benchmark against the same machine, scenarios, viewport and settings. Baseline source was extracted with `git archive` into a temporary directory with existing dev dependencies; no branch or source files in the shared checkout were reset.

| Agents | HEAD → final frame p95 | HEAD → final resident texture MB | HEAD → final upload EMA ms |
| --- | --- | --- | --- |
| 24 | 50.4 → 42.2 ms | 99.65 → 120.75 | 0.551 → 1.343 |
| 100 | 117.1 → 66.6 ms | 117.29 → 144.27 | 3.824 → 4.349 |

Each result is a single five-second sample after three seconds of warm-up on a shared M5 Pro host. The extra authored-geometry and bounded ground-cue surfaces consume additional memory and upload time. These measurements show no unexplained frame regression in this probe; they do not establish 60 FPS or replace the long pressure soak. The JSONL files retain the environment/resource breakdowns.

[Render diagnostics](render-diagnostics.json) report successful World/Dashboard/selection/panel/deselection plus actual simulation history-write isolation. There are no console errors, page errors or failed requests. Four GPU ReadPixels stall warnings occur during screenshot capture; they are retained rather than counted as application failures or used as a benchmark.

`node scripts/smoke/astra-height-smoke.mjs` is the retained executable GPU check: authored low/zero/tall height, upward override over zero defaults, independent occlusion strength, and explicit opaque material class zero. This uses actual GPU framebuffer readback, not source-string inspection.

## Final gates

- `npm run validate:full`: 781 unit tests, both integration replays, architecture/syntax/fixture/theme/artifact checks, server smoke, building/terrain and manifest checks passed.
- One preceding full rerun hit the existing Git-worker queue test's fixed 900 ms settling deadline with one job still active. Its four tests passed in isolation and the complete rerun passed; that unrelated test and worker were left unchanged.
- `npm run verify:render`: passed after the combined changes, including real simulator spend/founding/biography persistence with unchanged live rows, channels and leases.
- `npm run sprites:audit-refresh`: 28 authoring profiles, 92 expected companion PNGs; zero channel errors/warnings.
- Twenty reviewed day/night art goldens were refreshed. Repeat `sprites:capture-fresh` + `sprites:visual-diff`: 20/20 passed, zero changed pixels. Capture FULL quality is explicitly pinned; otherwise host load can change night-lighting quality between identical poses.
- `world:verify-dpr`: five viewport/DPR combinations passed, including fractional device DPR 2.5 and 5K/6K-class desktop sizes.
- The release pressure soak (OF-006) remains open. No release metadata, commit or push was performed. The pre-existing server at port 4000 was left running; isolated servers exercised new backend modules. Restart that maintained server to load backend changes.


## v0.42.0 release verification

The [release report](release-soak.json) records the final 10-minute browser run and 30-minute server check. [Server checkpoints](release-server-checkpoints.json) retain all values needed to reproduce the server gate. The server trace used PID 93631; the final frontend ran against another fresh process with identical backend code. Initial browser attempts exposed motion-query retention, completed image callbacks, and audit artifacts; they are not counted as passes.

The final release gate passed **783 unit tests**, both integration tests and server smoke. Render diagnostics now reflect the final image-callback cleanup. The native counter and ten RSS-gate control cases pass:

```sh
node scripts/smoke/performance-soak.mjs --listener-counter-check
node scripts/smoke/performance-soak.mjs --rss-gate-check
```

Browser steady-window endpoint counts are 145 retained native listeners and 138 event-bus listeners. Its worst projected heap growth is 1.81 MB, below 8 MiB. Server event-loop p95 peaks at 24.527 ms, worst steady reconnect is 433 ms, and both RSS slopes are negative. The RSS baseline is now the exact second-half median: an isolated capacity-shrink trough had made a later rebound look like growth despite falling trends. The 64 MiB allowance, steady/trailing slope gates and other bounds remain unchanged. Regression controls reject sustained and late growth, growth with troughs, and a terminal spike.

Native sampling waits for pending Chronicle writes and takes the minimum of three bounded samples after GC. Its executable regression proves transient requests drain while a genuinely retained listener remains counted. The release also removes per-query motion listener retention and clears completed image callbacks. Separate browser probes measured 100 motion reads retaining one listener (previously 100), and 103 retained images holding zero completed load listeners.

This section supersedes the initial implementation's deferred-soak and unchanged Git-worker-test notes above. OF-006 is satisfied for this release; it remains a recurring pre-push check. The maintained port-4000 process was not restarted.
