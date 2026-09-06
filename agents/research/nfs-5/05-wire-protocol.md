# Wire protocol and client-ingestion investigation

Status: ready — read-only investigation, 2026-09-01

## Executive summary

- The retained live snapshot is **859,135 B for 21 sessions**, versus the operator's earlier **420,164 B** response; payload growth is real and already doubled.
- `gitEvents` is **828,493 B (96.43%)**: 974 serialized rows but only 90 unique event IDs; about **688,536 B** is repeated event data copied across sessions.
- Removing `gitEvents` from the roster makes the measured response **30,621 B** (96.44% smaller). No transcript arrays, base64 blobs, or git diffs were found.
- Deltas are genuine, but not guaranteed: unchanged polls send nothing; continuous clean changes yield about nine deltas per 20-second full snapshot, while reorder/500-op/size guards and resyncs cause extra full frames.
- Boot downloads and ingests the REST roster, then opens WebSocket and immediately receives substantially the same full roster again: **1.72 MB** for the measured dump before framing/teams, or **840 KB** using the supplied 420 KB observation.
- Every accepted WS delta is expanded back into a full snapshot and all sessions are re-ingested. Changed agents synchronously fan out through roughly 18 `agent:updated` listeners; several rescan all agents, creating O(n²) work in a broad update.
- Chronicle persistence is not an unbounded synchronous localStorage parse: IndexedDB events are capped at 20,000/14 days, today's replay is cursor-folded, and SpendLedger retains five minutes of samples. Boot-time prune/replay are asynchronous.
- Highest-value fix: stop embedding project-wide git history in every session; send a compact roster and fetch/deliver a deduplicated project event feed separately.
- HTTP responses and WS frames are uncompressed. Built-in async gzip is a useful REST mitigation; hand-implementing `permessage-deflate` is not justified before fixing the shape and duplication.

## Measurement provenance and method

The requested endpoint was retried twice with generous limits, but `localhost:4000` refused the TCP connection (HTTP 000); the server was not started or restarted because the investigation explicitly forbids that. A real, pre-existing `/tmp/claudeville-sessions.json` captured at **2026-09-01 15:27:33 +0200** was therefore analyzed. It is 859,135 B and contains 21 sessions. The operator-supplied 420,164 B measurement is retained as the earlier comparison point; its response body was not available, so field percentages are not projected onto it.

The throwaway walker is `/tmp/analyze-claudeville-sessions.mjs`; its output is `/tmp/claudeville-sessions-analysis.json`. It recursively aggregates `JSON.stringify` byte length by normalized key path, aggregates exclusive per-session field bytes (including field names), lists the largest strings, and measures local gzip/Brotli sizes. Child-path figures below overlap their parents by design; the per-session-field table is the non-overlapping attribution.

## Measured payload anatomy

### Whole response

| Measure | Bytes | Share / implication |
| --- | ---: | --- |
| Raw response | 859,135 | 21 sessions; 40,911 B/session average |
| `sessions` value | 859,085 | 99.994% of response |
| `gitEvents` session fields, including keys | 828,493 | **96.43%** |
| Response with all `gitEvents` fields removed | 30,621 | **96.44% smaller** |
| Raw gzip level-default result | 142,543 | 16.59% of raw; **6.03× smaller** |
| Raw Brotli level-default result | 29,076 | 3.38% of raw; diagnostic only, not a recommendation for synchronous compression |
| Git rows / unique IDs | 974 / 90 | Approximately 10.8 serialized copies per unique ID |
| Approximate duplicate git bytes | 688,536 | Difference between all event rows and one row per ID |

The earlier operator observation was 420,164 B. The retained live dump is **438,971 B larger (+104.47%)**. This is consistent with git history/churn growth, not agent-count-sized roster metadata.

### Top cumulative serialized key paths

