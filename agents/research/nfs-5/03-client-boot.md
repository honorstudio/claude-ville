# Client boot critical-path investigation

Status: ready — read-only source investigation; 2026-09-01

## Executive summary

- The normal browser boot is **141 JS modules / 3,634,287 bytes**, not 160: 160 counts 17 Node/server files; `src/` contains 143 modules and the two simulator fixtures are absent from a normal boot.
- Before `App` can execute, its eager graph is **81 modules / 1,233,381 bytes**, with **7 module levels (6 dependency edges)** on the longest discovery chain.
- Boot then waits for API source sync, every base sprite, every requested material asset, a 57-new-module world import, and an unnecessary 3-new-module dashboard import, in that order.
- The static handler has **no ETag, no Last-Modified, and no conditional-request handling**; every `no-cache` resource revalidates as a full `200` body.
- A scoped warm normal reload therefore transfers at least **3,936,220 bytes in 154 requests**; validators retain 154 requests but reduce unchanged bodies to zero (304), while preserving immediate edit pickup.
- TCP churn is not the cause: `http.createServer()` retains Node's HTTP/1.1 keep-alive defaults (5 s idle timeout, unlimited requests/socket) and static responses do not send `Connection: close`.
- The HTML shell can paint early, and agent rows can populate after source sync, but the first world frame is absolutely gated behind full base + default material asset completion.
- Highest-value changes are validators, overlapping independent boot work, preloading the world module graph, progressive asset readiness, and deferring hidden feature graphs.
- No bundler, transpiler, generated bundle, or build step is needed or recommended.

## Measurement method and denominator

I created `/tmp/claudeville-module-graph.mjs` (throwaway, outside the repository). It walks `claudeville/src/**/*.js`, extracts local static `import`/re-export edges and literal dynamic imports, resolves relative paths, computes reachability, runs Tarjan SCC detection, and computes the longest path over the SCC DAG. It found 437 unique local static edges, matching the supplied edge count. Counts below use source bytes on disk; LOC are physical `wc -l` values or set totals adjusted to that convention.

The supplied `160 modules / 104,238 lines` is the count for **all** JavaScript under `claudeville/`. It includes `server.js`, adapters, and services that the browser never imports. The client source denominator is:

| Set | Modules | Bytes | Physical LOC | Notes |
| --- | ---: | ---: | ---: | --- |
| Entire `claudeville/src` | 143 | 3,682,388 | 88,309 | 437 unique local static edges |
| Initial static closure from `App.js` | 81 | 1,233,381 | 30,958 | Must fetch/evaluate before `App` can run |
| World renderer static closure | 83 | 2,732,616 | 64,370 | 57 modules / 2,340,398 bytes are new after initial closure |
| Dashboard renderer static closure | 25 | 302,266 | 7,514 | Only 3 modules / 60,508 bytes are new after the world path |
| Normal boot union | **141** | **3,634,287** | **86,870** | Initial + unconditional world + unconditional dashboard |
| Simulator-only source | 2 | 48,101 | 1,439 | `AgentSimulator.js` + `WorldScenarios.js`; only under `?sim=1` |

There are no cycles in the initial `App.js` closure. The world closure has one two-module SCC (`AgentSprite.js` ↔ `AgentGpuOverlayRenderer.js`); SCC condensation prevents a cycle from inflating depth.

## Measured module-graph shape

### Initial graph: before any application code can boot

Maximum depth is **7 module response levels / 6 import edges after `App.js`**. If navigation-to-entry discovery is counted, HTML adds one earlier response stage.

```text
presentation/App.js
└─ presentation/shared/TopBar.js
   └─ presentation/shared/AmbientAudioController.js
      └─ presentation/shared/audio/AudioDirector.js
         └─ presentation/shared/audio/cues/CueKit.js
            └─ domain/services/SignalLedger.js
               └─ domain/value-objects/AgentStatus.js
```

