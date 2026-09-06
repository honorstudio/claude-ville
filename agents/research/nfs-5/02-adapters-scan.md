# Adapter scan performance investigation

Date: 2026-09-01  
Scope: read-only investigation of `claudeville/adapters/*.js`; no source files changed. The maintained server on port 4000 was left running.

## Executive summary

- **OMP is the dominant adapter by two orders of magnitude:** one direct pass read 941,654,707 bytes and parsed 915,338,112 bytes synchronously, taking 4.075 s; a repeat did the same work in 4.000 s.
- Under concurrent live-server load, an OMP pass took 12.677 s and its immediate repeat 9.218 s, enough to explain the observed multi-second event-loop stalls.
- OMP recursively discovers all 338 historical transcripts in 67 directories, reads a 32-line head plus up to 2,500 tail lines / 8 MiB **for every file**, and only then applies the 2-minute activity cutoff.
- A threshold-zero proof (no file can qualify) still read 941,756,247 bytes and parsed 915,424,849 bytes; the cutoff therefore saves no I/O or JSON work.
- The OMP corpus is 1,105,299,053 bytes across 338 JSONL files; each pass reads 85.2% of it. Only two files (581,297 bytes total) were within two minutes during measurement.
- The shared tail cache is ineffective for this pass: its 128-entry / 32 MiB limits are smaller than OMP's 338-file / ~915 MiB parsed working set, and scan order causes complete LRU churn. The warm pass had identical I/O and parse counts.
- Codex is the secondary cost at 175 ms cold / 126 ms warm; it repeatedly expands per-file tail windows and read 40.0 MiB cold / 33.9 MiB warm for eight active files.
- Claude, Grok, and Kimi were each 18 ms or less cold and 2.3 ms or less warm here. Gemini and OpenCode were not installed, so they were assessed statically rather than timed.
- Highest-value fix: in OMP, stat and reject inactive transcripts before `_readRecords`; on this snapshot that reduces transcript bytes eligible for reading by an estimated 99.94%, before further caching or tail-window reductions.

## Method and corpus

I used `/tmp/bench-adapters.cjs` to load each adapter class directly and call `getActiveSessions(120000)` twice in the same process. Timing uses `process.hrtime.bigint()`. Before module load, the script wrapped synchronous `fs` operations, `JSON.parse`, and synchronous child-process calls; counters were enabled only around `getActiveSessions`, so module-loading I/O is excluded. `readFileSync` is reported separately from bounded `openSync` / `readSync` reads. A “stat'd file” is a unique path observed through `statSync`/`lstatSync` or a mapped `fstatSync`; total metadata-call counts are noted where important.

The live server remained running, so absolute wall time varies with contention. Counts and bytes were stable across runs. The first all-adapter run is the comparable table baseline; the later OMP-only threshold-zero run is an additional stress/proof run.

On-disk provider roots measured with `du -sh` and `find`:

| Root | Disk use | All files |
| --- | ---: | ---: |
| `~/.claude` | 876 MiB | 4,961 |
| `~/.codex` | 8.8 GiB | 10,107 |
| `~/.grok` | 898 MiB | 7,086 |
| `~/.kimi` | 38 MiB | 25 |
| `~/.kimi-code` | 506 MiB | 703 |
| `~/.omp` | 1.7 GiB | 3,064 |
| `~/.gemini` | absent | — |
| `~/.local/share/opencode` | absent | — |

The relevant OMP session subtree contains 67 directories and 338 JSONL files totaling 1,105,299,053 bytes (1.029 GiB). File-size distribution: median 2,044,055 bytes; p90 5,445,725; p95 9,512,777; p99 29,248,957; maximum 51,973,520. At inventory time, 2 files / 581,297 bytes were active within 2 minutes and 4 files / 627,815 bytes within 30 minutes.

## Per-adapter measured cost

`Dirs` is unique directories passed to `readdirSync`; `stat paths` is unique paths stat'd. `Full reads` means whole-file `readFileSync`, not bounded head/tail `readSync`. MiB uses 1,048,576 bytes.

