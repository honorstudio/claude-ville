## Scope

- Work from the repository root (the directory containing this file).
- ClaudeVille is a local, zero-build Node/vanilla-JS dashboard for watching AI coding CLI sessions as a browser village. Do not add a bundler, transpiler, TypeScript, framework, or runtime dependency.
- Desktop only: assume viewports at least 1280px wide; do not add mobile breakpoints or responsive shrinking.
- This is a shared checkout. Start with `git status --short`, preserve unrelated edits, and touch only task-owned files. Prefer `rg` and `rg --files` for discovery.
- Use English for new or edited UI copy, docs, comments, and agent-facing text.

Start the maintained local server with `npm run dev` at `http://localhost:4000`. Runtime needs no install; development scripts may require the existing dev dependencies.

## Project Map

| Area | Path | Onboarding doc |
| --- | --- | --- |
| Server / APIs / WebSocket | `claudeville/server.js` | [`claudeville/CLAUDE.md`](claudeville/CLAUDE.md) |
| Provider adapters | `claudeville/adapters/` | [`adapters/README.md`](claudeville/adapters/README.md) |
| Usage, quota, account | `claudeville/services/` | [`design-decisions.md`](docs/design-decisions.md), [`troubleshooting.md`](docs/troubleshooting.md) |
| Frontend boot | `claudeville/src/presentation/App.js` | [`claudeville/CLAUDE.md`](claudeville/CLAUDE.md) |
| World mode | `claudeville/src/presentation/character-mode/` | [`character-mode/README.md`](claudeville/src/presentation/character-mode/README.md) |
| Dashboard mode | `claudeville/src/presentation/dashboard-mode/` | [`dashboard-mode/README.md`](claudeville/src/presentation/dashboard-mode/README.md) |
| Shared UI | `claudeville/src/presentation/shared/` | [`shared/README.md`](claudeville/src/presentation/shared/README.md) |
| Domain / application / config / infra | `claudeville/src/{domain,application,config,infrastructure}/` | [`claudeville/CLAUDE.md`](claudeville/CLAUDE.md) |
| Sprite assets | `claudeville/assets/sprites/` | [`generate.md`](scripts/sprites/generate.md), [`pixellab-reference.md`](docs/pixellab-reference.md) |
| Contributor workflows | `.claude/skills/` | `add-model`, `add-provider`, `sprite-character`, `release`, `verify-architecture`, `verify-server`, `verify-ui` |
| Claude Code hooks | `.claude/settings.json` + `scripts/agent-hooks/claude-hook.cjs` | [`troubleshooting.md`](docs/troubleshooting.md#permission-prompts-are-inferred-or-arrive-late) |
| Codex config | `.codex/config.toml` | Project-scoped PixelLab MCP |
| Model registry | `claudeville/src/config/models.json` (+ generated `.js`/`.cjs`) | [`.claude/skills/add-model/SKILL.md`](.claude/skills/add-model/SKILL.md) |
| Tests / smoke | `scripts/tests/`, `scripts/smoke/` | [test README](scripts/tests/README.md), [smoke README](scripts/smoke/README.md) |
| CI | `.github/workflows/ci.yml` | `npm ci` + `validate:full` on Node 22 and 24 |
| Documentation | `docs/` | [`docs/README.md`](docs/README.md) |

Retained agent artifacts belong under `/agents/`; read [`agents/README.md`](agents/README.md) before using or adding one.

## Validation

Match the command to the change:

| Change | Command |
| --- | --- |
| Models | `npm run models:resolve -- <provider> <model>`; `npm run models:check`; `node --test scripts/tests/model-registry.test.mjs` |
| Anything under `src/` | `npm run verify:render` for screenshot and console evidence, then judgment on the maintained server |
| Server / adapters | `npm run verify:server` |
| Structure / docs | `npm run verify:architecture` (includes root-doc parity) |
| Retained artifacts | `npm run check:artifacts` |
| Integration replay | `npm run test:integration` |
| Sprite assets / `manifest.yaml` | `npm run sprites:audit-refresh`; visuals: `npm run sprites:capture-fresh` then `npm run sprites:visual-diff` |
| World buildings / terrain config | `npm run world:validate-buildings`; `npm run world:validate-terrain` |
| Broad regression | `npm run validate:quick` (fast); `npm run validate:full` (CI) |
| Release gate | `npm run gate:release` |

Set `CLAUDEVILLE_TEST_TMPDIR` to a writable directory when a sandbox cannot write to its default temp directory. Browser judgment remains manual; `verify:render` automates evidence capture.

## Git Hygiene

- Re-run `git status --short` before editing, committing, or handing off. Preserve unrelated modifications and untracked files; never absorb, revert, stage, or format them.
- Do not run destructive commands such as `git reset --hard`, `git checkout --`, `git restore`, `git clean`, `rm -rf`, stash deletion, bulk formatters, or port-killing commands without explicit approval.
- Do not change remotes, branches, or fork workflow unless asked. Contributor setup and publication details live in [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Claude Code Git Hygiene is enforced by `.claude/settings.json`; Codex relies on its sandbox.

## Changelog

Before pushing a release, prepend `CHANGELOG.md` using this grammar:

| Tier | When | Header syntax |
| --- | --- | --- |
| Named release | New feature or meaningful addition | `## v0.X.Y — *Release Name* · Mon DD, YYYY` |
| Hotfix | Bug fix or tiny patch | `## v0.X.Y.Z · Mon DD, YYYY — Hotfix` |

Versioning rules:

- `0.X.0` — major milestone: new provider, rendering system, or large feature set.
- `0.X.Y` — named minor release: smaller feature or meaningful UX addition.
- `0.X.Y.Z` — hotfix: bug fix or tiny patch with no new behaviour.

Release names should be short, evocative, and medieval/RPG-themed; hotfixes have no name.

Run `npm run release:check -- <version>` to validate the top entry, then `npm run release:prepare -- <version> --write` to bump `package.json` and `claudeville/index.html`; `npm run release:verify` runs inside `gate:release`. The tag/GitHub-release steps live in CONTRIBUTING.md and `.claude/skills/release/SKILL.md`.
