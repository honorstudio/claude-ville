# Server event-loop starvation investigation

Status: ready  
Date: 2026-09-01  
Scope: read-only analysis of `claudeville/server.js` and `claudeville/services/`; adapter internals are treated as opaque callees except for registry/cache boundaries and child-process dispatch.

## Executive summary

1. The dark screen is server starvation: instant TCP connect plus 18–36.9s TTFB cannot be frontend rendering or ordinary static I/O.
2. A dirty update calls the synchronous all-provider scan on the HTTP thread; an isolated production-configured scan took 9.99–10.38s here.
3. Directory watch events and 30s reconciliation can invoke that scan twice back-to-back, predicting roughly 20s blocked periods and explaining the measured 18–23s stalls.
4. The 2s session-list TTL is timestamped at scan start, so a scan longer than 2s is expired before it returns; an immediate non-forced call was measured at 9.80s rather than hitting cache.
5. `markProviderDataDirty` invalidates the global all-provider list even for one provider/path, so dirty scoping does not prevent a full registry pass.
6. No callback re-enters while synchronous work runs, but there is no in-flight/generation guard; overdue interval/debounce callbacks run immediately after the block and can start another pass.
7. Static serving performs tiny synchronous path checks then an asynchronous read; measured p50 path checks were 0.021ms and p50 read completion was 0.182ms. Static requests are victims.
8. Recommended design: put collection in one coalescing `worker_thread`, serve the last snapshot on the HTTP thread, and add dirty-generation coalescing/adaptive backoff; then make scanning incremental.

## Evidence

### 1. Measured symptom and isolated reproduction

The supplied live probes show a repeating unavailable/available server, not a slow asset:

- `css/reset.css`: 18.195s TTFB with a 0.287ms connect, followed by 0.6–1.0ms requests.
- 300ms sampling: 23.546s, then 7.404s, about 3.3s of sub-millisecond service, then 17.859s.
- `index.html`: 36.9s; `/api/sessions`: 11.0s/420KB; `/api/providers`: 3.65s; `/api/usage`: 7.5s.
- The observed blocked fraction is approximately `18 / 21 = 85.7%` of wall time.

The maintained server was not listening when this investigation ran, and it was deliberately not restarted. Read-only isolated Node processes imported the same modules and scanned the same provider data:

| Probe | Result |
| --- | ---: |
| `require('./claudeville/server')`, without listening | 28.558ms |
| Production-configured `getAllSessions(120000, {force:true})` | 10,186.814ms |
| Immediate `force:false` call in the same process | 9,804.027ms |
| Next `force:true` call | 10,376.554ms |
| Separate production-configured scan | 9,987ms, 10 sessions |
| Direct opaque provider calls in one pass | Claude 35.8ms; Codex 594.7ms; Grok 75.6ms; Kimi 4.7ms; OMP 10,261.3ms |
| Same direct pass, total listed provider time | 10,972.1ms; OMP was 93.5% |

There was run-to-run variability: an earlier cold forced registry pass took 4,263.268ms, its immediate non-forced successor 3,747.098ms, and a second forced pass 3,862.757ms. In that run a direct adapter pass spent 4,342.542ms in OMP. The important invariant is not the precise adapter cost (owned by the adapter investigation), but that the server invokes a multi-second synchronous callee on its only HTTP/event-loop thread. Two such calls predict 7.5–20.8s locally; the supplied 18–23s live stalls lie directly in that range.

The production-configured watch descriptor snapshot contained 51 raw descriptors, 30 canonical descriptors (19 stable, 11 dynamic), and 16 active probes. With no sessions it still contained 19 stable descriptors and 7 stable probes.

### 2. Exact scheduler and synchronous call chains

#### Fixed scheduler path

`startFileWatcher` installs one 2s `setInterval` at `claudeville/server.js:2246-2259`. Every callback executes, in order:

1. `runActiveWatchProbes()` (`server.js:2251`) when clients exist. It synchronously `statSync`s every selected probe, up to 1,024 (`server.js:1879-1897`, especially `1872`). A changed probe calls `markProviderDataDirty` (`1893`).
2. `runRecursiveWatchFallbackChecks()` (`2252`) regardless of client count. Every eligible fallback is synchronously walked with a shared 2,000-entry budget (`1586-1631`): `readdirSync` at `1510` and `statSync` at `1527`, plus root/file stats at `1565`/`1575`. Changes or the 60s max age mark data dirty and schedule a broadcast (`1607-1616`).
3. `scanActiveProjectGitState()` (`2253`) when clients exist and 5s have elapsed (`2198-2202`). It scans up to 40 active projects. Each project resolves `.git` synchronously (`2121-2135`), stats state files (`2138-2145`), and walks four ref/log trees (`2148-2191`). `GIT_STATE_MAX_REF_ENTRIES=800` applies separately to each tree, so the theoretical ceiling is 3,200 directory entries per project, not 800 globally. Changes invalidate the session list (`2221-2229`).
4. Every 30s, `reconcileWatchTopology()` (`2254-2255`, `2233-2244`). With clients it marks a global reconciliation dirty (`2237`) and calls `getAllSessions(..., {force:true})` synchronously (`2238`). It then rebuilds watcher topology (`2241`).
5. With clients, `broadcastUpdate()` runs (`2256-2257`). If dirty, it calls `collectBroadcastPayload` (`1264-1273`) -> `collectSessionsForClients` (`1256`) -> `getAllSessions` (`1175-1178`) and then teams/usage (`1257-1258`).

The registry boundary is concrete: `getAllSessions` loops every available adapter and calls each `adapter.getActiveSessions` synchronously (`claudeville/adapters/index.js:295-348`), then runs Git enrichment and sorting (`349-359`). This is the boundary at which the server enters the adapter-owned synchronous filesystem/parsing work. The server cannot accept an HTTP request, run a static-file callback, or send a WS frame until the call returns.

#### Watch-event/debounce path (the likely repeating ~18–20s chain)

For directory changes, the chain is:

```text
fs.watch callback (server.js:1813)
  -> handleWatchEvent (1763-1779)
     -> debouncedWatchRefresh (1776, 1361-1366; +100ms)
     -> markWatchDescriptorDirty (1777, 1451-1453)
        -> markProviderDataDirty (1119-1155)
           -> invalidateSessionCaches (1149; adapters/index.js:424-475)
     -> debouncedBroadcast (1778, 1356-1359; +100ms)

refresh timeout
  -> refreshWatchPaths (1781-1791)
     -> getAllSessions(..., force:false) (1786) [full synchronous scan]

broadcast timeout, already overdue
  -> broadcastUpdate (1264-1354)
     -> collectBroadcastPayload (1246-1262)
        -> collectSessionsForClients (1175-1178)
           -> getAllSessions(..., force:false) [second full synchronous scan]
```

The refresh timeout is registered before the broadcast timeout for a directory event. When the first scan lasts longer than the 2s cache TTL, the second overdue timeout sees an expired list and scans again. With the measured 9.8–10.4s scans, this path occupies the loop for about 20s. A file-only `change` normally schedules only the broadcast and therefore one scan. Rename/directory changes also rebuild watch topology.

Adapter Git-worker completion follows another dirty path: the server configures the worker callback at `server.js:2340-2351`; completion calls `markProviderDataDirty` and `debouncedBroadcast`, again reaching the full registry scan.

#### Reconciliation double scan

Reconciliation forces scan A at `server.js:2238`, then the same interval callback calls `broadcastUpdate` at `2257`. Scan A stores its registry timestamp using the `now` captured at function entry (`adapters/index.js:296`, assigned at `356`). If scan A exceeds the 2s TTL, broadcast scan B at `server.js:1256/1176` misses immediately. Thus a 30s reconciliation with clients can block for approximately two scan durations. `lastReconciliationAt` is assigned the timestamp captured before scan A (`server.js:2234`, `2242`), so the expensive duration counts against the next 30s period.

