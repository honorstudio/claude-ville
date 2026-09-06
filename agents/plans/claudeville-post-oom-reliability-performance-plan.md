# ClaudeVille post-OOM reliability and performance plan

**Status:** `implemented and release-verified`

**Open follow-ups:** See the [live open-followups checklist](open-followups.md)
for the retained items and their measurement triggers.

**Audit date:** July 28, 2026

**Implementation date:** July 28, 2026

**Baseline:** `main` at `6a84e20` (`v0.29.0.2`)

**Relationship to prior work:** This is a follow-up to the completed
`agents/plans/claudeville-comprehensive-remediation-plan.md`. It does not reopen
findings that were fixed and verified in v0.29.

**Artifact note:** `AGENTS.md` references `agents/README.md`, but that file is
absent at this baseline. This plan follows the repository's existing
`agents/plans/` convention and does not introduce another artifact type.

## Implementation record

The high-value pressure fixes in this plan are implemented. The deliberately
larger architecture changes that no longer meet the user's “simple, minimal,
performance-first” constraint are retained below with measured triggers.

The detailed checklists remain the original audit specification for
traceability. This completion matrix and the deferral table are the
authoritative implementation state.

| Package | State | Implemented result |
| ---: | --- | --- |
| 0 | Complete | Watcher PID/count verification, failure semantics, warm-up and rolling slope gates, interval rates, mode checkpoints, and OOM triage documentation |
| 1 | Complete | Visible-sprite trail coordinates, duplicate suppression, per-agent/global/pending/render caps, bounded newest-first hydration, slow pruning, direct drawing, lifecycle generations, and diagnostics |
| 2 | Complete, simplified | Dashboard zeros the World canvas and releases decoded World assets, masks, outlines, agent sheets, and volatile caches; World waits for a generation-current reload before restarting RAF |
| 3 | Complete | Claude consumers share a signature-keyed compact tail projection; large scalars, tool inputs/results, and message fields are bounded; aggregate work is cached and large scans yield |
| 4 | Optimized; queue deferred | Git work is change-driven, scoped, cached for five minutes, nested-remote-aware, and zero-command when warm. The remaining cold/change subprocess path is measured and retained as a follow-up |
| 5 | Complete | Desktop notifications have explicit ownership/cleanup and modal/Chronicle reads use generation-safe ownership |
| 6 | Complete | Chronicle summary/page reads, incremental fixed-size agent signatures, WebSocket snapshot release, and biography/affinity/cache bounds are covered by regressions |
| 7 | Complete for measured hot paths | Gemini/Grok/Kimi/OpenCode caches and active-first lookups are bounded; Kimi has a bounded old-index fallback; OpenCode avoids the all-history part scan |
| 8 | Complete | Harbor semantic cadence/allocation reuse, bounded light-color spaces, hidden-panel timers, bounded building discovery/projection, and bounded quota bodies |
| 9 | Release gate complete | Full quick validation, focused smokes, 250 lifecycle transitions, repeated World profiles, a fresh-code warmed soak, and the default 10-minute browser/30-minute server release soak pass |

### Verification evidence

- `npm run validate:quick` passes all syntax, fixture, theme, sprite, and
  **100/100** dependency-free unit tests.
- Adapter, relationship, tail-cache, Claude aggregate, Codex warm-discovery,
  watcher runtime/topology, scoped invalidation, World bounds, Harbor bounds,
  building, terrain, usage-history, server-security, and visit-path smokes pass.
- The oversized Claude fixture reads about **52.5 MiB**, remains inside the
  compact parsed-tail budget, and adds zero parsed lines on its unchanged second
  detail read.
- The synthetic trail fixture retains **10,000** samples under the 12,000
  global cap, compacts **70,000** old samples, retains one stationary point,
  and sends at most **240** ordinary points to either rendering path.
- `browser-lifecycle.mjs --count=250` passes mode switching, teardown/reboot,
  context-loss recovery, audio, cache cleanup, and frame-failure recovery.
- The fresh-code mode checkpoint records World canvas pixels
  **1,286,560 → 0 → 1,286,560** and decoded World asset pixels
  **15,717,856 → 0 → 15,717,856**. Composited agent-sheet pixels record
  **3,385,600 → 0 → 3,385,600**, with zero resume failures.
- The warmed 20-second browser/server soak passes with no frame failure,
  negative browser-heap and server-RSS slopes, no added Git commands, zero
  oversized-tail rejection rate, bounded trails, and all Dashboard resource
  checkpoints at zero.
- The default release soak passes all **11 browser** and **31 server**
  checkpoints over **10/30 minutes**. The steady browser-heap slope projects
  **3,044,985 bytes** of growth and the trailing slope **4,432,269 bytes**,
  both below the 8 MiB gate; steady and trailing server-RSS slopes are
  negative, ending at **170,639,360 bytes RSS**.
- Direct and API watcher counts agree at **24** for the maintained runtime; the
  deliberately low `--max=1` threshold fails.
- Git enrichment measures **17.02 ms / 4 commands** cold and
  **0.34 ms / 0 commands** on an unchanged warm refresh. The live 30-minute
  release workload records **46 → 502** commands while active projects change,
  remaining inside the configured steady-rate gate.
- The Kimi old-index fixture resolves an entry outside the newest 4,096 lines
  through resumable passes capped at **64 KiB** each, then performs no further
  fallback scan while the index is unchanged.