| Path | Bytes | Occurrences | Notes |
| --- | ---: | ---: | --- |
| `$.sessions` | 859,085 | 1 | Nearly the whole response |
| `$.sessions[]` | 859,063 | 21 | All session objects |
| `$.sessions[].gitEvents` | 828,241 | 21 | Value bytes; field-name-inclusive total is 828,493 B |
| `$.sessions[].gitEvents[]` | 827,245 | 974 | Event objects |
| `...gitEvents[].command` | 153,367 | 974 | Raw shell commands; largest single command 2,389 B encoded |
| `...gitEvents[].label` | 81,281 | 943 | Commit labels often duplicate text already in `command` |
| `...gitEvents[].project` | 41,882 | 974 | Same long project path repeated per row |
| `...gitEvents[].sha` | 39,606 | 943 | Full SHA repeated across sessions |
| `...gitEvents[].stderr` | 32,748 | 31 | Largest string 6,060 B encoded |
| `...gitEvents[].id` | 30,132 | 974 | Repeated event identity |
| `...gitEvents[].sessionId` | 26,639 | 974 | Often repository-session identity, repeated per row |
| `...gitEvents[].sourceId` | 20,795 | 974 | Repeated provenance |
| `...gitEvents[].source` | 20,299 | 974 | Repeated provenance |
| `...gitEvents[].commandHash` | 17,532 | 974 | Second identity beside ID/SHA |
| `...gitEvents[].ts` | 12,662 | 974 | Timestamp |
| `...gitEvents[].completedAt` | 12,259 | 943 | Second timestamp |
| `...gitEvents[].upstream` | 12,259 | 943 | Repeated branch metadata |
| `...gitEvents[].comparisonRef` | 12,259 | 943 | Repeated branch metadata |
| `...gitEvents[].type` | 7,792 | 974 | Event type |
| `$.sessions[].lastToolInput` | 5,896 | 21 | Live command/tool input, genuinely consumed |

The exact exclusive `gitEvents` field contributions start with `command` 163,107 B, `label` 88,825 B, `project` 51,622 B, `sha` 45,264 B, `sessionId` 38,327 B, `id` 35,002 B, and `stderr` 33,027 B (these include JSON keys). Eight sessions carry one byte-identical git array; across the 20 sessions in the same project there are only nine distinct arrays. A project-scoped event feed would eliminate the dominant cross-session duplication without deleting the feature.

No `messages`/transcript history array exists in this payload. There are 17 non-null `lastMessage` values (1,900 B as a session field), one non-null `dialogue` (999 B total field), and zero `sendMessages` rows. A scan of 14,786 strings found zero long base64-shaped values and zero diff-hunk/diff-header candidates. Thus the bloat is verbose, duplicated git history—not full chat transcripts, binary blobs, or patches.

## Fields shipped but unread

The browser's roster normalization is centralized in `AgentManager._sessionToAgentPayload`; status fallback additionally reads `status`, `lastActivity`, `turnState`, `waitReason`, `lastTool`, `lastMessage`, and recent git failures. Searches across `claudeville/src/` show these measured session fields never enter the client state:

| Session field | Measured bytes | Why it is dead on this contract |
| --- | ---: | --- |
| `spriteId` | 680 | Client recomputes visual identity from model/provider/effort; no session read |
| `displayModel` | 554 | No client read |
| `estimatedCost` | 515 | Client computes `Agent.cost` from token counters/model/provider |
| `modelColor` | 462 | No client read; client visual identity owns color |
| `pendingSince` | 348 | No client read; `awaitingSince` is used instead |
| `underlyingProvider` | 166 | No client read |
| **Total** | **2,725** | Only 0.32% of this response: safe, but not the main win |

REST envelope `count` and `timestamp` are also discarded because `ClaudeDataSource.getSessions()` returns only `data.sessions`; together their values are 15 B plus keys/punctuation. Full WS `timestamp` is passed through but is not used by `AgentManager` or the App snapshot observer; `seq` is required for delta correctness.

The individual git-event properties are not confidently dead: `GitEventIdentity`, Harbor traffic, Chronicle, biography/affinity, monument, mood, search, and status code collectively read nearly every measured property. The free win is deduplication and separation by project/event identity, not blindly deleting those properties. Raw `command` plus `label`, and `ts` plus `completedAt`, are candidates for contract consolidation, but require feature-by-feature verification.

## WebSocket protocol, snapshots, and steady-state bytes

### Contract

| Direction | Type/frame | Meaning |
| --- | --- | --- |
| Client → server | `hello { deltas: true }` | Enables delta frames for this socket; legacy clients remain full-only |
| Client → server | `resync` | Requests a fresh `init` after missing/bad baseline |
| Client → server | `ping` text message | Server replies with JSON `pong`; not the normal heartbeat path |
| Server → client | `init` | Full `{sessions, teams, usage, seq, timestamp}` |
| Server → client | `update` | Full changed state |
| Server → client | `update-delta` | `{baseSeq, seq, patch, timestamp}` with add/replace/remove JSON-Patch subset |
| Server → client | RFC 6455 ping control frame | Every 30 seconds; browser handles pong at protocol level |

There is no WebSocket extension negotiation and `createWebSocketFrame` always emits an uncompressed FIN frame. Payloads over 65,535 B add only a 10-byte WS header.

### Do deltas work?

