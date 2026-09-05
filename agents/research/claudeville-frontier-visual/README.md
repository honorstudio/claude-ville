# ClaudeVille frontier visual research

**Status:** `ready`

**As of:** 2026-09-05, `main` at `35ef417` (`v0.44.0` *The Slatekeeper*), clean tree, maintained server on `http://localhost:4000`.

Ten independent, read-only explorations of "what would make ClaudeVille visually more amazing while making it more truthful", run in parallel by a Fable 5.1 coordinator over Astra (nine) and Sol (one) explorers. Every note carries `file:line` anchors it read in this checkout and real-GPU captures it visually inspected. The consolidated result is [`../../plans/claudeville-frontier-visual-plan.md`](../../plans/claudeville-frontier-visual-plan.md).

## Notes

| Note | Territory | Top three (explorer's ranking) |
| --- | --- | --- |
| [`light-and-atmosphere.md`](light-and-atmosphere.md) | sky, clock, weather, grade, lights, PostFx, resident GPU lighting, ladder | window light that reaches the street · rain borrows the lantern's color · one dusk exposure contract |
| [`character-life.md`](character-life.md) | sheets, poses, rituals, identity at three distances, lifecycle | hands that actually do the work · a hundred stable signatures · working set as carried folios |
| [`living-buildings-and-terrain.md`](living-buildings-and-terrain.md) | buildings, scenery, harbor, lanterns, monuments, empty state | open the workshop · Mine assay bench · a truthful sleeping town |
| [`signal-to-visual-mapping.md`](signal-to-visual-mapping.md) | payload/event inventory vs World consumers; un-embodied signals | last-observed seal · Mine assay ledger · turn sand |
| [`camera-and-cinematography.md`](camera-and-cinematography.md) | camera state machine, Director, letterbox, replay, mode transition | complete attention frame · working-village broadcast · Chronicle contact sheet |
| [`chrome-and-dom-instrument.md`](chrome-and-dom-instrument.md) | TopBar, Sidebar, Activity Panel, Dashboard, typography, DOM/canvas boundary | working-set bench · true portrait crop · observation tape |
| [`effects-particles-and-audio-sync.md`](effects-particles-and-audio-sync.md) | particles, transient marks, council ring, weather foreground, audio cues/BGM | shared cue score · one event one instrument · BGM working section |
| [`outside-eye-and-state-of-the-art.md`](outside-eye-and-state-of-the-art.md) | product/taste review, 2025–2026 technique survey with citations, reference games | work as a spatial score · threshold theatre · hold to read the village |
| [`performance-envelope.md`](performance-envelope.md) | resident GPU frame structure, measured 24/100-agent budgets, memory, admission classes | per-pass timing · effect budget receipt · atlas admission by active channels |
| [`asset-pipeline-and-pixellab.md`](asset-pipeline-and-pixellab.md) | manifest inventory, companions, atlases, PixelLab capabilities and generation arithmetic | real reading hands · held approval pose · six-piece interior kit |

## Captures

`shots/<slug>-NN.jpg` are 1920×1080 JPEGs from headless Chromium on `ANGLE Metal Renderer: Apple M5 Pro`, taken with [`tools/capture.mjs`](tools/capture.mjs) against the maintained server, read-only. `shots/00-probe-*.jpg` are the coordinator's helper smoke tests. Explorers ran concurrently on one host; ladder levels and FPS visible in stills are **loaded-host evidence**, not benchmarks. The helper's first version reported null `hour`/quality and did not switch to Dashboard; notes say which captures predate the fix.

### Capture helper

```bash
node agents/research/claudeville-frontier-visual/tools/capture.mjs \
  --scenario dense-24-agents --hour 22 --weather clear --zoom 2 --center 20,20 \
  --wait 15000 --select sim-user-bell --out agents/research/claudeville-frontier-visual/shots/x.jpg
# --mode dashboard | --live | --eval "<js>"; prints webglRenderer, worldRendererMode, qualityLevel, qualityReason, hour, weather
```

It requires Playwright from the existing dev dependencies and never starts, stops, or owns the server. Explicit `--center`/`--zoom` abort the opening Director glide via `renderer.setCameraPose`.

## Measured facts worth remembering

From [`performance-envelope.md`](performance-envelope.md), loaded host, 1680×1026 GPU surface, 22:00 clear:

- 24 agents zoom 1: appRender 4.0–6.5 ms, GPU EMA 2.6–6.9 ms, FULL first reached at 26.4 s; 32 lights admitted at FULL.
- 100 agents: never FULL in 40 s; MINIMAL/resident-3; appRender 6.1–7.5 ms, GPU 3.4–8.5 ms.
- Resident texture bytes 122–153 MiB; `world-pilot` atlas alone is four 2048² channels = 64 MiB; live body atlas grows 7.5 → 29.9 MiB from 24 to 100 agents.
- Serialized upper bound `appRender + gpu` leaves **no** 120 Hz slack at FULL and about 8 ms at 60 Hz for 24 agents; nothing at 100 agents. New effects must substitute or be priced first.

From [`asset-pipeline-and-pixellab.md`](asset-pipeline-and-pixellab.md): 24 character sheets, all 736×920 (walk + breathing-idle only, no authored work/wait/read rows); one 4-frame custom animation across the roster = 192 generations; 64 px portraits = 20 generations each. PixelLab MCP calls returned `401 Missing Authorization` during this round because the harness mounts the server without a bearer header; the coordinator verified REST access afterwards with the `.dev.vars` token: `GET /v2/balance` → Tier 1: Pixel Apprentice, 1,403 / 2,000 generations remaining, resets Sep 9.

From [`signal-to-visual-mapping.md`](signal-to-visual-mapping.md): `freshness`, `signalStale`, `turnStartedAt`, `lastTurnDurationMs`, `cost.{source,rateMatch,unknownModel}`, `workingSet`, `collisions`, `waitReason`, `modelHistory` reach the client (or the adapter) and have **no** World embodiment; OMP, the dominant live provider on this machine, has no `workingSet` producer.