- Nested loose Git refs remain change-sensitive while each synchronous
  signature walk is capped at **800 entries** and **8 levels**; the overflow
  fixture exercises and reports truncation.
- Three-repetition World profiles at 13, 50, 80, and 100 agents complete
  without frame failures. Host load was heavily saturated, so absolute FPS is
  informational; trail segment medians remained bounded at roughly
  **0.2–1.4 ms**.

### Retained follow-ups

| Follow-up | Implement when | Reason retained |
| --- | --- | --- |
| Async stale-while-revalidate Git worker | Cold/change Git enrichment exceeds 50 ms p95, Git appears in broadcast p95, or warm runs launch commands | A safe implementation requires a bounded `execFile` queue, coalescing, generations, last-good snapshots, completion invalidation, retry/backoff, and shutdown across `gitEvents.js`, `adapters/index.js`, and `server.js`. The measured warm path is already zero-command |
| Identity-aware native-surface registry and staged asset groups | A new surface owner shares World assets with Dashboard, diagnostics cannot attribute overlap, or Dashboard becomes a direct boot mode | Explicit owner lifecycles now drive World-exclusive decoded assets and the main canvas to zero; another registry would duplicate ownership machinery without changing the measured result |
| Durable Claude aggregate checkpoints and global provider cold-work scheduler | A cold restart scans more than 64 MiB synchronously, takes more than two seconds, or provider diagnostics show a growing deferred-age backlog | Current signature caches, guard/append aggregation, async large-file scanning, active-first fallbacks, and byte caps address the observed paths without adding a new durable index |

## Goal

Reduce ClaudeVille's verified memory, native-canvas, parsing, and subprocess
pressure; fix the correctness and lifecycle defects found during the pass; and
make future memory regressions measurable before attributing another system OOM
to ClaudeVille.

This is a zero-build, desktop-only plan. It adds no framework, bundler, runtime
dependency, responsive behavior, or provider-data mutation.

## Incident verdict

ClaudeVille was **not the demonstrated cause** of the July 28 system OOM.

- At 07:39, the kernel OOM table recorded the maintained ClaudeVille Node
  process (`pid 920292`) at about **332 MiB RSS** plus about **4 MiB swap**.
- The same OOM sequence recorded an unrelated `next-server` process at about
  **7.5 GiB anonymous RSS** and killed it. Slack and Chrome processes were also
  killed during the global memory shortage.
- After browser probes closed, ClaudeVille's maintained server settled around
  **193–218 MiB RSS**. During the active browser soak it ranged up to about
  **267 MiB RSS**.
- The browser's native canvas, decoded-image, and GPU allocations are not fully
  represented by either Node RSS or `performance.memory`, so the server result
  does not exonerate the browser UI from avoidable pressure.

The implementation should therefore be described as **pressure reduction and
reliability hardening**, not as a fix for a proven ClaudeVille-caused OOM.

## Audit evidence

| Area | Evidence | Conclusion |
| --- | --- | --- |
| Server retention | Roughly 18.8-hour maintained process; no monotonic descriptor, listener, cache-entry, or WebSocket-client growth was reproduced | No confirmed steady-state server leak |
| Shared JSONL tails | 32 MiB byte cap remained effective, but live counters reached about 164.6 million parsed lines, 764,000 misses, and 4,861 rejected oversized parsed entries | Bounded retention with severe transient parse/allocation churn |
| Claude parsing | Claude's own parsed-tail cache recorded 3,875 oversized-entry rejections; a local transcript is about 4.6 GiB | Active consumers can repeatedly materialize large objects; cold aggregation can rescan from byte zero |
| Git enrichment | About 92,600 cumulative Git commands and 443 seconds of command time; one nine-project refresh launched 43 synchronous commands and blocked about 151 ms | Confirmed periodic subprocess and event-loop pressure |
| Browser lifecycle | `browser-lifecycle.mjs --count=250` passed; 59 DOM listeners, 115 event-bus listeners, and one World canvas stayed flat in the soak | No confirmed general listener/RAF teardown leak |
| Browser heap | Forced-GC heap rose about 7.66 MiB over the 60-second sample and narrowly passed the existing 8 MiB plateau check | Short gate is too weak to cover one-hour trail retention |
| Trails | Every agent can be captured once per second for an hour, including unchanged positions; 13 stationary agents can create 46,800 records and 50 can create 180,000 | Confirmed bounded-but-large growth and stale-coordinate correctness defect |
| World native resources | A 50-agent World → Dashboard probe released volatile caches but retained a 1.29M-pixel main canvas, 18.28M pixels of live agent sheets, 15.72M decoded asset pixels, and other shared/static caches | Confirmed native-resource retention while World is suspended; categories overlap and must be deduplicated |
| World profile | Under a heavily loaded host, trails were the largest render segment: p50 22.6 ms in clear and 18.1 ms in rain; an independent 50-agent run measured trail p50 9.2 ms | Trail work is consistently expensive; absolute FPS from the loaded host is informational |
| Harbor/light churn | In 60 seconds, unchanged harbor reconciliations rose by about 2,340 and light-fade cache evictions by about 10,779 | Confirmed per-frame allocation/cache thrash, not retained growth |
| Dashboard/application | Notification objects survive clear/destroy; a delayed Chronicle read can overwrite a newer modal; unlimited Chronicle day reads and historical identity caches are unbounded by count | Confirmed lifecycle/correctness defects plus scalability risks |
| Validation | `validate:quick`, 82 unit tests, adapter/tail/aggregate/discovery smokes, World/harbor bounds, building/terrain validators, browser lifecycle, and short performance soak passed | Current behavior is broadly sound; focused regression coverage is missing |