This chain is especially actionable: audio is not needed for the first visual frame, yet it defines the deepest initial dependency waterfall. `TopBar.js` constructs `AmbientAudioController` immediately. Removing the static audio edge would shorten and shrink the initial graph rather than merely accelerating it.

Largest eager roots and unique initial cost if their `App.js` edge is removed (shared dependencies excluded):

| Eager root | Unique modules | Unique bytes | Unique LOC | First-paint necessity |
| --- | ---: | ---: | ---: | --- |
| `TopBar.js` | 20 | 287,200 | ~7,226 | Top bar is needed; its audio subtree is not. Splitting audio away shifts about 222,823 bytes / ~5,775 LOC out of the initial closure. |
| `ActivityPanel.js` | 6 | 249,958 | ~6,098 | Not needed; panel is hidden and is only constructed after both renderers. The file alone is 153,543 bytes / 3,629 LOC. |
| `AssetManager.js` | 1 | 62,358 | 1,506 | Needed for the current world path, not for shell/sidebar and not for a future dashboard-first path. |
| `ClientPerfMetrics.js` | 1 | 31,139 | 838 | Instrumentation object is created at foundation; much of it is dormant until enabled, but renderer helpers also import it. Split only after preserving telemetry contracts. |
| `ChroniclePanel.js` | 1 | 22,647 | 588 | Hidden modal UI; collection (`ChronicleLog`) can remain eager while presentation loads on click. |
| `Modal.js` | 1 | 5,666 | 156 | Hidden; used by settings/changelog and renderer interactions, so defer behind a stable modal facade rather than removing blindly. |

### Late graphs on the actual boot path

The only dynamic imports are the simulator, world renderer, and dashboard renderer. Dynamic syntax does not make the last two lazy in behavior because boot calls them unconditionally and serially.

- `IsometricRenderer.js`: raw closure depth **6 levels / 5 edges**. With the initial graph cached, it still adds **57 requests, 2,340,398 bytes, 54,559 physical LOC**, and six discovery levels. Its incremental critical chain is:

```text
IsometricRenderer.js
└─ WorldFrameRenderer.js
   └─ SceneCategoryRegistry.js
      └─ HarborTraffic.js
         └─ ParticleSystem.js
            └─ MarkGovernor.js
```

- `DashboardRenderer.js`: after the world graph it adds only **3 requests, 60,508 bytes, 1,353 LOC** (`DashboardRenderer.js`, `DashboardKeyboardNavigation.js`, `SemanticTriage.js`) with **2 incremental levels / 1 edge**. It is nevertheless wasted work before a world-first paint.
- Simulator: `AgentSimulator.js` imports `WorldScenarios.js` only after `?sim=1`; `WorldScenarios.js` (34,306 bytes / 1,074 LOC) **does not ship on normal boot**. This candidate is already correctly lazy.

## Caching and HTTP delivery findings

### Source-proven behavior

`cacheControlFor()` returns one-year immutable caching only for versioned fonts or files under the sprite root. Everything else receives `Cache-Control: no-cache`. In `serveContainedFile()` the server:

1. stats the target;
2. reads the entire file with `fs.readFile()`;
3. always calls `writeHead(200)` with only `Content-Type` and `Cache-Control`;
4. ends with the full body.

There is no `ETag`, `Last-Modified`, `If-None-Match`, `If-Modified-Since`, or 304 path anywhere in the server. There is also no static content compression (`Content-Encoding`) path. `no-cache` permits storage but requires reuse to be validated; with no validator, validation can only return the full body.

### Warm-reload quantity

This is a conservative scoped lower bound for unchanged normal boot, excluding favicon/PWA icon requests and optional/missing sprite probes:

| Resource set | Requests returning 200 today | Body bytes today | With validators, unchanged |
| --- | ---: | ---: | ---: |
| HTML | 1 | 19,089 | 1 × 304, 0 body |
| Eight CSS files | 8 | 123,888 | 8 × 304, 0 body |
| `js-yaml.min.js` | 1 | 43,549 | 1 × 304, 0 body |
| Normal JS module union | 141 | 3,634,287 | 141 × 304, 0 body |
| Manifest + palettes YAML | 2 | 92,911 | 2 × 304, 0 body |
| Unversioned Departure Mono font | 1 | 22,496 | 1 × 304, 0 body |
| **Scoped total** | **154** | **3,936,220** | **154 conditional requests, 0 body bytes** |

The versioned Press Start font and versioned sprite/atlas URLs already use immutable caching and should produce **no warm network requests**. On disk, sprite delivery is 239 PNGs / 7,772,808 bytes plus two YAML files and a 273,064-byte atlas JSON (8,138,783 bytes total across 242 files). Cold boot currently gates on the applicable set; warm boot should reuse versioned PNG/atlas responses. The separate asset-pipeline investigation should own any mismatch between on-disk files and runtime optional probes.

Validators do not remove the 154 HTTP requests or the ESM dependency-level RTTs; they remove response bodies and preserve cached representations. `modulepreload`/sequencing is still required to flatten discovery. As a secondary optimization, individual gzip of the normal JS set is about **890 KB versus 3.63 MB raw**; HTML + CSS + YAML library compress to about another 46 KB. On-the-fly HTTP compression is compatible with zero-build, but localhost transfer bandwidth is lower priority than 304s and dependency scheduling.

### Recommended cache policy

- Keep `Cache-Control: no-cache` for editable HTML, JS, CSS, YAML, the vendored library, and unversioned fonts.
- Emit both `ETag` and `Last-Modified`; honor `If-None-Match` first, then `If-Modified-Since`, returning 304 without a body.
- Safest strong validator: content hash, cached by canonical path plus `{size, mtimeNs}` so unchanged revalidations can use stat only. A raw `{mtime,size}` tag should be weak (`W/`) because metadata is not a proof of byte identity. A nanosecond-mtime weak ETag is still adequate for local edit invalidation if hashing complexity is undesirable.
- Retain the current `public, max-age=31536000, immutable` rule for versioned sprite/font URLs. Add `?v=` to Departure Mono or let it use validators.
- Include `Vary: Accept-Encoding` if compression is added.

This preserves the zero-build edit loop: save a file, its stat/hash changes immediately, and only that URL returns 200 on reload.

### Keep-alive

The static server is created with plain `http.createServer()` and does not override socket settings. On the inspected Node runtime the defaults are `keepAliveTimeout=5000`, `maxRequestsPerSocket=0`, `headersTimeout=60000`. Static responses do not set `Connection: close`; the one such literal in `server.js` belongs to a raw WebSocket rejection path, not static serving. Browsers can therefore reuse their HTTP/1.1 connection pool. After the separate event-loop stall is fixed, dependency waves on localhost should fit comfortably inside the 5-second idle window. Connection churn is ruled out as the primary remaining mechanism.

I attempted the requested `curl -w` samples eight times against both `localhost:4000` and `127.0.0.1:4000`. Every attempt failed immediately with HTTP code `000` and connect time below 0.4 ms because no listener was present. I did not start, restart, or kill the maintained server. Header conclusions above are source-proven; live header/timing confirmation remains a verification step.

## Boot-gating findings

### Exact current sequence

```text
HTML navigation
├─ 8 render-blocking CSS files (parallel discovery)
├─ synchronous head js-yaml (blocks body parsing)
└─ App module + 80 eager dependencies
   └─ window "load" event (App does not start before it)
      └─ stamp shell/status → intentionally await one rAF (placeholder can paint)
         └─ synchronous foundation construction
            └─ await providers API
               └─ await sessions + teams APIs
                  └─ await manifest + palettes
                     └─ await every base entry image/decode/mask
                        └─ await material sidecars + atlas metadata/channels
                           └─ import/evaluate 57 new world modules
                              └─ construct/show renderer; first loop requests rAF
                                 └─ import/evaluate 3 new dashboard modules
                                    └─ construct hidden ActivityPanel; finish boot
```