Yes, conditionally:

1. The 2-second timer calls `broadcastUpdate`, but it returns immediately when no client exists or `providerDataDirty` is false.
2. Even after a dirty mark, a SHA-1 over `{sessions,teams,usage}` suppresses structurally unchanged data.
3. A changed state becomes a JSON patch only when a baseline exists, the last full is under 20 seconds old, the patch has at most 500 ops, and its serialized bytes are smaller than the full state.
4. Activity-sorted arrays are diffed by numeric index. Reorders can turn one logical move into many field replacements, exceed 500 ops, and force a full frame.
5. A full frame is also forced on initial connection, resync/baseline mismatch, the first changed broadcast after the 20-second floor, and any patch failure/size loss.

Therefore “every poll sends 420 KB” is ruled out. Under continuous changes at exactly 2-second cadence, the best count ratio is approximately **9 delta frames : 1 full frame** after initialization. The actual byte ratio cannot be recovered while the server is down because `/api/perf` records mode/op count but not serialized frame bytes, and no WS capture was present. Fulls may dominate when session reordering or widespread duplicated-git changes trip the guards.

### Bytes per second per connected client

| Scenario | Supplied 420,164 B snapshot | Retained 859,135 B snapshot |
| --- | ---: | ---: |
| Calm/unchanged | 0 B/s application data | 0 B/s application data |
| Continuous changes, every update forced full (2 s) | 210,082 B/s | 429,568 B/s |
| Continuous changes, only 20 s periodic full floor | 21,008 B/s + delta bytes | 42,957 B/s + delta bytes |
| Boot REST + immediate WS full | ≥840,328 B total | ≥1,718,270 B total |

These are per-client transfer rates, excluding small teams/usage/envelope/frame bytes. Server serialization is shared once per full-client fleet or delta-client fleet, but network and client parse/ingestion cost multiply by tabs. Legacy clients receive every changed update as full. Current `WebSocketClient` announces delta support immediately.

## Client ingestion cost

### Boot redundancy

The boot path awaits providers and then `AgentManager.loadInitialData()`, which concurrently fetches `/api/sessions` and `/api/teams`. Only after that completes does `SessionWatcher.start()` connect WebSocket. The server synchronously sends a full `init` during upgrade. Consequently a successful normal boot always performs:

`REST JSON parse → ingest every session → open WS → parse substantially identical full init → ingest every session again`

Usage is also fetched separately immediately before the WS `init` includes usage, although the HTTP request is asynchronous and does not gate the remaining boot. Teams are fetched with initial sessions and repeated in `init` as well.

### Every WS message

1. Browser creates a full string for `event.data`; `JSON.parse` runs on the main thread.
2. Full `init/update` replaces `_state`. Delta applies every op immutably, shallow-cloning every container on its path for every op; multiple ops against the same sessions/git array repeatedly clone it.
3. Delta is then expanded to a synthetic full `update` containing all sessions/teams/usage.
4. `SessionWatcher` invokes `AgentManager.handleWebSocketMessage`, which rebuilds team lookup, walks all `n` sessions, converts every session, scans every session's entire `gitEvents` once for verified outcomes, computes a bounded-but-nontrivial signature, then walks the entire world to find missing sessions.
5. A matching signature avoids `world.updateAgent`, but the pre-signature git scan/conversion still occurred. A changed signature emits one synchronous `agent:updated` event per changed agent.
6. The event bus calls listeners synchronously. There are roughly **18 registrations** for `agent:updated` in the shipped app. Several do whole-world work: `SpendLedger.sample()` scans all agents; TopBar renders on every agent event, calls `world.getStats()`, calls `SpendLedger.sample()` again, and computes rollups; Attention refresh scans actionable agents. Sidebar coalesces to one animation frame and Dashboard updates cards incrementally, but the central fan-out is not batched.

If `m` agents change, ingestion is O(n) plus O(total embedded git rows), followed by O(m × n) work in these listeners. With the measured project-wide git arrays, one new/replaced event can alter many session signatures, making `m ≈ n` and exposing the O(n²) path. ChronicleLog also loops each changed agent's full git array, although its dedupe set prevents duplicate writes.

Memory retention is larger than the wire alone: `WebSocketClient._state` retains the complete snapshot, while each `Agent` retains its `gitEvents` array. When an unchanged-signature full arrives, the WS state can hold the new arrays while Agents continue holding previous arrays. The debug estimator itself assumes roughly two bytes per serialized character, so the 859 KB state is approximately 1.7 MB of string storage before object/array overhead and Agent-retained history.