### Measurement caveats

- Canvas, compositor, processed-sprite, and asset counts can refer to the same
  underlying surface. Do not add their byte estimates without identity-based
  deduplication.
- The clear/rain profile ran while host load average was about 26. Raw FPS is
  not a stable cross-machine release gate. Paired cases and named segment
  timings are still useful.
- A 60-second plateau cannot disprove growth whose intended retention window is
  one hour.
- Current Chronicle and affinity stores are small. Their findings are
  scalability defects, not explanations for this incident.

## Priority definitions

- **P0:** Measurement integrity, direct native-resource pressure, or a
  correctness defect on a continuously active path. Complete before the next
  release.
- **P1:** Confirmed material CPU/allocation/lifecycle pressure or user-visible
  correctness. Target the same release after P0.
- **P2:** Confirmed inefficiency or bounded scalability risk that needs focused
  fixtures before optimization.
- **P3:** Defense in depth or conditional provider/runtime hardening. Implement
  only after the higher priorities pass their gates.

## Findings index

| ID | Priority | Finding | Confidence | Package |
| --- | --- | --- | --- | ---: |
| CV2-TEST-001 | P0 | Watcher smoke measures itself by default and can falsely pass | Confirmed by deliberate false pass | 0 |
| CV2-WORLD-001 | P0 | Trails record domain positions instead of visible sprite movement | Confirmed source path | 1 |
| CV2-MEM-001 | P0 | Trail capture/hydration/render retention grows for one hour | Confirmed bounds and profile | 1 |
| CV2-LIFE-001 | P1 | Trail hydration can resume capture after World is paused | Confirmed async race | 1 |
| CV2-MEM-002 | P0 | Suspended World retains native canvas/image resources | Confirmed browser probe | 2 |
| CV2-MEM-003 | P1 | Asset boot is all-or-nothing and decoded assets live until App teardown | Confirmed browser/source path | 2 |
| CV2-PERF-001 | P1 | Oversized parsed tails are evicted and reparsed by multiple consumers | Confirmed live counters/source path | 3 |
| CV2-PERF-002 | P1 | Periodic Git enrichment blocks broadcasts with sync subprocess bursts | Confirmed live timing/source path | 4 |
| CV2-LIFE-002 | P1 | Desktop notifications are not owned or closed | Confirmed deterministic probe | 5 |
| CV2-DATA-001 | P1 | Stale Chronicle reads can replace newer modal content | Confirmed browser race | 5 |
| CV2-MEM-004 | P2 | Chronicle materializes an unlimited day into arrays and DOM | Confirmed source path; small live store | 6 |
| CV2-PERF-003 | P2 | Full nested agent payloads are stringified and retained as signatures | Confirmed allocation path | 6 |
| CV2-MEM-005 | P2 | Biography and affinity caches retain historical identities/pairs for the tab lifetime | Confirmed source path; small live store | 6 |
| CV2-PERF-004 | P2 | Provider discovery repeatedly sweeps large historical corpora | Confirmed source path/local corpus sizes | 7 |
| CV2-PERF-005 | P2 | Cold Claude aggregation can restart a multi-gigabyte scan from byte zero | Confirmed source path; not active during audit | 7 |
| CV2-PERF-006 | P2 | OpenCode active lookup scans all historical parts | Confirmed SQLite query plan | 7 |
| CV2-PERF-007 | P2 | Kimi parses stale agents after already identifying the active set | Confirmed source path | 7 |
| CV2-PERF-008 | P2 | Harbor semantics, light colors, and movement helpers allocate in frame loops | Confirmed counters/profile/source path | 8 |
| CV2-HARD-001 | P3 | Whole-file provider caches and indexes need byte bounds | Conditional/defense in depth | 7 |
| CV2-HARD-002 | P3 | Arbitrary building keys and the quota response body need hard bounds | Conditional/defense in depth | 8 |

## Execution order and ownership

| Order | Package | Priority | Primary owned paths | Depends on |
| ---: | --- | --- | --- | --- |
| 0 | Establish trustworthy pressure gates | P0 | `scripts/smoke/`, `/api/perf`, troubleshooting docs | None |
| 1 | Correct and bound World trails | P0 | `TrailRenderer.js`, World integration/tests | Package 0 |
| 2 | Suspend World native resources and stage assets | P0/P1 | renderer/compositor/assets/App | Package 0 |
| 3 | Parse transcript tails once into bounded projections | P1 | shared + Claude adapter parsing/tests | Package 0 |
| 4 | Make Git enrichment change-driven and nonblocking | P1 | adapters Git pipeline/server/tests | Package 0 |
| 5 | Close browser resources and modal races | P1 | application/shared UI/lifecycle tests | Package 0 |
| 6 | Bound histories, signatures, and identity caches | P2 | application/infrastructure/shared UI | Package 5 |
| 7 | Incrementalize provider discovery and cold indexing | P2 | provider adapters and adapter smokes | Packages 3–4 |
| 8 | Remove measured frame-loop and defensive allocation risks | P2/P3 | World hot paths, Activity Panel, quota | Packages 1–2 |
| 9 | Run the release verification gate | P0 | validation only, then changelog/version if pushing | All mandatory packages |