The shell is not inherently gated on assets: static top bar/sidebar/canvas/empty-state HTML exists, and `_bootOnce()` explicitly renders status then yields one animation frame. However, that code does not begin until `window.load`, after the 81-module initial graph and head resources. The synchronous YAML library sits before `<body>`, so it blocks even parsing the shell.

The agent list is also not inherently asset-gated. `Sidebar` and its event subscriptions are constructed before `_syncVillageSources()`. Session ingestion adds agents to `World` before asset loading starts, so the sidebar can update and paint during subsequent image/network yields. The **canvas world** cannot paint today until full assets and renderer import/init complete.

### Required versus accidental waits

| Wait | Required for first meaningful world? | Finding |
| --- | --- | --- |
| One initial `requestAnimationFrame` | Yes for guaranteed placeholder paint | Deliberate and useful; keep it. |
| Providers before sessions/teams | No | Independent API reads are serialized at `App.js:493-495`; launch together with `Promise.all`, preserving reducer ordering/error semantics when results commit. Sessions and teams are already parallel inside `AgentManager`. |
| Source sync before any asset work | No | Data and assets are independent. Start source sync, manifest/base loading, and world module fetch concurrently after foundation. Join only what renderer construction actually needs. |
| Full base asset set | Required only by current all-or-nothing `AssetManager` contract | It loads all flattened entries with `Promise.all`. A first-frame readiness tier is needed to render shell/current agents/terrain before optional/off-screen art completes. |
| Materials after every base asset | No for an albedo-first frame in principle | Material companions are documented as optional/fallback-capable, but current `loadMaterialAssets()` internally waits for decoded base readiness. Progressive upload needs an explicit AssetManager/renderer contract; otherwise visual pops or stale GPU resources are possible. |
| Renderer module fetch after assets | No | The module graph is independent of PNG decoding. Start `import('./character-mode/IsometricRenderer.js')` immediately or modulepreload it, then instantiate only when minimum assets and world data are ready. |
| Dashboard import/init before world boot completes | No | Default mode is always `character`; there is currently no dashboard-first boot. Load on first dashboard click. |
| Activity panel construction before boot completion | No | Hidden until selection/deep link; load after first paint or on first selection/hash. |

The safest progressive target is: paint the DOM shell immediately; populate sidebar agents as soon as sessions arrive; fetch/compile the world graph and assets concurrently; mount an albedo/essential-assets world; then fill optional sprites/materials and hidden UI. Missing asset readiness must have deterministic placeholders and a repaint/upload signal—do not expose partially mutating maps without that contract.

## Render-blocking CSS and YAML

All eight CSS links are classic render-blocking stylesheets. They have no `@import` chains and are adjacent in the head, so discovery is parallel rather than an eight-level waterfall. Total cost is 123,888 bytes / 4,700 LOC.

For the default world first paint, `reset.css`, `layout.css`, `topbar.css`, `sidebar.css`, and `character.css` are needed. These three hidden-feature sheets are not:

| Deferrable stylesheet | Bytes | LOC | Activation |
| --- | ---: | ---: | --- |
| `dashboard.css` | 31,074 | 1,017 | First Dashboard selection |
| `modal.css` | 10,188 | 441 | First settings/changelog/other modal |
| `activity-panel.css` | 31,642 | 1,318 | First agent detail/deep link |
| **Total** | **72,904** | **2,776** | 58.8% of CSS bytes |

The two local fonts use `font-display: swap`, so font download should not block fallback text paint. One font URL is versioned/immutable; Departure Mono is not.

`vendor/js-yaml.min.js` is 43,549 bytes and is a synchronous classic script in the head. The only client uses are `jsyaml.load(manifestText)` and `jsyaml.load(palettesText)` inside `AssetManager`. It is not needed to parse or paint the shell. Low-risk first step: add `defer` (boot already waits for `window.load`). Better: side-effect `import('../../../vendor/js-yaml.min.js')` inside the asset-loading path and read `globalThis.jsyaml`; the UMD wrapper explicitly falls back to `globalThis`, so it can execute as a module despite exporting no ESM bindings. Fetch that import in parallel with the two YAML texts. This removes parser blocking without a build step.