The user's separate 60 FPS observation does not rule this out: a stable render loop can hold 60 FPS between infrequent, bursty parse/diff/fan-out work, and the reported dark screen occurs before the WebSocket even starts.

## Persisted growth findings

| Area | Bound / boot behavior | Verdict |
| --- | --- | --- |
| Chronicle `events` | 14 local calendar days and 20,000 rows; free-form fields truncated to 200 chars | Bounded after prune |
| Chronicle boot replay | Cursor-folds today's events into sets; no second full-day array; `_seenGitEvents` shrinks 2,000 → 1,000 | Async and memory-bounded, but can scan a busy day |
| Chronicle UI page | Retains at most 500 newest events (default 100) while cursor-folding exact summary | Bounded |
| Pending arrivals | Map capped at 512 while replay completes | Bounded |
| SpendLedger samples | Prunes samples older than five minutes; `_lastSeen` removed with agents | Bounded in session |
| SpendLedger persistence | Reads exactly today's `meta` key at startup; one aggregate record per day | Boot read is narrow; old daily meta keys are never pruned |
| Affinities | Disk retention 30 days; preload limited to 1,024; memory cache 1,024 | Bounded |
| Biographies | Memory cache 256; IndexedDB biography records have no retention prune | Disk can grow with lifetime identities, but not parsed wholesale at boot |
| Other stores | manifests 1/7 days, monuments 30 days, trails 1 day; `auroraLog` and general `meta` are not pruned | Small unbounded tails deserve telemetry, not a primary dark-screen diagnosis |

`App._bootFoundation()` launches `open().then(prune())` at boot and schedules another prune every five minutes. The promise is tracked but **not awaited by the session boot path**. `ChronicleLog` replay and `SpendLedger.start()` are also asynchronous and not awaited before `_syncVillageSources`. IndexedDB uses structured cloning; there is no large `JSON.parse` of Chronicle data. The only relevant synchronous localStorage parses here are a small generated-name array and the tiny capture-lease record.

Pruning is adequate for events but not perfect: the 20,000-row ceiling is enforced only on boot/each five-minute prune, so a very high event rate can temporarily exceed it; prune itself performs several cursor deletion passes and can compete with replay/preloads for IndexedDB I/O. It should remain off the critical path and expose row/byte counts. Machine-specific origin-storage size was not measured: the browser-control safety instructions prohibit inspecting local storage/profile stores, and the server/page was unavailable. This limitation is explicit rather than inferred as zero.

## Ranked remediations

| Rank | Remediation | Impact | Effort | Risk | Verification |
| ---: | --- | --- | --- | --- | --- |
| 1 | Replace per-session `gitEvents` history with a deduplicated project/event feed keyed by event ID; keep only compact recent per-session references or fetch project history lazily. | **Very high**: measured roster falls 859,135 → 30,621 B if omitted; unique-ID normalization removes ~688,536 duplicate bytes while retaining events. Also cuts client scans/signatures. | Medium–high | Medium: Harbor/Chronicle/monuments/search consume events; define ordering/ownership and migration carefully. | Roster <50 KB for 21 sessions; all git UI fixtures pass; one event appears once; compare Harbor/Chronicle behavior; capture WS byte histogram. |
| 2 | Make WebSocket `init` the primary initial snapshot; start it before REST and use REST sessions/teams/usage only after a bounded connect/init timeout. | **High at boot**: removes one 420–859 KB transfer, parse, and full ingestion; shortens critical path by the slow REST call. | Medium | Medium: preserve degraded/polling semantics and old-server compatibility. | Cold-load network waterfall shows one roster; offline/WS-failure tests fall back to REST; readiness transitions remain correct. |
| 3 | Preserve entity-level deltas through ingestion: stable session IDs instead of activity-sorted array indexes, changed/removed ID sets, `AgentManager` patching only changed sessions, and one batched `world:snapshot-applied` notification. | **High CPU**: removes full `n` conversion/git scans and O(m×n) listener storms; makes true wire deltas useful end-to-end. | High | Medium–high: many synchronous listeners rely on per-agent events. | Instrument parse/patch/ingest/listener time and event counts; one session change touches one Agent; UI/Chronicle/ledger parity tests. |
| 4 | Add built-in **asynchronous/streaming gzip for HTTP JSON/static text**, with a size threshold and `Vary: Accept-Encoding`; do not synchronously `gzipSync` the 859 KB buffer. | High network/parse-input copy mitigation for REST: measured 859,135 → 142,543 B (83.41% transfer reduction). Does not reduce decompressed JSON parse/object cost. | Low–medium | Low–medium: event-loop CPU if implemented synchronously; headers/caching must be correct. | `curl --compressed -D-` shows `Content-Encoding: gzip` and `Vary`; raw/decompressed bodies match; event-loop and response timing under load. |
| 5 | Keep the hand-written WS and existing JSON patches; add serialized full/delta byte counters and patch-fallback reasons, then stabilize ordering and tune the 500-op/full-floor policy from evidence. | Medium: identifies whether fulls dominate and prevents reorder-driven fallback. | Low for metrics; medium for keyed diff | Low for metrics | `/api/perf` reports full/delta counts and bytes/client, fallback reason, p50/p95 patch ops and ingest timings over a busy hour. |
| 6 | Batch `agent:updated` consumers. At minimum, make TopBar/SpendLedger/Attention process once per snapshot or animation frame; avoid TopBar calling `SpendLedger.sample()` when the ledger listener already did. | Medium CPU, especially as agent count grows; directly removes demonstrated O(n²) rescans. | Medium | Low–medium: timing-sensitive counters/notifications | Count `sample`, `render`, and world scans per WS message; totals remain identical; no notification duplication. |
| 7 | Remove the six unread session fields and consolidate redundant git properties only behind consumer tests. | Low alone (2,725 B), easy hygiene; command/label and dual timestamps could be larger after architectural split. | Low for dead fields | Low for six fields; medium for git consolidation | `rg`/unit fixtures plus snapshot byte diff; model visuals and cost remain unchanged. |
| 8 | Add storage telemetry and prune old `usageLedger:*`, unused meta/aurora records, and optionally stale biographies; schedule heavy prune after first usable paint or in idle slices. | Low–medium long-session hygiene; protects pathological histories. | Medium | Low | Expose per-store rows/estimated bytes/prune duration; seed max-size DB and confirm boot remains usable and bounds hold. |

