# Smoke and runtime verification catalog

These checks complement `node:test`. Most are deterministic Node programs; browser checks use Playwright, and some target the maintained dashboard at `http://localhost:4000`. Fixture-backed scripts honor `CLAUDEVILLE_TEST_TMPDIR`. Runtime estimates are typical local runs. "Isolated socket" means an OS-assigned port, never port 4000.

| Script | What it proves | Requirements | Runtime | npm wrapper |
| --- | --- | --- | --- | --- |
| `adapters.mjs` | Claude discovery, parent linkage, and team membership. | Temp dir; no dependencies/server | <1 s | None |
| `astra-height-smoke.mjs` | GPU pixel readback proves authored zero/low/tall height and independent shadow strength against a tall receiver and one light. | `node_modules`, Playwright, maintained server or `CLAUDEVILLE_URL` | <1 s | None |
| `architecture.mjs` | Layer boundaries and adapter-helper allowlists. | No dependencies/server | <1 s | `verify:architecture` |
| `boot-contract.mjs` | HTML, APIs, and WebSocket init/delta/resync. | Temp dir; isolated socket | Seconds | `verify:server` |
| `browser-lifecycle.mjs` | Repeated mode switches preserve lifecycle and resource invariants. | `node_modules`, Playwright, server on 4000 or `CLAUDEVILLE_URL` | Minutes | None |
| `claude-transcript-aggregate.mjs` | Incremental transcript aggregation and bounded rereads. | Temp dir; no server | <1 s | None |
| `codex-warm-discovery.mjs` | Warm discovery caches while detecting changes. | Temp dir; no server | <1 s | None |
| `harbor-traffic-bounds.mjs` | Harbor ingest, dedupe, state, and bounded reconciliation. | No dependencies/server | <1 s | None |
| `overlay-layout.mjs` | Randomized overlay placement and dense folding. | No dependencies/server | <1 s | None |
| `performance-soak.mjs` | Long-run memory, frames, polling, and reconnect health; strict retained-listener plateau uses three native forced-GC samples after all-store Chronicle write barriers. `--listener-counter-check` tests expired/retained listeners and real pending IndexedDB writes without a server. `assertServerPlateau` can independently validate retained server samples. RSS uses a second-half median with the unchanged 64 MiB allowance and steady/trailing slope checks; `node scripts/smoke/performance-soak.mjs --rss-gate-check` checks flat, trough/rebound, exact even medians, terminal spikes, and growing traces without a server. | `node_modules`, Playwright, server on 4000/`CLAUDEVILLE_URL`, WebSocket | 30 min default; counter check <1 s | None |
| `r1-18.e2e-replay.mjs` | Multi-provider replay reaches WebSocket snapshots/deltas. | Temp dir; isolated socket | Seconds | `test:e2e:replay` |
| `relationship.mjs` | Relationship maps and clean cache reference reuse. | No dependencies/server | <1 s | None |
| `render-smoke.mjs` | Isolated World/Dashboard render with screenshot diagnostics. | `node_modules`, Playwright, temp dir, isolated socket | Seconds | `verify:render` |
| `scoped-invalidation.mjs` | Provider and Git changes invalidate only their cache scope. | Temp dir; Git CLI; no server | <1 s | None |
| `server-fatal.mjs` | Fatal exceptions clean watchers and exit 1. | Temp dir; child process | Seconds | `verify:server` |
| `server-security.mjs` | Binding, Host/Origin policy, handshakes, invalid frames. | Temp dir; isolated sockets | Seconds | `verify:server` |
| `tail-cache.mjs` | Tail reuse, appends, rotation, truncation, and bounds. | Temp dir; no server | <1 s | None |
| `theme-tokens.mjs` | JS/CSS status authority and literal allowlists. | No dependencies/server | <1 s | `check:theme-tokens` |
| `trail-camera-benchmark.mjs` | Trail cache/redraw camera-motion budgets. | `node_modules`, Playwright, server on 4000/`CLAUDEVILLE_URL`, OS temp report | Seconds | `world:benchmark-trails` |
| `ui-remediation.mjs` | Recovery, races, keyboard/focus, storage fallback. | `node_modules`, Playwright, server on 4000/`CLAUDEVILLE_URL` | Seconds | None |
| `usage-history-bounds.mjs` | Usage history remains bounded and rolls up correctly. | Temp dir; no server | <1 s | None |
| `watcher-footprint.mjs` | Direct/API watcher and file-descriptor budgets. | Linux `/proc`, HTTP, server on 4000 by default | Seconds | None |
| `watcher-runtime.mjs` | Watch changes propagate through HTTP/WebSocket and clean up. | Temp dir; isolated sockets | Seconds | None |
| `watcher-topology.mjs` | Watch roots are deduplicated, bounded, and registered. | Temp dir; no running server | <1 s | None |
| `world-fps-benchmark.mjs` | Renderer FPS across agent counts. | `node_modules`, Playwright, server on 4000/`CLAUDEVILLE_URL` | Minutes | `world:benchmark-fps` |
| `world-state-bounds.mjs` | Monuments, activity, relationships, trails, visits stay bounded. | No dependencies/server | <1 s | None |
| `world-visit-paths.mjs` | Visit slots are unique, walkable, and gate-reachable. | `node_modules`, Playwright, server on 4000/`CLAUDEVILLE_URL` | Seconds | None |
| `support/isolated-server.mjs` | Imported helper reserves a loopback socket, isolates HOME, starts and cleans a server. | Temp dir; sockets; not directly executable | N/A | None |
| `../models/resolve.mjs` | Server/browser resolution, pricing, identity, context window, and sprite assets agree. | `node_modules` (`js-yaml`); no server | <1 s | `models:resolve` |

Executable smokes exit nonzero on failed assertions or budgets. Temp-backed scripts clean unique fixture directories on normal success/failure paths.

## Change-to-check matrix

| Change | Focused checks |
| --- | --- |
| Identity/sprite mapping | `npm run models:check`; `npm run models:resolve -- <provider> <model>`; `npm run sprites:audit-ids` |
| Sprite pixels/channels | `npm run sprites:audit-refresh`; optionally `npm run sprites:capture-fresh` then `npm run sprites:visual-diff` |
| Panel DOM | `npm run test:unit`; `node scripts/smoke/ui-remediation.mjs` against the maintained server |
| World rendering | `npm run verify:render`; `npm run world:validate-buildings`; `npm run world:validate-terrain`; performance via `npm run world:benchmark-fps` or `npm run world:benchmark-trails` |
| Adapter parsing | `npm run check:adapters`; `npm run check:adapter-fixtures`; `npm run test:unit`; `node scripts/smoke/adapters.mjs` |
| Server API/WebSocket | `npm run check:server`; `npm run test:integration`; `npm run verify:server` |
| Pricing | `npm run models:check`; `npm run test:unit`; `npm run models:resolve -- <provider> <model>` |
| Docs/catalogs | `node --test scripts/tests/catalog-check.test.mjs`; review the diff |

Use `npm run validate:quick` for the broad deterministic loop, `npm run validate:full` for integration/server/World validation, and `npm run gate:release` for release metadata plus gates. Playwright checks are opt-in and require installed dev dependencies.