Also start `App` at module evaluation/DOMContentLoaded instead of waiting for `window.load`. The module is at the end of `<body>` and is defer-like, so the DOM exists when it evaluates. `load` unnecessarily couples shell boot to unrelated page subresources.

## Lazy-loading candidates

Ranked by safe shift out of the initial closure:

1. **Top-bar audio:** split `AmbientAudioController` from `TopBar` and import it after first world paint or first sound interaction. About 222,823 unique eager bytes / ~5,775 LOC move out of the initial closure. Preserve persisted-enabled behavior by scheduling post-paint initialization; visual consequence is none.
2. **Activity panel:** dynamic-import on first `agent:selected` or an `#agent=` deep link. It accounts for 249,958 unique eager bytes / ~6,098 LOC in six modules; total closure is 424,996 bytes. Deep-link activation must await it before applying selection.
3. **Dashboard:** keep world default and import on first Dashboard click. Saves 60,508 bytes / 1,353 LOC and two late discovery levels before world boot completion. A true dashboard-first boot does not exist today; if added, invert the rule and do not load `AssetManager` or the world graph until World is selected.
4. **Chronicle presentation:** retain `ChronicleLog`/store collection, import `ChroniclePanel.js` on first Chronicle click. Saves 22,647 bytes / 588 LOC initially. Modal UI can use the same lazy facade.
5. **Debug overlay:** `DebugOverlay.js` is 19,066 bytes / 397 LOC (its four-module closure is 39,928 bytes, mostly already-shared config). Import on Shift+D and create on demand. `ClientPerfMetrics.js` is larger (31,139 bytes / 838 LOC) but is wired into WebSocket and renderer instrumentation, so split it only with tests for telemetry continuity.
6. **Simulator fixtures:** no action; already dynamic and absent from normal boot.

Deferring `ActivityPanel` also prevents it from prematurely pulling dashboard `AvatarCanvas` and character `VillageDirector`/composition code into the initial closure. Some of those modules are later needed by the world renderer, so this is principally a scheduling/initial-depth win, not an equal reduction in total world bytes.

## Modulepreload opportunities

Native ESM preload is the zero-build tool for flattening cold waterfalls:

- Put `<link rel="modulepreload" href="src/presentation/App.js">` in the head so entry fetch starts before the parser reaches the bottom-of-body script.
- For the always-default world path, modulepreload `src/presentation/character-mode/IsometricRenderer.js`. In Chromium this lets its dependency graph download/compile while API and images are in flight instead of beginning after all asset awaits.
- If explicit leaves are needed for consistent browser behavior, preload the measured incremental world chain (`WorldFrameRenderer.js`, `SceneCategoryRegistry.js`, `HarborTraffic.js`, `ParticleSystem.js`, `MarkGovernor.js`) and a few high-fan-out renderer roots—not all 57 links.
- Do **not** preload Dashboard, ActivityPanel, ChroniclePanel, debug, simulator, or audio after making them genuinely lazy; that would defeat the split.
- Preloading does not replace validators: cold preload flattens discovery; warm ETags avoid bodies.

Verification should compare a disabled-cache cold trace and an ordinary warm reload. Check request initiators and ensure world module waves overlap `/api/*` and PNGs; measure navigation → shell rAF, sidebar agents, renderer `show()`, and first successful renderer rAF separately.

## Ranked remediations