### 3. Cache and force semantics

`markProviderDataDirty` does **not** itself rescan, and a quiescent 2s poll does not rescan: `broadcastUpdate` returns when `providerDataDirty` is false (`server.js:1265-1267`). However, every accepted dirty mark calls `invalidateSessionCaches` (`1149`). The registry always zeros the global list cache, threshold, and sessions (`adapters/index.js:424-432`) even when the descriptor identifies one provider, session, transcript, or project. Adapter-local invalidation is scoped later (`460-469`), but the next list collection still loops all adapters. Therefore an active transcript/watch stream makes most effective polls full rescans even though the interval alone does not.

Dirty coalescing is only a 100ms same-descriptor window (`server.js:1123-1131`). Different paths/providers are distinct keys, and any later event invalidates again. It is debounce, not a scan-generation/in-flight guard.

The session-list cache TTL is 2,000ms (`adapters/index.js:49-52`). It checks age at `295-299`, but stores the entry-time timestamp after collection at `356`; it does not store completion time. This exactly explains the measured immediate non-forced misses after 3.7–10.2s scans. Even if changed to completion time, `markProviderDataDirty` would still clear it; both defects need addressing.

Forced full-list paths are:

- First WS initial data, or initialization without a reusable broadcast state: `collectSessionsForClients({force:true})` at `server.js:954-983`, specifically `970`.
- 30s reconciliation with clients: `getAllSessions(..., {force:true})` at `2238`.
- `/api/sessions?force=true`: parsed at `276-280` and passed through `1176`.

Normal interval/debounced broadcasts use `force:false`, but commonly miss because of invalidation or scan-start TTL expiry. `refreshWatchPaths` also uses non-force (`1786`). Startup stats use non-force on a cold cache (`233-239`).

Teams have a separate 5s cache (`server.js:1083-1090`, `1181-1192`). `markProviderDataDirty` makes it dirty only for teams, Claude discovery/metadata/reconcile, or global reconcile (`1133-1138`). WS initialization explicitly defeats it with `force:true` (`971`). Measured direct `getTeams()` calls were 0.093ms and 0.024ms here, so teams are not the observed dominant cost.

`DELTA_SNAPSHOT_INTERVAL_MS=20s` is not a timer and does not make data dirty. It is checked only after a dirty payload was already collected (`server.js:1302-1307`) to choose patch versus full frame. It cannot initiate the periodic starvation.

### 4. Re-entry, overdue work, and overrun behavior

There is no `broadcastInFlight`, scan promise, dirty generation, or scheduler-running flag around `broadcastUpdate`, `refreshWatchPaths`, reconciliation, or the interval callback (`server.js:1246-1366`, `1781-1868`, `2233-2259`). Current full scans are synchronous, so JavaScript cannot literally enter the same callback concurrently. That prevents simultaneous re-entry but does not prevent sequential duplication.

Node v24.16.0 was measured with a 100ms interval whose first callback blocked for 550ms. Callback starts occurred at 102, 652, 753, 854, and 955ms. In other words, missed occurrences did not form a five-callback burst; one overdue interval callback ran immediately, then normal cadence resumed. Applied here, an 18s pass on a 2s interval does not queue nine interval calls, but the next interval is immediately eligible. Separately overdue callbacks—watch events, both 100ms debounce timers, the 5s perf timer, Git worker completion, HTTP callbacks—also get their turn after the block. Any one that dirties data can start another full pass.

Quantitatively, a single 18s callback consumes nine nominal 2s periods and gives the HTTP server zero execution opportunities during those 18s. With the observed roughly 3s responsive gap, utilization by this work is about 86%. There is no adaptive backoff based on the measured scan duration.

### 5. Zero-client behavior and `WATCH_ZERO_CLIENT_GRACE_MS`