Per-message WS compression is deliberately not recommended at this stage. The server negotiates no extensions, and implementing RFC 7692 correctly in the hand-written stack adds context-takeover, RSV1, fragmentation, and zlib resource-management risk. Shape normalization and true small deltas remove far more work, including parse/object/fan-out work that compression cannot solve.

## Ruled out

- **Unconditional 420 KB every two seconds:** false. Clean polls return early, identical dirty states are hash-suppressed, and current clients negotiate deltas.
- **Deltas are fake/full payloads:** false on the wire. `update-delta` contains only JSON-Patch ops. They become full snapshots again at the client ingestion boundary.
- **Full chat transcripts/base64/git diffs:** absent in the measured response. The large text is duplicated git commands/labels/stderr.
- **Chronicle/localStorage giant synchronous parse on boot:** false for the audited stores. Chronicle uses IndexedDB cursor reads; persisted event and in-memory arrays have explicit bounds. Real store bytes remain unmeasured due the browser-storage inspection restriction.
- **Compression already negotiated:** false in source. `sendJson` sets only `Content-Type`; WS handshake/frame code negotiates no compression. Live `curl -I` could not run because port 4000 refused connections.
- **Every WS message rebuilds every rendered object:** partially false. Agent signatures suppress `world.updateAgent` for unchanged agents, Sidebar coalesces, and Dashboard updates incrementally. However every snapshot still converts/scans every session, and broad changes synchronously emit enough per-agent listeners to produce O(n²) work.
- **60 FPS disproves ingestion cost:** false. FPS can remain high between bursty boot/message tasks and says nothing about the pre-render REST gate.

## Source anchors

- HTTP JSON without compression: `claudeville/server.js:122-125`.
- WS message negotiation/framing/broadcast: `claudeville/server.js:835-895`.
- Full initial WS state: `claudeville/server.js:954-983`.
- Delta cadence, index diff, suppression, guards: `claudeville/server.js:1088-1093`, `1199-1243`, `1264-1347`.
- Client parse, delta expansion, event fan-out: `claudeville/src/infrastructure/WebSocketClient.js:128-139`, `190-299`.
- REST-before-WS boot order: `claudeville/src/presentation/App.js:218-240`, `526-567`.
- Full roster ingestion/signature gate: `claudeville/src/application/AgentManager.js:257-281`, `322-344`, `432-485`.
- Chronicle bounds/prune: `claudeville/src/infrastructure/ChronicleStore.js:3-20`, `403-426`; cursor replay/page: `claudeville/src/application/ChronicleLog.js:240-260`, `391-439`.
- SpendLedger five-minute samples/current-day narrow load: `claudeville/src/application/SpendLedger.js:82-185`, `260-288`.