| Rank | Remediation | Expected impact | Effort | Risk | Visual consequence | Verification |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Add ETag/Last-Modified + conditional 304 handling; retain `no-cache` | Warm body transfer: at least 3.94 MB → 0; unchanged files avoid full 200 bodies | M | Low | None | Two `curl` GETs with returned ETag; second sends `If-None-Match` and must be 304/zero body; edit one file and it must be 200 immediately |
| 2 | Start world import/preload, source sync, and asset loading concurrently; parallelize providers with sessions | Removes entire serial sums; hides six late ESM levels under API/image work | M | Medium | None if commit/join boundaries stay the same | Performance marks and cold Network waterfall; reducer-state unit tests; agents/world parity |
| 3 | Introduce essential/albedo-first asset readiness, then progressive optional/material fill | Removes the 8.14 MB all-assets gate from first world frame; likely largest cold-paint gain | L | Medium-high | Brief deterministic placeholders/albedo-only lighting, then fill-in; avoid layout/camera shifts | Cold screenshots/recording at first frame and completion; missing-asset tests; GPU upload/repaint checks |
| 4 | Lazy ActivityPanel, top-bar audio, Chronicle UI/modal, Dashboard, DebugOverlay | Initial graph can shed hundreds of KB and its audio-defined 7-level critical chain; avoids hidden-feature eval | M-L | Medium | None except panels may open after a short first-use load; show local loading state | First-use interactions, deep link, persisted audio, Chronicle, Dashboard toggle, Shift+D; compare module request set |
| 5 | Move boot off `window.load`; defer or asset-local import js-yaml | Shell/status begins earlier; removes 43.5 KB parser-blocking head script | S-M | Low | Earlier visible placeholder/shell | Throttled cold load: body parses before YAML; manifest parse failure still maps to `assets-failed` |
| 6 | Add targeted `modulepreload` for App + default world chain | Flattens cold entry and late renderer discovery without bundling | S | Low-medium | None | Cold request initiator/waterfall; ensure lazy feature modules are not accidentally preloaded |
| 7 | Load dashboard/modal/activity CSS at feature activation | Removes 72.9 KB (58.8%) from render-blocking CSS | S-M | Medium | Risk of flash of unstyled panel unless stylesheet readiness is awaited before reveal | Slow-cache first-open tests; no FOUC; world first paint unchanged visually |
| 8 | Add negotiated on-the-fly gzip/Brotli for text | Normal JS wire bytes roughly 3.63 MB → 0.89 MB cold | M | Low-medium | None | `curl --compressed`, `Content-Encoding`, `Vary`, byte comparison; CPU sampling |

Recommended implementation order is 1 → 2/5/6 → 4 → 3 → 7/8. Add explicit client performance marks before changing sequencing so improvements are attributable: `app-module-evaluated`, `shell-painted`, `sources-ready`, `base-assets-ready`, `materials-ready`, `renderer-module-ready`, `renderer-shown`, `first-world-frame`.

## Ruled out / bounded conclusions

- **Server scanner/event-loop stall:** explicitly out of scope and not re-investigated.
- **Steady-state renderer FPS:** 60 FPS after boot does not explain first-paint latency; renderer internals are owned by another investigation.
- **A 160-request initial static graph:** false for the current client. Initial static closure is 81; normal boot eventually reaches 141. The 160 filesystem count includes 17 server-side modules.
- **Simulator fixture shipping normally:** false. Both fixture files are behind the `?sim=1` dynamic import.
- **Eight CSS files causing eight serial RTTs:** false. They are independently discovered together with no CSS `@import`; they are all render-blocking, but parallel.
- **TCP connection-per-module churn:** not supported. HTTP/1.1 keep-alive is enabled by Node defaults and static responses do not close connections.
- **Warm sprite bodies as the main cache bug:** versioned sprite/font URLs already have one-year immutable caching. The warm-cache defect is editable JS/CSS/HTML/YAML/vendor/unversioned-font delivery; cold sprite gating is a sequencing/readiness issue.
- **`js-yaml` as general boot infrastructure:** false. It is used only for the sprite manifest and palette YAML.
- **A bundler as a prerequisite:** false and prohibited. Conditional caching, dynamic `import()`, modulepreload, progressive readiness, deferred styles, and HTTP compression all work with direct native ESM.