Client guards exist but are incomplete:

- `broadcastUpdate` returns with zero clients (`server.js:1265`), active probes return (`1880`), and active-project Git scanning returns (`2199`). Reconciliation skips its forced session scan with zero clients (`2236-2240`).
- The 2s scheduler itself never stops (`2246-2259`). Recursive fallback walks have no client guard and continue (`1586-1631`). Every 30s, zero-client reconciliation still calls `refreshWatchPaths` with an empty session array (`2241`), which calls every available adapter's `getWatchPaths` but not `getAllSessions` (`1783-1790`).
- Stable watchers remain installed. Their events still call `markProviderDataDirty`, globally clearing the list cache, and schedule no-op broadcasts. Directory events can still refresh stable topology.
- When the final socket is removed (`805-815`), `onLastWebSocketClient` waits 15s by default and then disables only dynamic watchers (`1910-1918`, constant at `84`). During that grace, `dynamicWatchersEnabled` remains true, so a directory-triggered `refreshWatchPaths()` can still call `getAllSessions` at `1786` despite zero clients. After the grace it uses an empty session snapshot. The grace is not a scheduler shutdown or a general zero-client work gate.
- Startup always performs a cold session scan and installs watchers regardless of client count (`server.js:2371-2377`).

Thus the worst broadcast/probe/Git work is client-gated after the grace, but the process is not idle at zero clients. Fallback scanning and startup can still block, and dirty invalidations accumulate for the next client.

### 6. Static files and API attribution

Static request dispatch is `server.js:2281-2305`. `serveContainedFile` performs synchronous `existsSync`, `statSync`, and `realpathSync` checks (`526-565`), but file contents are read with asynchronous `fs.readFile` (`578-597`). Against the exact `claudeville/css/reset.css` file, 1,000 isolated `exists+stat+realpath` samples measured p50 0.0210ms, p95 0.0735ms, p99 0.1878ms, max 0.6626ms. One hundred sequential asynchronous reads measured p50 0.1824ms, p95 1.6325ms, max 4.0211ms.

Those checks could themselves pause on a pathological filesystem, but the supplied repeated sub-millisecond HTTP samples prove this file path is fast whenever the loop is available. The 18–23s TTFB occurs before the JS request/read callback can run. Static serving is a victim, not the cycle generator. Converting only static serving to promises would not fix starvation elsewhere.

API classification:

- `/api/sessions` is both victim and contributor: it synchronously calls the full list scan (`server.js:276-281`) and then synchronously serializes the 420KB payload (`122-125`). Its 11.0s result aligns with the isolated 9.8–10.4s scan.
- `/api/providers` only checks adapter availability/health (`387-401`); its 3.65s is predominantly time spent waiting for the loop.
- `/api/usage` can do synchronous history tail reads on a cold 30s stats cache (`services/usageQuota.js:179-238`, reads at `39-119`) and synchronous credentials/stats JSON reads (`123-142`, `188-195`). Here, cold `fetchUsage()` measured 27.126ms and warm calls 0.079/0.018ms. Its reported 7.5s is therefore primarily a victim in the measured environment, though a large/slow `history.jsonl` can make it an independent contributor once every 30s.
- Broadcast hashing/diffing/serialization (`server.js:1274-1341`) is synchronous and scales with the payload, but it occurs after collection and cannot explain long static TTFB with zero opportunity to enter the handler. It should be moved with snapshot construction if profiles later show it material.

### 7. Child processes and Git on the hot path

There is no `execSync`, `execFileSync`, or `spawnSync` in `server.js` or `services/`. `usageQuota.init()` uses asynchronous `execFile('claude', ['auth','status'])` once at startup (`services/usageQuota.js:152-175`, called at `server.js:2374`).

Two Git mechanisms matter:

1. The server-owned 5s active-project signature scan uses only synchronous filesystem calls; it does not spawn Git (`server.js:2121-2231`). It can still be expensive on NFS because it walks refs/logs on the main thread.
2. The adapter registry has a synchronous `execFileSync('git', ...)` helper (`adapters/index.js:208-213`) used by repository discovery (`272-289`), reached by every cache-miss list scan at `349`. Repository discovery is separately cached for 5 minutes (`54-57`, `272-289`). In a production-configured three-scan probe, exactly one synchronous Git call occurred, taking 25.102ms; the counter stayed at one thereafter.

Before listening, the server enables Git enrichment's asynchronous worker (`server.js:2340-2352`). With it enabled, the enrichment functions choose their async/cache-backed variants (`adapters/gitEvents.js:2257-2260`, `2386-2393`) and worker commands use asynchronous `execFile` (`503-509`). Therefore synchronous enrichment commands seen when importing the adapter registry alone are not representative of the live server. Adapter-internal subprocesses beyond this registry boundary belong to the adapter investigation.

### 8. Startup and first-byte ordering

The startup order is:

1. Module evaluation loads all adapters/services (`server.js:7-31`) and synchronously realpaths the static root (`42-43`). Isolated full server-module import measured 28.558ms.
2. `startServer` enables the async Git worker (`2338-2352`) and calls `server.listen` (`2353`). No `getAllSessions` runs before this call, so the server bind itself is not waiting on the multi-second scan.
3. In the listen callback it enumerates active providers (`2358-2367`), starts perf sampling (`2370`; sampling body at `2037-2118`), and schedules bootstrap for 25ms later (`2371-2377`).
4. Bootstrap calls `printStartupStats` -> cold `getAllSessions` and `getAllWatchPaths` (`233-267`, called at `2373`), initializes usage asynchronously (`2374`), installs watch topology/scheduler (`2375`, `2246-2260`), then starts WS heartbeat (`2376`).

Consequently there is a short opportunity to serve before the 25ms bootstrap, but once the startup scan begins no first byte can be produced until it returns. This is a post-listen bootstrap stall, not pre-listen startup latency.

The first WS client adds another pair of opportunities for duplication. After the 101 response, `onFirstWebSocketClient()` synchronously enables dynamic watchers and calls `refreshWatchPaths()` (`server.js:679-695`, `1900-1908`), which calls a list scan. A 100ms timer then calls `sendInitialData`, which forces another full scan (`690-695`, `954-983`). If the first scan exceeded 2s—as measured—the forced second scan necessarily runs again. Browser asset requests whose callbacks become ready during either scan wait, producing the dark screen even though rendering is smooth later.

## Ranked remediations

The recommendation is a staged combination: immediately remove duplicate work and add a scan-generation guard, then make a single worker thread the owner of provider collection. Async filesystem conversion and incremental indexes should reduce worker cost, while bounded main-thread probes prevent the smaller server-owned walkers from recreating starvation.