Packages 1, 3, 4, and 5 can proceed in parallel with disjoint ownership.
Package 2 must coordinate `AssetManager`, `Compositor`, `AgentSprite`, and
Dashboard avatars as one owner to avoid double-closing shared surfaces.

## Package 0 — Establish trustworthy pressure gates

**Finding:** CV2-TEST-001

**Owned paths:** `scripts/smoke/watcher-footprint.mjs`,
`scripts/smoke/performance-soak.mjs`, `claudeville/server.js`,
`docs/troubleshooting.md`, focused test fixtures

### Implementation

- [ ] Change watcher-footprint's default target from `process.pid` to
  `/api/perf.runtime.pid`; keep an explicit `--pid` override.
- [ ] Read `/proc/<server-pid>/fdinfo` and assert both the direct count and
  `/api/perf.watchers.linux` count. Treat an unavailable/mismatched PID as an
  error, not a skip.
- [ ] Add normal `--help`, unknown-argument, invalid-limit, missing-API, and
  unsupported-platform behavior.
- [ ] Add a deterministic regression fixture proving a deliberately low watcher
  maximum fails against the server. The current `--max 1` false pass must become
  impossible.
- [ ] Extend `/api/perf` or the soak sampler with interval deltas/rates for:
  parsed records, oversized parse rejections, bytes read, Git commands/time,
  dirty marks, probe scans, broadcasts, trail samples/repaints, and native
  surface high-water marks.
- [ ] Give the soak an explicit warm-up phase. Keep absolute limits, then add
  rolling forced-GC heap and server-RSS slope checks so a one-window
  floor-to-final comparison cannot narrowly hide continued growth.
- [ ] Add World → Dashboard → World checkpoints and synthetic elapsed-time trail
  coverage to the soak.
- [ ] Document the Linux OOM triage procedure: match `/api/perf.runtime.pid` to
  the kernel OOM table, compare anonymous RSS rather than virtual memory, and
  record browser-native budgets separately from Node memory.

### Acceptance

- [ ] `node scripts/smoke/watcher-footprint.mjs --max 1` fails against a server
  with more than one physical watch; the normal bound passes.
- [ ] Direct and API watcher counts identify the same process and agree within a
  documented sampling tolerance.
- [ ] A fresh isolated runtime and the maintained runtime can both be sampled
  without stopping the operator's port-4000 process.
- [ ] The default 10-minute browser/30-minute server soak reports warm-up,
  rolling slopes, current/high-water native bytes, parse rate, Git rate, and
  trail growth.
- [ ] The smoke fails on a synthetic rising heap/RSS series and passes on a
  noisy plateau.

## Package 1 — Correct and bound World trails

**Findings:** CV2-WORLD-001, CV2-MEM-001, CV2-LIFE-001

**Owned paths:** `claudeville/src/presentation/character-mode/TrailRenderer.js`,
`IsometricRenderer.js`, `WorldFrameRenderer.js`, `CanvasBudget.js`,
`scripts/smoke/world-state-bounds.mjs`, performance fixtures

### Implementation

- [ ] Build trail samples from current `AgentSprite` movement coordinates,
  converted explicitly to tile coordinates. Do not capture stale domain
  `agent.position` values.
- [ ] Suppress stationary and sub-threshold duplicate samples. If a heartbeat is
  required for history semantics, give it a much slower explicit cadence.
- [ ] Define and enforce both per-agent and global sample caps. Resample old
  paths so the one-hour visual remains recognizable without retaining
  one-second resolution.
- [ ] Hydrate newest-first through a bounded IndexedDB query/cursor. Never load
  an unlimited hour into memory before applying limits.
- [ ] Prune on a slow cadence using cutoff indexes/in-place removal instead of
  filtering and replacing every agent array every second.
- [ ] Apply sample caps at every zoom level, reject offscreen paths before
  allocating point objects, and retain no near-screen-sized trail canvas when
  it is empty.
- [ ] Measure whether a sparse direct draw, tiled/chunked cache, or bounded
  screen cache wins for the actual one-hour fixture; select the simplest option
  that meets the gate.
- [ ] Add a paused/lifecycle generation. Recheck it after hydration and every
  other await so a World → Dashboard switch cannot reacquire the capture lease.
- [ ] Expose total/hydrated/pending samples, duplicate drops, prune count,
  repaint count/time, cache pixels, and high-water marks.

### Tests

- [ ] Ten minutes of a stationary agent produces at most one initial point plus
  the explicitly documented heartbeat.
- [ ] A moving sprite produces a path matching visible movement, including
  pause/resume and camera changes.
- [ ] A synthetic hour at 13, 50, and 100 agents never exceeds the declared
  global/per-agent caps.
- [ ] Hydration returns the newest valid path within the cap and preserves
  ordering, phase color, selection emphasis, and malformed-store fallback.
- [ ] Delayed hydration followed by `pause()` acquires no lease, captures no
  point, and schedules no write.
- [ ] The 50-agent synthetic-hour trail repaint median is at least 40% below a
  three-run pre-change baseline, with no frame failure.

## Package 2 — Suspend World native resources and stage assets

