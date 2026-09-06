# Test catalog

ClaudeVille uses Node's built-in `node:test` runner. The fast unit suite is dependency-free and needs neither a build, browser, real provider home, nor running server:

```sh
npm run test:unit
node --test scripts/tests/turn-state.test.mjs
node --test scripts/tests/turn-state.test.mjs --test-name-pattern "completed"
```

`test:unit` runs top-level `scripts/tests/*.test.mjs` files. Integration tests start an isolated production server on an ephemeral socket and run separately with `npm run test:integration`.

Set `CLAUDEVILLE_TEST_TMPDIR` to a writable directory when the normal temporary directory is unavailable. `support/tmp.mjs` and `support/tmp.cjs` create unique children beneath it, otherwise falling back to the OS temporary directory.

## Suite map

| Category | Files or prefixes | Covers |
| --- | --- | --- |
| Adapter and turn state | `turn-state*`, `claude-*`, `omp-adapter`, `r2-02.adapter-parity` | Provider parsing, normalized sessions, identity, projection, and pending/completed turn rules. |
| Pricing and registry | `r1-09.cache-token-normalize`, `r1-15.spend-rollup`, `r2-02.pricing`, `model-registry` | Token normalization, pricing, spend, and canonical model metadata. |
| Renderer and GPU policy | `astra-render-refinement`, `material-*`, `postfx-*`, `trail-*`, `canvas-budget`, `drawable-pass`, `gpu-*`, `c16-*`, `w4-*`, `w11-cache-ore-ratio`, `r3-*` | Admission, resources, materials, trails, atlases, cache-ore ratios, occupancy-gated night lighting, and degradation policy without Canvas. |
| DOM-stub UI | `frontend-reliability`, `ui-data-remediation`, `hook-overlay`, `r1-11.*`, `r1-19.*`, `r2-04.*`–`r2-11.*`, `r3-settings.*`, `r4-dialogue.*`, `w1-g.*`–`w1-i.*`, `w5-*` | Browser-facing code under small DOM, storage, audio, and canvas stubs. These are not browser/component tests. |
| Server and hook tooling | `astra-runtime`, `agent-hooks`, `release-changelog`, `catalog-check`, `session-residency`, `working-set`, `persistent-history`, `r1-12.*`, `r2-12.*`, `w1-*`, `w2-*`, `w3-*` | Server state, hooks, releases, catalogs, persistence, and telemetry. |
| Integration | `integration/*.test.mjs` | Real isolated-server HTTP/WebSocket contracts and replay pipelines; run only by `test:integration`. |

## Notable contract tests

| File | Contract |
| --- | --- |
| `model-registry.test.mjs` | Generated ESM/CJS resolver parity, presentation identity parity, and bidirectional registry/manifest completeness. |
| `simulation-isolation.test.mjs` | Simulator storage, cross-tab channels and writer leases remain separate from live history; simulated freshness is explicit. |
| `agent-hooks.test.mjs` | Destructive-command guards, fail-open input, syntax reports, session output, opt-in ingestion, and latency. |
| `release-changelog.test.mjs` | Release header parsing, exact extraction, version rejection, and read-only/write preparation behavior. |
| `catalog-check.test.mjs` | Smoke files, verification npm scripts, and `docs/*.md` files remain cataloged. |
| `o2-prompt-plan-mapping.test.mjs` | Prompt, TodoWrite, and branch payload bounds plus signature-driven live Agent updates. |
| `c10-taskboard-board.test.mjs` | Selected/pinned Task Board precedence, honest row shaping, overflow, and completed-only strikes. |
| `o10-stale-cargo-ledger.test.mjs` | Oldest commit merging, age-first harbor ordering, unknown-age honesty, and age formatting. |
| `w5-bridge-lanterns.test.mjs` | Command pond plank walkability plus capped, age-tiered bridge lantern plans and honest absence. |
| `integration/session-payload-contract.test.mjs` | HTTP sessions and WebSocket initialization satisfy the client payload contract. |
| `integration/r1-18.pipeline-replay.test.mjs` | A real multi-provider pipeline emits valid WebSocket delta and snapshot payloads. |

## Conventions

- Name tests as the behavior they prove and keep fixtures deterministic.
- Inject a fixed clock for exact boundaries. Some tests use `Date.now()` for unique import/IndexedDB names, fresh filesystem timestamps, or relative-time fixtures; wall-clock use is allowed when assertions do not depend on an exact instant.
- CommonJS adapter/service modules load via `createRequire`; browser ES modules import directly.
- Transcript fixtures are documented in `scripts/adapters/fixtures/README.md`; browser pixels and live lifecycle behavior belong to smoke and visual checks.

## Verification command index

| Area | Commands |
| --- | --- |
| Syntax/static contracts | `check:server`, `check:adapters`, `check:services`, `check:frontend-syntax`, `check:scripts`, `check:git-events`, `check:adapter-fixtures`, `check:theme-tokens`, `check:artifacts` |
| Tests | `test:unit`, `test:integration`, `test:e2e:replay` |
| Models | `models:generate`, `models:check`, `models:resolve` |
| Focused verification | `verify:architecture`, `verify:server`, `verify:render` |
| Gates | `validate:quick`, `validate:full`, `gate:release` |
| Release | `release:check`, `release:prepare`, `release:verify` |

The smoke catalog details focused runtime requirements. `validate:quick` is the deterministic pre-push loop; `validate:full` adds integration, server, World, and sprite validation; `gate:release` also verifies release metadata.