| Rank | Exact location and change | Expected latency win | Effort / risk | Visual consequence | Verification |
| --- | --- | --- | --- | --- | --- |
| 1 | `server.js:1119-1155`, `1246-1366`, `1781-1791`, `2233-2259`; `adapters/index.js:295-359`, `424-432`. Add a monotonic dirty generation and one scan coordinator. Coalesce refresh+broadcast into one collection result per generation, never rescan while that snapshot is current, set cache age at completion, and carry a single follow-up dirty generation rather than one job per event. Add adaptive backoff: no fixed follow-up sooner than a bounded function of the last scan duration, except an explicit user force. | Removes the proven two-pass directory/reconciliation/first-client pattern: approximately 50% reduction in those blocked bursts (about 20s -> about 10s in isolated data; about 36s -> about 18s in the supplied worst case). It does **not** make one scan nonblocking. | Low-medium effort; low data risk if generation semantics are tested. Risk is briefly coalescing a change that arrives during collection; the saved follow-up generation must guarantee eventual refresh. | Initial state may be up to one coalescing window older, but the page can become responsive much sooner. No rendering change. | Unit-test a fake 18s collector with refresh+broadcast+dirty events: one active job, at most one follow-up, newest generation delivered. Instrument scan start/end/generation. Repeat 300ms CSS probe and assert no paired full scans in `/api/perf` telemetry. |
| 2 | `server.js:1175-1178`, `1246-1345`, `1781-1791`, `2233-2259`, startup at `2338-2377`. Move `getAllSessions`/snapshot construction to one `worker_thread`; the main thread sends dirty descriptors and always serves the most recent immutable snapshot. Bound the worker queue to one running + one coalesced-latest request. Do not make HTTP or WS initialization await a fresh scan; expose `scanning/staleAt` metadata. | This is the decisive TTFB fix: the measured 9.8–10.4s CPU/synchronous scan no longer blocks HTTP. Based on isolated static measurements, static TTFB should remain in the millisecond range during scans; target p95 <100ms and max <1s. | Medium-high effort; medium risk around worker lifecycle, serialization cost, cache ownership, and shutdown. A single worker preserves adapter singleton/cache assumptions better than a pool. Transfer/minimize payloads to avoid 420KB cloning becoming material. | The shell appears immediately. On a truly cold start it may briefly show “Scanning sessions…” or a last-known snapshot instead of a dark screen; data then updates atomically. | Stress with continuous provider writes while curling CSS every 300ms. Require event-loop delay p99 <100ms, no 5s+ TTFB, one worker job at a time, correct WS sequence/delta recovery, and clean shutdown. Compare snapshot hashes with current synchronous output. |
| 3 | `server.js:1119-1155`, `1423-1453`, `1763-1791`; registry invalidation at `adapters/index.js:424-475`. Make rescans dirty-only/incremental: retain an all-provider aggregate, rescan only the provider named by the descriptor, and key transcript/discovery indexes by `(path, inode, mtimeMs, size)`. Rebuild watcher topology only for discovery/directory topology changes, not ordinary transcript content changes. | Changes steady-state work from all files/all providers to changed provider/path. Expected large duty-cycle reduction; exact win depends on adapter-owned indexes and must be measured. It also prevents one chatty provider from repeatedly paying the 10s opaque provider scan of another. | High cross-adapter effort; medium-high correctness risk for rename, truncation, clock granularity, symlinks, and missed events. Keep periodic bounded reconciliation as a safety net. | Fresher updates under load and fewer freezes. A missed invalidation could temporarily show stale status, so display snapshot age and preserve reconciliation. | Mutation matrix in temporary fixtures: append, rewrite same size, truncate, rotate, rename, directory create/delete, mtime collision. Compare incremental aggregate to forced full scan and track full-scan rate/hour. |
| 4 | Server-owned walkers at `server.js:1497-1631`, `1870-1897`, `2121-2231`. Convert these to async `fs.promises` and/or cooperative batches with a strict elapsed budget (for example 5–10ms) per event-loop turn. Persist cursor state across turns; cap Git refs globally per cycle rather than 800 per tree/project. | Prevents probe/fallback/Git-state traversal from monopolizing the loop; impact is bounded by whether fallbacks or many active repos exist. It does not fix CPU-heavy adapter parsing by itself. | Medium effort; medium race risk if files change mid-scan. Async calls may increase total scan wall time and NFS concurrency; bound concurrency. A time budget cannot bound one slow synchronous syscall, so promises or the worker are still required. | Git/watch-driven updates can arrive over several ticks rather than atomically; snapshots should publish only after a complete generation. | Fixture with >2,000 fallback entries and 40 repos; verify each main-thread slice stays under budget, concurrency is bounded, final signatures equal the synchronous implementation, and static p99 remains low. |
| 5 | `services/usageQuota.js:38-119`, `123-142`, `179-238`; eventual adapter-owned filesystem calls behind `adapters/index.js:321`. Convert cold reads/walks to `fs.promises` and parse large files incrementally with explicit yields. Make server collection APIs async only after rank 1's in-flight guard exists. | Makes I/O waits yield to HTTP. Useful for NFS and the cold usage endpoint, but incomplete because measured opaque adapter time includes substantial CPU/parsing and monolithic synchronous APIs. | High breadth; medium-high regression risk. Async conversion without an in-flight guard would allow the 2s interval to launch overlapping scans and make load worse. | More responsive UI but possibly longer elapsed time until fresh data; serve stale snapshot while refreshing. | Before/after event-loop delay plus wall scan time; assert maximum concurrency one and identical session/usage JSON. Simulate delayed reads and verify HTTP remains responsive. |