**Findings:** CV2-MEM-002, CV2-MEM-003

**Owned paths:** `CanvasBudget.js`, `IsometricRenderer.js`, `AgentSprite.js`,
`Compositor.js`, `AssetManager.js`, `App.js`, `AvatarCanvas.js`, static/fantasy
cache owners, browser lifecycle/performance smokes

### Implementation

- [ ] Introduce one identity-aware surface registry that records owner,
  category, dimensions, estimated RGBA bytes, shared/exclusive status, current
  count, and high-water mark.
- [ ] Deduplicate surfaces by object identity. The registry must make overlap
  between AgentSprite, Compositor, processed sheets, and AssetManager explicit.
- [ ] Replace the current partial canvas total and hard-coded
  `domCanvasPixels: 0` with complete active-World and suspended-Dashboard
  diagnostics.
- [ ] Add explicit World `suspend()` and `resume()` tiers rather than treating
  Dashboard mode as only “RAF stopped.”
- [ ] On suspend, zero the World canvas backing store and release World-exclusive
  agent-sheet references, processed sheets, trail/static/fantasy caches, and
  optional asset groups.
- [ ] Preserve Dashboard avatar surfaces that still have owners. A compositor
  eviction must release backing storage only after the final owner detaches.
- [ ] Lazily recreate World surfaces on resume, force a resize, and restore
  selection, camera, weather, trails, and animations without duplicate
  subscriptions.
- [ ] Replace `AssetManager.load()` at boot with staged `ensure()` groups:
  Dashboard essentials, World terrain/buildings, then atmosphere/optional props
  on first use.
- [ ] Close replaced/unreferenced `ImageBitmap` objects where supported and
  retain the existing image fallback path.
- [ ] Unify AvatarCanvas's fallback asset version/cache with AssetManager so a
  failed manifest does not create a second stale image cache.

### Acceptance

- [ ] In Dashboard mode, the main World canvas has a zero backing store and
  World-exclusive surface categories are at zero.
- [ ] Shared Dashboard compositor/avatar surfaces remain under their declared
  budget and render correctly.
- [ ] World → Dashboard → World repeated 100 times returns to the same
  suspended/active surface counts without a rising high-water mark after warm-up.
- [ ] A fresh Dashboard-only boot decodes no World-only asset group.
- [ ] First World entry and resume meet the recorded readiness budget and show
  no missing sprite, black frame, stale camera, or console error.
- [ ] `browser-lifecycle.mjs --count=250` still passes all teardown, reboot,
  failure, audio, and context-loss scenarios.

## Package 3 — Parse transcript tails once into bounded projections

**Finding:** CV2-PERF-001

**Owned paths:** `claudeville/adapters/shared.js`,
`claudeville/adapters/claude.js`, adapter diagnostics, tail/aggregate/unit tests

### Problem boundary

The 32 MiB shared cache cap is working and must remain. The defect is that a
large parsed view is inserted, evicts itself at `shared.js:191-200`, and is
reparsed at `shared.js:517-587`. Claude then invokes separate summary, status,
usage, message, and Git consumers over the same 5,000-line/64 MiB window.

### Implementation

- [ ] Add one per-session, per-signature collection context so all consumers in
  a refresh share one parse pass.
- [ ] Project only fields required for status/tool state, bounded message edges,
  usage totals/deltas, summaries, and bounded Git metadata while streaming.
- [ ] Discard large tool-result bodies and other unconsumed content immediately;
  do not retain complete parsed JSON objects solely for reuse.
- [ ] Cache the compact projection by file signature under an explicit byte and
  entry budget. Keep malformed trailing-line/skipped-line diagnostics.
- [ ] Make different line-count consumers derive views from the same projection
  rather than issuing independent reads.
- [ ] Give Git/message collections independent event caps and report truncation
  explicitly rather than silently growing.
- [ ] Keep the raw tail state byte-bounded. Do **not** solve the problem by
  increasing the 32 MiB limits.
- [ ] Add projection bytes, parse passes, records parsed/reused/dropped, and
  rejection reason to `/api/perf`.

### Acceptance

- [ ] A fixture whose 5,000-line parsed representation exceeds 32 MiB is parsed
  exactly once per signature across all Claude consumers.
- [ ] Re-reading an unchanged signature increases neither parse-pass nor
  parsed-record counters.
- [ ] Append, truncation, rotation, malformed middle line, trailing partial,
  oversized line, and source-change behavior remains correct.
- [ ] Session list/detail/usage/message/Git fixture output remains equivalent,
  except for deliberately documented bounded truncation metadata.
- [ ] Tail-cache, Claude aggregate, watcher-runtime, scoped-invalidation,
  adapter smokes, unit tests, and the long soak pass.

## Package 4 — Make Git enrichment change-driven and nonblocking

**Finding:** CV2-PERF-002

**Owned paths:** `claudeville/adapters/index.js`,
`claudeville/adapters/gitEvents.js`, `claudeville/server.js`, Git fixtures and
smokes

### Implementation

- [ ] Separate cheap repository/ref signatures from expensive enrichment.
- [ ] Keep the last good enrichment snapshot valid until a relevant signature
  changes. Reuse the active-project Git-state signal already maintained by the
  server.
- [ ] Give inactive repository-scan projects a slower round-robin stale sweep
  with a per-tick project/time budget.