| Adapter | Pass | Wall ms | Sessions | Dirs | Stat paths | Full reads | Bounded reads | JSON parsed | Interpretation |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Claude | cold | 18.037 | 0 | 47 | 914 | 0 / 0 B | 1 file / 327,681 B | 1,000 calls / 301,666 B | Cold orphan/subagent discovery; bounded `history.jsonl` tail only. |
| Claude | warm | 1.708 | 0 | 2 | 78 | 0 / 0 B | 0 / 0 B | 0 / 0 B | Directory and tail caches effective. |
| Codex | cold | 174.663 | 8 | 63 | 2,249 | 1 / 6,856 B | 8 files / 41,932,530 B (39.99 MiB) | 1,657 calls / 22,734,099 B | Cold discovery stat'd 2,194 rollout files; reads only 8 active rollouts. |
| Codex | warm | 125.580 | 8 | 4 | 14 | 0 / 0 B | 8 files / 35,564,318 B (33.92 MiB) | 1,270 calls / 16,591,108 B | Discovery cache works; tail working set still churns/expands. |
| Gemini | — | not available | — | — | — | — | — | — | No `~/.gemini`; static assessment below. |
| Grok | cold | 5.713 | 0 | 5 | 538 | 134 / 131,320 B | 0 / 0 B | 134 calls / 131,320 B | Reads 134 small summary JSON files once. |
| Grok | warm | 2.267 | 0 | 1 | 538 | 0 / 0 B | 0 / 0 B | 0 / 0 B | Summary/project caches effective; metadata probing remains O(all sessions). |
| Kimi | cold | 3.296 | 0 | 23 | 163 | 3 / 3,560 B | 1 file / 2,647 B | 12 calls / 3,083 B | Config/state/index only; inactive wires rejected before parsing. |
| Kimi | warm | 1.124 | 0 | 23 | 152 | 0 / 0 B | 0 / 0 B | 0 / 0 B | Index/config/tail caches effective; directory walk remains. |
| OpenCode | — | not available | — | — | — | — | — | — | No database/read strategy; static assessment below. |
| **OMP** | **cold** | **4,074.930** | **2** | **67** | **338** | **0 / 0 B** | **338 files / 941,654,707 B (898.03 MiB)** | **158,291 calls / 915,338,112 B (872.93 MiB)** | **All historical transcripts parsed before cutoff.** |
| **OMP** | **warm** | **3,999.792** | **2** | **67** | **338** | **0 / 0 B** | **338 files / 941,678,242 B (898.05 MiB)** | **158,295 calls / 915,359,469 B (872.95 MiB)** | **Warm cache provides effectively zero benefit.** |

OMP performs more metadata work than the unique-path column suggests: each pass made 676 `statSync`/`lstatSync` calls plus 676 `fstatSync` calls (four metadata operations per transcript), opened files 676 times (head and tail), and issued 13,587 bounded `readSync` calls. A separate `activeThresholdMs = 0` run still walked 67 directories and read 941,756,247 bytes. That run took 12,676.875 ms and the immediately repeated pass 9,217.946 ms under contention, with byte/parse counts unchanged.

### Cost model by adapter

- **Claude:** one bounded tail of 1,000 history records establishes candidates. Cold orphan discovery is O(all top-level project transcripts) in metadata (914 unique stat paths here), but expensive transcript summaries occur only after mtime/activity checks. Project listings and subagent activity are cached, reducing the warm pass to 2 directory reads and 78 stats. No whole transcript was read.
- **Codex:** cold reconciliation is O(all dated rollout files) in metadata (54 day directories and 2,194 rollout files), but mtime cutoff precedes transcript parsing. Warm discovery checks 9 cached/warm files plus a four-day-directory frontier. For each of 8 active files, summary, token, and git extraction request progressively larger head/tail views, producing ~34–40 MiB of synchronous reads per pass despite bounded reads.
- **Gemini (static):** walks project `chats/` directories and stats session JSON files; it applies mtime cutoff before `readFileSync`. It does fully read active `session-*.json`, but memoises the parsed object by `(path,size,mtime,ctime,inode)` in a 256-entry / 32 MiB cache. A single very large active JSON file remains an exposure, but inactive files are not read.
- **Grok:** discovery is O(all session directories). Cold scan reads each small `summary.json` before determining activity; parsed summaries are cached by file stat signature. Warm pass still performs many `exists/stat` probes (672 stat calls across 538 unique paths) but no payload reads on this snapshot.
- **Kimi:** both legacy and v2 layouts walk all workspaces/sessions/agent directories, but stat `wire.jsonl` and reject inactive sessions/agents before tail parsing. Config, index, and state reads are small and cached. Fan-out is O(all sessions) in metadata only.
- **OpenCode (static):** does no filesystem transcript walk. SQL applies `time_updated >= cutoff`, orders by activity, and caps candidates at 256 before loading recent parts. Its result cache is keyed by DB/WAL signature and threshold; a CLI fallback can use synchronous `sqlite3`, but no OpenCode store was available to measure.
- **OMP:** recursive discovery is O(all historical transcript files), and every discovered file is synchronously head/tail-read and JSON-parsed. The activity check is inside `parseOmpTranscript`, after parsing. Thus cost is approximately `O(number of all transcripts × min(bytes needed for 2,500 lines, 8 MiB))`, independent of the number of active sessions.