### Architectural option verdicts

- **Worker thread: recommended primary architecture.** It is the only option listed that isolates both synchronous I/O and CPU-heavy parsing without first rewriting every adapter. Use one worker, not a pool, because caches and filesystem discovery are stateful and scans must coalesce.
- **In-flight guard + adaptive backoff: required immediately and as a prerequisite for async work.** In the current synchronous design it does not interrupt a single block, but it prevents proven sequential duplication and future async overlap.
- **Incremental/mtime dirty-only scan: recommended next for throughput.** It reduces worker wall time and CPU, but correctness is more complex; retain a slow reconciliation.
- **Async `fs.promises`: worthwhile but not sufficient alone.** It lets the loop breathe during I/O, yet JSON parsing, sorting, normalization, hashing, and any remaining sync callees still block. A wholesale async migration also has a large API surface.
- **Cooperative chunking: use for server-owned walkers and CPU loops, not as the sole adapter solution.** Existing adapter calls are monolithic; a server wrapper cannot yield inside them. A synchronous NFS syscall can also exceed the tick budget by itself.

## Ruled out or bounded

- **Frontend/canvas rendering:** ruled out as the cause of initial darkness because the server has not delivered bytes during the measured TTFB. The reported 60 FPS after load is consistent with this.
- **Static file size/read:** ruled out as the long-cycle cause by asynchronous content reads, sub-millisecond fast samples, and isolated millisecond/sub-millisecond measurements.
- **A backlog of every missed `setInterval` occurrence:** ruled out by Node v24.16.0 measurement. There is one immediately overdue tick, not nine queued copies after an 18s block. Sequential work from other timers/events still accumulates.
- **The 20s delta snapshot interval:** ruled out as a trigger; it only selects full versus patch after an already-dirty collection.
- **WS frame backpressure:** bounded by latest-frame queuing and socket removal (`server.js:884-930`) and occurs after the expensive collection. It does not delay unrelated static requests before a frame exists.
- **Teams cache:** direct calls were sub-millisecond here. Its forced first-client read is poor cache hygiene but not the measured dominant cost.
- **Perf sampling on this host:** macOS returns immediately from the Linux `/proc` watcher sampler (`server.js:2004-2006`); the remaining 5s metrics are in-memory. On Linux, synchronous `/proc/self/fdinfo` reads at `2013-2024` are a small additional main-thread risk and should join the async/worker cleanup.
- **Synchronous child processes in `server.js`/`services`:** none. The server enables async Git enrichment before scanning. The registry's separately cached 5-minute repository discovery has one synchronous Git call, measured at 25.102ms, not 18s.

## Acceptance targets after remediation

1. During a forced full scan and continuous file changes: static CSS p95 TTFB <100ms, maximum <1s; no multi-second black window.
2. Exactly one collection job active, at most one coalesced follow-up generation, and no same-generation refresh+broadcast duplicate.
3. Event-loop delay p99 <100ms and utilization no longer near the measured ~86% blocked duty cycle.
4. First HTTP shell byte is independent of startup discovery; first WS response is immediate from stale/empty snapshot with an explicit scanning flag.
5. Incremental results match a forced full-scan oracle across append/truncate/rename/delete and Git-ref changes.