- [ ] Replace `execFileSync` on the broadcast path with a concurrency-limited
  async queue. Coalesce duplicate project requests and publish the last good
  snapshot while refresh is in flight.
- [ ] Merge Git commands only where output/error semantics remain testable;
  retain timeouts, error counters, and the disable switch.
- [ ] Cancel or drain work cleanly at shutdown. A failed refresh must preserve
  the last good data and schedule bounded retry/backoff.
- [ ] Report queue depth, active jobs, coalesced requests, stale age, commands,
  command time, failures, and per-project refresh reason.

### Acceptance

- [ ] After warm-up, an unchanged 60-second fixture launches zero new Git
  processes.
- [ ] Active HEAD, index/worktree, and remote-ref changes appear within the
  documented active-project SLA.
- [ ] Inactive projects respect the slower eventual-refresh SLA and cannot
  monopolize a server tick.
- [ ] `broadcastUpdate()` never synchronously waits for a Git subprocess.
- [ ] Inferred commit/push/unpushed results, ordering, cache invalidation, error
  fallback, and `CLAUDEVILLE_DISABLE_GIT_ENRICHMENT` remain compatible.
- [ ] The server soak shows no periodic 30-second Git burst and stays within the
  event-loop p95 gate.

## Package 5 — Close browser resources and modal races

**Findings:** CV2-LIFE-002, CV2-DATA-001

**Owned paths:** `claudeville/src/application/AttentionService.js`,
`claudeville/src/presentation/shared/Modal.js`, `ChroniclePanel.js`, `TopBar.js`,
`App.js`, focused unit/browser lifecycle tests

### Implementation

- [ ] Own desktop notifications in `Map<agentId, Notification>`.
- [ ] Close/delete a notification on attention clear, replacement, native
  `onclose`, alert disable, and service destroy.
- [ ] Capture only `agentId` in notification callbacks; resolve the current
  agent on click instead of closing over the full payload.
- [ ] Add a monotonic modal owner/version token. Async producers may replace
  content or move focus only while they still own the current request.
- [ ] Invalidate Chronicle ownership on a newer Chronicle open, Changelog open,
  modal close, and App destruction.
- [ ] Give `ChroniclePanel` an explicit destroy/invalidate lifecycle before
  `Modal.destroy()`.

### Acceptance

- [ ] Fake-notification tests cover raise → clear, repeated raise, native close,
  click, disable, permission failure, and destroy with zero owned notifications.
- [ ] Delayed Chronicle reads resolved out of order leave the newest request
  visible.
- [ ] Chronicle → Changelog and destroy-before-resolution never replace newer
  content or steal focus.
- [ ] Existing modal focus trap/restoration, keyboard behavior, and
  `browser-lifecycle.mjs --count=250` remain green.

## Package 6 — Bound histories, signatures, and identity caches

**Findings:** CV2-MEM-004, CV2-PERF-003, CV2-MEM-005

**Owned paths:** `ChronicleStore.js`, `ChronicleLog.js`, `ChroniclePanel.js`,
`AgentManager.js`, `WebSocketClient.js`, `AgentBiographyService.js`,
`RelationshipAffinityService.js`, `ActivityPanel.js`, persistence/unit tests

### Implementation

- [ ] Add a cursor/reducer path for Chronicle summary totals so a day's summary
  does not first materialize every record.
- [ ] Fetch only a named, constant-size newest timeline page and provide bounded
  older-page navigation or a clear omitted-count label. Never create an
  unlimited number of `<li>` rows on one open.
- [ ] Replace AgentManager's retained full-payload JSON signature with a
  fixed-size digest/revision over fields that affect domain/UI behavior.
- [ ] Hash bounded Git/message rows incrementally. Keep nested changes
  observable without storing the complete serialized payload twice.
- [ ] Keep WebSocket's protocol snapshot because delta application needs it,
  but clear it on terminal disconnect/destroy and expose retained byte/count
  diagnostics.
- [ ] Add LRU/retention bounds to biography and affinity caches. Pin active,
  selected, dirty, and in-flight records until persistence completes.
- [ ] Prune in-memory affinity records with the existing five-minute store
  prune, and preload/query only pairs relevant to live or selected identities
  where practical.
- [ ] Clear settled caches after stop/drain without losing queued writes.

### Acceptance

- [ ] A synthetic 10,000-event day produces exact summary totals while timeline
  arrays/DOM rows never exceed the declared page size.
- [ ] Chronicle ordering, day navigation, selected-event behavior, and empty
  states remain correct.
- [ ] Agent signature storage is fixed-size per agent regardless of input
  payload bytes; nested Git/message changes still emit exactly one update.
- [ ] Thousands of identities/pairs remain inside declared memory bounds, retain
  selected/live records, and lose no mutation across flush/stop/reload.
- [ ] Existing biography, affinity, Chronicle, WebSocket delta, and lifecycle
  tests pass.

## Package 7 — Incrementalize provider discovery and cold indexing

**Findings:** CV2-PERF-004, CV2-PERF-005, CV2-PERF-006, CV2-PERF-007,
CV2-HARD-001

**Owned paths:** `claudeville/adapters/claude.js`, `grok.js`, `kimi.js`,
`opencode.js`, `gemini.js`, `codex.js`, adapter diagnostics and isolated
provider fixtures

### Phase A — Mandatory P2 work