## Root causes

### 1. OMP applies the activity cutoff after almost a gigabyte of work

OMP sets an unusually large active-list window—2,500 tail lines with an 8 MiB cap—at [`claudeville/adapters/omp.js:21`](../../../claudeville/adapters/omp.js#L21). `_listTranscriptFiles` recursively walks every visible directory and accumulates up to 4,096 transcripts at [`omp.js:377`](../../../claudeville/adapters/omp.js#L377). `_readRecords` reads a 32-line / 256 KiB head and then the 2,500-line / 8 MiB tail at [`omp.js:394`](../../../claudeville/adapters/omp.js#L394).

`getActiveSessions` calls `_parseFile` for every discovered path at [`omp.js:422`](../../../claudeville/adapters/omp.js#L422). Only after `parseOmpTranscript` has iterated all parsed records, accumulated tokens, messages, tools, pending calls, and dialogue does it stat the file and reject old activity at [`omp.js:176`](../../../claudeville/adapters/omp.js#L176) and [`omp.js:283`](../../../claudeville/adapters/omp.js#L283). The threshold-zero measurement proves this ordering is causative, not merely suspicious.

Although this is technically bounded tail I/O rather than `readFileSync` of the complete JSONL, the effect is close to full-corpus reading: 941.76 MB read is 85.2% of the 1.105 GB OMP transcript corpus, and 915.42 MB parsed is 82.8%. Many files are smaller than the 8 MiB cap; the head and tail can also overlap and duplicate parsing for small transcripts.

### 2. The shared tail cache is smaller than the OMP scan and thrashes deterministically

The shared cache is capped at 128 paths and 32 MiB at [`claudeville/adapters/shared.js:3`](../../../claudeville/adapters/shared.js#L3). It evicts oldest paths until both limits hold at [`shared.js:195`](../../../claudeville/adapters/shared.js#L195). An unchanged file would be served without reading at [`shared.js:225`](../../../claudeville/adapters/shared.js#L225), but OMP's 338-file scan and hundreds of MiB of tail state cannot fit. Scanning the same ordered list from the beginning evicts the previously retained end of the list before the scan reaches it. Observed proof: cold and immediate warm OMP calls each opened 676 files, read ~941.7 MB, and parsed ~915.3 MB.

OMP itself caches only a session-id-to-path `_index`, clears it at the start of every active scan, and clears it on dirty invalidation ([`omp.js:361`](../../../claudeville/adapters/omp.js#L361), [`omp.js:422`](../../../claudeville/adapters/omp.js#L422), [`omp.js:457`](../../../claudeville/adapters/omp.js#L457)). It has no `(path,mtime,size)` parsed-summary cache and exposes no performance counters.

### 3. Codex rereads progressively larger overlapping windows

Codex correctly applies mtime cutoffs while discovering rollouts: files are stat'd, remembered, and rejected before parsing at [`claudeville/adapters/codex.js:1033`](../../../claudeville/adapters/codex.js#L1033). Warm discovery is cached and rechecks only warm paths/newest directories at [`codex.js:1004`](../../../claudeville/adapters/codex.js#L1004) and [`codex.js:1080`](../../../claudeville/adapters/codex.js#L1080).

The remaining cost is repeated views of each active rollout. `parseRollout` reads early metadata and a 50-line tail ([`codex.js:326`](../../../claudeville/adapters/codex.js#L326), [`codex.js:400`](../../../claudeville/adapters/codex.js#L400)); token usage requests 500 tail records at [`codex.js:720`](../../../claudeville/adapters/codex.js#L720); git extraction requests 5,000 at [`codex.js:877`](../../../claudeville/adapters/codex.js#L877). `getActiveSessions` invokes all three at [`codex.js:1230`](../../../claudeville/adapters/codex.js#L1230) and [`codex.js:1269`](../../../claudeville/adapters/codex.js#L1269). Growing a cached capacity forces a new full bounded-tail read in `shared.js` ([`shared.js:272`](../../../claudeville/adapters/shared.js#L272)); the shared 32 MiB byte cap also cannot retain this eight-file working set. This explains 35.6 MiB of warm reads and repeated JSON parsing, though its 126 ms cost is far below OMP.

### 4. Other historical fan-out is metadata-heavy but bounded before payload reads

Claude's main candidate cutoff precedes transcript summaries at [`claudeville/adapters/claude.js:1798`](../../../claudeville/adapters/claude.js#L1798); subagent and orphan loops also stat and cutoff before parsing at [`claude.js:1887`](../../../claudeville/adapters/claude.js#L1887) and [`claude.js:1975`](../../../claudeville/adapters/claude.js#L1975). Its project listing and subagent activity caches explain the 18.0 ms to 1.7 ms cold/warm drop ([`claude.js:1580`](../../../claudeville/adapters/claude.js#L1580), [`claude.js:1659`](../../../claudeville/adapters/claude.js#L1659)).

Grok loads/caches small summaries before its cutoff at [`claudeville/adapters/grok.js:698`](../../../claudeville/adapters/grok.js#L698), with signature and project-directory caches at [`grok.js:120`](../../../claudeville/adapters/grok.js#L120) and [`grok.js:214`](../../../claudeville/adapters/grok.js#L214). Kimi applies wire mtimes before parsing in both v2 and legacy scans ([`claudeville/adapters/kimi.js:1283`](../../../claudeville/adapters/kimi.js#L1283), [`kimi.js:1531`](../../../claudeville/adapters/kimi.js#L1531)). Gemini applies mtime cutoff before its whole-active-JSON read/cache ([`claudeville/adapters/gemini.js:533`](../../../claudeville/adapters/gemini.js#L533), [`gemini.js:140`](../../../claudeville/adapters/gemini.js#L140)). OpenCode pushes cutoff and limit into SQL at [`claudeville/adapters/opencode.js:54`](../../../claudeville/adapters/opencode.js#L54) and caches results at [`opencode.js:628`](../../../claudeville/adapters/opencode.js#L628).

### 5. Registry caching does not rescue a slow OMP refresh

The adapter registry has a 2-second list cache and a `force` bypass at [`claudeville/adapters/index.js:49`](../../../claudeville/adapters/index.js#L49) and [`index.js:295`](../../../claudeville/adapters/index.js#L295). `force` is not forwarded into adapter calls—the registry invokes `adapter.getActiveSessions(activeThresholdMs)` at [`index.js:320`](../../../claudeville/adapters/index.js#L320)—so it is not directly disabling an OMP-local cache. The problem is that OMP has no summary/discovery cache and the shared cache cannot hold its working set. Any legitimate list-cache expiry or invalidation therefore pays the full OMP cost.

## Ranked remediations

### 1. Pre-filter OMP by mtime before `_readRecords`

- **Impact:** Very high. Stat each discovered file once, compare `mtimeMs` to the active cutoff, and parse only qualifying files. At measurement time this reduced eligible transcript payload from 941,756,247 bytes actually read to 581,297 bytes of active files—an estimated **99.94% byte reduction** before accounting for bounded tailing. Directory traversal and ~338 stats remain, but those are milliseconds rather than seconds.
- **Effort:** Low. Return `{filePath, stat}` from discovery or stat at the top of the active loop, and pass the known mtime into parsing to avoid its later duplicate stat.
- **Risk:** Low to medium. Normal append semantics guarantee mtime advances with transcript activity. Test clock skew/future embedded timestamps and the desired visibility of a quiet parent whose child transcript is active; if parent metadata must remain present, read only that parent's tiny head after an active child identifies it.
- **Verification:** Assert session identity/parentage against the existing implementation on fixtures; instrument a 338-file fixture and require only active paths to be opened; benchmark threshold `0`, `2m`, and `30m`; ensure bytes scale with active files, not corpus size.

### 2. Add an OMP parsed-summary cache keyed by `(path, size, mtimeMs, ctimeMs/inode)`

- **Impact:** Very high for repeated polls. An unchanged active transcript should incur a stat and no read/JSON parse; an append should update only that session. This avoids relying on the global tail cache's incompatible all-provider budget.
- **Effort:** Medium. Cache the normalized active-session summary and file identity; retain the path index across scans and prune missing/inactive entries.
- **Risk:** Medium. Must handle truncate/rewrite/rotation, child-parent relationships, and time-based transition from active to inactive even when the file signature is unchanged.
- **Verification:** Two immediate scans must show zero transcript bytes on the second scan; append, truncate, replace-inode, deletion, and threshold-expiry tests must invalidate or age results correctly.

### 3. Split OMP active-summary parsing from detail/token-history parsing

- **Impact:** High, especially for large active sessions. The list needs recent status/tool/message and session metadata, not 2,500 lines plus an 8 MiB window for every field. Read a bounded head for stable identity and a much smaller tail for live status. Keep 5,000/8 MiB detail work on the detail endpoint. For cumulative token totals, maintain an incremental `(path,offset,guard)` accumulator rather than re-summing a large tail.
- **Effort:** Medium to high.
- **Risk:** Medium. Tail size must cover pending-tool/result pairing and current dialogue semantics; token totals must not regress. The existing tail-summed totals are already incomplete for transcripts larger than the cap, so tests should define the intended semantics explicitly.
- **Verification:** Golden fixtures with long tool calls, pending/completed tools, title/model changes, large messages, and >8 MiB histories; compare active-list fields and detail results before/after; track bytes per active file.

### 4. Consolidate Codex tail consumers into one largest-window parse

- **Impact:** Medium. Current machine: reduce 35.6–41.9 MiB and 126–175 ms per eight-session pass. Request the 5,000-record window first (or expose a per-file scan context), then derive summary, tokens, and git events from the same parsed objects. Cache early metadata by file identity rather than reading up to 512 KiB every pass.
- **Effort:** Medium.
- **Risk:** Medium because summary/token/git consumers currently have separate assumptions and windows.
- **Verification:** Require at most one tail read/parse per unchanged active rollout; compare normalized sessions, token totals, git events, turn state, and parent linkage on existing unit fixtures.

### 5. Persist OMP discovery metadata rather than recursively re-listing all 67 directories

- **Impact:** Low after remediation 1, but prevents future O(number of historical directories) growth. Cache directory listings by directory mtime or maintain a watch-updated path index, periodically reconciling for missed events.
- **Effort:** Medium.
- **Risk:** Medium on platforms with imperfect recursive watch behavior; retain bounded periodic reconciliation.
- **Verification:** Create/delete/rename nested child transcripts in fixtures and prove discovery without a full walk on ordinary unchanged polls.

### 6. Add OMP performance diagnostics and a synchronous-work budget

- **Impact:** Diagnostic/preventive. OMP is the only measured available adapter without `getPerfStats`; expose discovered, stat'd, skipped-before-read, opened, bytes, parsed lines, cache hits, and duration. A byte/file budget can fail soft or serve the last snapshot if a regression reintroduces corpus-wide work.
- **Effort:** Low to medium.
- **Risk:** Low if counters are cheap and do not stringify paths/payloads.
- **Verification:** Surface counters through existing adapter perf aggregation; compare them with an instrumented fixture and confirm threshold-zero opens zero transcript files.

Moving parsing to a worker can protect the event loop, but it is not a substitute for the first three changes: repeatedly reading/parsing ~0.94 GB every two seconds would still saturate CPU and storage and accumulate stale work.

## Ruled out

- **A single unbounded `readFileSync` of each JSONL transcript:** ruled out for the measured adapters. OMP's transcript path uses bounded `readSync`, not whole-file `readFileSync`; the pathology is the 8 MiB/2,500-line bound applied to all history. Codex/Claude/Kimi/Grok also use bounded tail helpers for JSONL. Gemini fully reads active JSON session documents only after mtime filtering and caches them.
- **Synchronous git subprocesses as the per-pass dominant cost:** all directly timed adapter passes recorded 0 `execSync`, 0 `execFileSync`, and 0 `spawnSync` calls. Registry repository discovery can synchronously invoke `git` on its separate five-minute cache path, and OpenCode may invoke `sqlite3` in CLI fallback, but neither explains the stable OMP per-pass byte count or timing.
- **Regex over one giant string / accidental quadratic parsing:** no evidence in the dominant path. OMP reads chunks, splits lines, parses each JSON line, and merges head/tail through a `Set`; measured work is linear but enormous (158k `JSON.parse` calls and ~915 MB input per pass).
- **API response size as the source of adapter scan time:** the reported 420 KiB `/api/sessions` payload is far smaller than OMP's ~942 MB synchronous read volume. Serialization may add latency, but it is not needed to explain the adapter stall.
- **A changing `force` cache key inside OMP:** OMP has no force parameter or parsed-summary cache. Registry `force` bypasses only the 2-second aggregate list cache and is not passed to adapters.
- **Cold disk alone:** ruled out as the sole cause. OMP's immediate second pass still performed identical I/O/JSON work and took 4.0 s in the baseline, 9.2 s under contention. OS cache may change wall time, but cannot remove synchronous scanning/parsing.
- **Claude/Codex corpus size alone:** despite `~/.codex` being 8.8 GiB and `~/.claude` 876 MiB, both apply activity filtering before expensive transcript parsing. Codex's cold historical metadata reconciliation and overlapping active tails are secondary, measurable costs, not the multi-second dominant path.
