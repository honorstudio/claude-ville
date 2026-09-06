# Adapter transcript fixtures

These synthetic JSONL transcripts test parser contracts without reading real provider history. They contain no real prompts, credentials, usernames, repository paths, or provider identifiers.

| Provider | File | Purpose |
| --- | --- | --- |
| Claude | `claude/all-records.jsonl` | Broad projection: tools/results, tokens/cost, branch/effort, todos, changes, duration, hooks, and bounded text. |
| Claude | `claude/minimal.jsonl` | Completed turn proving defaults and estimated cost without richer records. |
| Claude | `claude/agent-launch.jsonl` | Parent transcript with an `Agent` launch and declared child identity. |
| Claude | `claude/agent-child.jsonl` | Paired child transcript proving parent/subagent identity linkage. |
| Codex | `codex/abort-after-pending.jsonl` | Pending tools followed by `turn_aborted`; pending state must clear. |
| Codex | `codex/full-auto-pending.jsonl` | Old pending command under full-auto remains working, not permission-blocked. |
| Codex | `codex/item-completed.jsonl` | Ordered file changes and a failed command with duration, stderr, and exit status. |
| Codex | `codex/long-running-turn.jsonl` | Old active turn with token events remains running rather than decaying idle. |
| Codex | `codex/tool-results.jsonl` | Command completions with exit 0, exit 1, an unknown exit, and one invocation that never completes. |
| Kimi Code | `kimi/tool-results.jsonl` | Wire loop events: a passing and a failing command result, plus a result carrying only output (no outcome). |
| OpenCode | `opencode/tool-results.jsonl` | Normalized tool parts with `metadata.exit` 0 and 1, plus a part with no exit at all. |

## Redaction rule

Author fixtures synthetic-first. If derived from provider output, replace every prompt/message, absolute path, account or session identifier, repository/remote, command output, secret, and token-like value. Preserve only required shape, ordering, types, and harmless numeric relationships. Use placeholders such as `__PROJECT__` and `__NOW__`; never commit a lightly edited real transcript.

## Consumers

`rg -l 'adapters/fixtures' scripts` identifies the direct consumers:

- `scripts/tests/claude-identity.test.mjs` uses Claude launch, child, and minimal records.
- `scripts/tests/claude-projection.test.mjs` uses broad and minimal Claude records (it resolves the fixture root without spelling the full search string).
- `scripts/tests/turn-state.test.mjs` copies the Codex fixture directory into a synthetic provider home.
- `scripts/tests/integration/session-payload-contract.test.mjs` replays the broad Claude fixture through an isolated server.
- `scripts/tests/tool-results.test.mjs` materializes the Codex and Kimi Code result transcripts in a synthetic home, replays the OpenCode parts through `buildOpenCodeSession`, and uses the broad Claude record as the no-result control.

`npm run check:adapter-fixtures` is a broad executable adapter contract. It creates synthetic ClaudeVille, Codex, Kimi, and OpenCode state and checks normalization, detail dispatch, discovery, and fixture-backed turn states. Unit fixtures are narrower named `node:test` cases run by `npm run test:unit`; the integration consumer runs only under `npm run test:integration`.