- [ ] Give Claude, Grok, Kimi Code, and legacy Kimi per-provider discovery
  indexes keyed by directory/file signatures. Use the bounded Codex warm-index
  pattern where its semantics fit.
- [ ] Process changed directories and the warm active set first, then round-robin
  cold entries under a syscall/time budget. Preserve old-directory sessions
  whose files remain active.
- [ ] Select active Kimi agent records before parsing wire contents, plus only
  the main/freshest record needed for lineage/project fallback.
- [ ] Replace OpenCode's all-history `GROUP BY` active lookup with a benchmarked
  read-only query/cache keyed by database/WAL signature. Never add an index to
  or mutate the provider's database.
- [ ] Bound each provider tick and expose directories/files/rows scanned,
  deferred work, warm hits, duration, and oldest pending age.

### Phase B — Cold Claude aggregate resilience

- [ ] Prevent restart/reactivation from synchronously rescanning a multi-gigabyte
  transcript from byte zero.
- [ ] Prefer a ClaudeVille-owned compact checkpoint containing file identity,
  size/guard signature, usage totals, and bounded launch summary; validate it
  before resuming from the stored offset.
- [ ] If checkpoint durability cannot be made crash-safe in this package, enforce
  byte/time budgets and return explicit partial/unknown totals while a
  concurrency-one background index advances.
- [ ] Cancel/deprioritize work when a session leaves the active set. Keep source
  provider files strictly read-only.

### Phase C — Conditional P3 whole-file caches

- [ ] Byte-bound Gemini's whole-history cache and compute all consumers from one
  compact pass.
- [ ] Incrementally parse growing Codex/Kimi session indexes with last-write-wins
  semantics instead of full read/split/parse on every signature change.
- [ ] Implement only after oversized fixtures demonstrate material savings;
  current local index files are small and no Gemini corpus was present.

### Acceptance

- [ ] Thousands of cold directories plus active sessions in old directories
  stay within the per-tick syscall/time budget and eventually reconcile all
  entries.
- [ ] One active Kimi child among thousands of stale children performs parsing
  proportional to active/fallback records with identical lineage/output.
- [ ] A large temporary OpenCode database returns the identical active set/order
  with materially fewer rows/time on the warm/change-only path.
- [ ] Restarting against a large/sparse Claude transcript reads guard+append
  rather than byte zero; append, truncate, rewrite, rotation, malformed, and
  oversized-line cases remain correct.
- [ ] Provider source directories/databases remain byte-for-byte unchanged.
- [ ] Adapter, warm-discovery, aggregate, watcher, and relationship smokes plus
  session-residency unit tests pass.

## Package 8 — Remove measured frame-loop and defensive allocation risks

**Findings:** CV2-PERF-008, CV2-HARD-002

**Owned paths:** `HarborTraffic.js`, `IsometricRenderer.js`,
`MovementSteering.js`, `AgentSprite.js`, `ActivityPanel.js`,
`claudeville/services/usageQuota.js`, focused World/application/service tests

### Measured World work

- [ ] Split Harbor animation advance from semantic reconciliation. Advance
  visuals per frame, but rebuild the source snapshot, crate/repo state, failed
  push state, and working count only on the existing 250 ms semantic tick or a
  relevant event.
- [ ] Reuse snapshot arrays/records and cached derived values. An unchanged
  source should not allocate a full new snapshot each frame.
- [ ] Replace the 1,001-alpha-per-color light-fade key space with cached base RGB
  parsing plus a visually tested bounded alpha representation. Avoid continuous
  FIFO eviction at the 1,024-entry limit.
- [ ] After the higher-impact packages, profile 50/80/100 agents before changing
  movement. If allocation remains material, use scalar/caller-owned steering
  outputs, numeric bucket identifiers, stable lane records, and intent-based
  route recomputation.
- [ ] Do not add another rain-specific optimization without a controlled paired
  profile. The loaded-host audit found trails dominant and rain faster than
  clear, so it does not support a new rain finding.

### Defensive hardening

- [ ] Validate ActivityPanel building keys against the configured World
  buildings, project only consumed scalar fields, and replace snapshots instead
  of merging arbitrary nested payloads into cumulative maps.
- [ ] Pause Dashboard/ActivityPanel periodic work while hidden instead of waking
  to return early, if the lifecycle change remains simple and measurable.
- [ ] Cap the usage-quota HTTPS response body, abort on overflow, and preserve
  the last good quota value.

### Acceptance

- [ ] Unchanged harbor semantic reconciliation is at most four times per second,
  not roughly once per rendered frame; visual animation remains frame-smooth.
- [ ] Light-fade cache evictions settle near zero under a fixed 60-second scene
  and color output passes day/night visual comparison.
- [ ] World update p50/p95 does not regress from the recorded baseline; movement
  changes are required only if profiling proves a gain.
- [ ] Unknown/oversized building payloads cannot increase ActivityPanel maps.
- [ ] Oversized/chunked/non-200 quota fixtures remain bounded and preserve
  fallback behavior.
- [ ] Harbor bounds, World state, movement, relationship, and browser lifecycle
  smokes pass.

## Package 9 — Release verification gate

Package 9 is mandatory after Packages 0–5. Packages 6–8 may land in the same
release only when their focused fixtures and ownership boundaries are complete;
do not let them delay the direct P0/P1 pressure fixes.

### Automated

- [ ] `npm run validate:quick`
- [ ] `npm run test:unit`
- [ ] `node scripts/smoke/adapters.mjs`
- [ ] `NODE_NO_WARNINGS=1 node scripts/smoke/relationship.mjs`
- [ ] `node scripts/smoke/tail-cache.mjs`
- [ ] `node scripts/smoke/claude-transcript-aggregate.mjs`
- [ ] `node scripts/smoke/codex-warm-discovery.mjs`
- [ ] `node scripts/smoke/watcher-runtime.mjs`
- [ ] `node scripts/smoke/watcher-topology.mjs`
- [ ] `node scripts/smoke/scoped-invalidation.mjs`
- [ ] New focused Chronicle, notification, trail, native-surface, provider,
  Git-worker, and WebSocket-delta unit/smoke fixtures
- [ ] `node scripts/smoke/world-state-bounds.mjs`
- [ ] `node scripts/smoke/harbor-traffic-bounds.mjs`
- [ ] `npm run world:validate-buildings`
- [ ] `npm run world:validate-terrain`
- [ ] `node scripts/smoke/browser-lifecycle.mjs --count=250`
- [ ] World profile at 13, 50, 80, and 100 agents with at least three
  repetitions per relevant case and host-load metadata
- [ ] Default 10-minute browser/30-minute server pressure soak after warm-up
- [ ] `git diff --check`

### Required pressure gates

- [ ] Physical watcher smoke targets the server PID and fails a deliberately low
  threshold.
- [ ] Forced-GC browser heap and server RSS satisfy both the existing absolute
  plateau limits and the new rolling-slope limits.
- [ ] Active World and suspended Dashboard satisfy their deduplicated native
  surface/asset byte budgets.
- [ ] Trail sample counts plateau under stationary and synthetic-hour cases.
- [ ] Oversized unchanged transcript fixtures parse once per signature.
- [ ] Unchanged Git fixtures launch zero processes after warm-up.
- [ ] No frame failure, unhandled rejection, console error, stale modal update,
  or owned desktop notification survives teardown.

### Manual browser/API

- [ ] Use a fresh current-code runtime on an isolated port; do not stop or replace
  the operator-maintained port-4000 server.
- [ ] Exercise World and Dashboard, repeated mode transitions, agent
  select/deselect, Chronicle/Changelog races, notifications, audio, context
  loss/recovery, and App reboot.
- [ ] Confirm `/api/providers`, `/api/sessions`, `/api/session-detail`,
  `/api/usage`, `/api/perf`, and WebSocket deltas.
- [ ] Compare day/night, clear/rain, selected trails, crowded agents, Dashboard
  avatars, and first World resume for visual regressions at a desktop viewport.
- [ ] Record server PID/RSS, browser native budgets, host load, test duration,
  and exact command lines in the release verification note.

### Release hygiene

- [ ] Re-run `git status --short` before edits, commits, and final handoff.
- [ ] Preserve unrelated work and keep each package's commit scoped to its owned
  paths.
- [ ] Do not update `CHANGELOG.md`, versions, tag, or push until a release push is
  explicitly requested.
- [ ] When pushing, follow the repository's named-release/hotfix rules and create
  the matching tag and GitHub release with no version gap.

## Explicit non-goals and deferrals

- Do not increase memory/cache limits to hide reparse churn.
- Do not rewrite the hand-written WebSocket protocol, SessionWatcher, App
  teardown, audio system, Pathfinder, particle system, or bounded Harbor state
  without a new failing test.
- Do not add a framework, worker database, bundler, transpiler, browser test
  framework, runtime dependency, or provider-side schema/index.
- Do not write to Claude, Codex, Kimi, Grok, Gemini, or OpenCode source data.
- Do not add mobile behavior, `@media` queries, or viewport shrinking.
- Do not optimize raw FPS from the high-load audit in isolation. Use named
  segments and paired, repeated cases.
- Do not sum overlapping native surface categories until the ownership registry
  deduplicates them.
- Keep `/api/tasks`, `/api/providers`, and `/api/perf` as the documented
  loopback diagnostic surfaces established by the prior completed plan.

## Areas verified healthy

These should remain unchanged unless a new focused test fails:

- WebSocket client cleanup, payload/backpressure limits, heartbeat, and
  reconnect ownership.
- Session residency TTL/count bounds and session-detail request/cache bounds.
- App teardown, store-drain ordering, Sidebar workflow pruning, Dashboard card
  and avatar removal, audio teardown, and context-loss recovery.
- Watch topology caps and shutdown cleanup.
- Pathfinder cache, particles, weather ripples, Harbor retained-state caps,
  crowd cooldown caps, and current movement pair-state cleanup.
- Building/terrain configuration and sprite manifest validation.

## Definition of done

- [x] Packages 0–3 and 5 are implemented with their focused tests and
  acceptance gates; Package 4's measured warm path is complete and its
  asynchronous cold worker is explicitly retained above.
- [x] Every P2/P3 finding is either implemented with evidence or retained here
  with its trigger and reason for deferral.
- [ ] The long pressure soak measures the correct processes and passes both JS
  and native-resource gates before a release push.
- [x] The incident is documented accurately: no claim that ClaudeVille caused
  the July 28 OOM, and no omission of its verified pressure risks.
- [x] Package 9's quick/current-runtime gate passes. The release-duration soak
  remains intentionally open because no release push was requested.
