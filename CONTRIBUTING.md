# Contributing To ClaudeVille

ClaudeVille is a local-first dashboard for watching AI coding CLI sessions. Small, focused changes are easiest to review and keep the village stable.

## Good Contribution Lanes

- Provider adapter fixes with redacted fixtures or clear reproduction notes.
- Documentation fixes, setup notes, and API examples.
- World, Dashboard, and sprite visual fixes with screenshots.
- Focused UI quality improvements that preserve the current design language.
- New provider proposals after the data source, privacy boundary, and maintenance cost are clear.

Feature ideas usually work best in GitHub Discussions before implementation.

## Before Editing

1. Read `AGENTS.md` for repo workflow, validation, git hygiene, and desktop-only constraints.
2. Read the nearest area README for the files you plan to touch.
3. Keep provider session files read-only. ClaudeVille observes local CLI logs; it must not mutate them.
4. Keep changes narrow. Avoid unrelated refactors, generated churn, and formatting sweeps.
5. Include screenshots for World, Dashboard, or visual asset changes.

## Local Setup

```bash
npm run dev
```

Open `http://localhost:4000`.

The runtime does not need installed packages. Run `npm install` only when you intentionally need development scripts that import packages, such as sprite validation, visual diffs, or Playwright capture.

## Validation

Match validation to what changed. Common checks:

```bash
npm run validate:quick
npm run validate:full
npm run verify:architecture
npm run verify:server
npm run verify:render
```

For UI or canvas changes, keep the screenshot and console evidence from `verify:render`, then use the operator-maintained server for visual judgment in World and Dashboard modes. The canonical routing table is in [`AGENTS.md`](AGENTS.md#validation).

## Pull Requests

- Explain the user-visible change and why it is needed.
- Link related issues or discussions.
- List focused validation commands and any checks you skipped.
- Include screenshots for visual changes.
- Do not include provider logs, API keys, tokens, private paths, or screenshots with secrets.

## Remotes

- `origin` is the working fork: `https://github.com/TokenBrice/claude-ville.git` (fetch and push).
- Maintainers may optionally add `upstream` as fetch-only: `https://github.com/honorstudio/claude-ville.git`. It is not present by default.
- Do not change remotes, branches, or the fork workflow unless the task explicitly requires it.

## Releases

Choose the changelog tier and header grammar from [`AGENTS.md`](AGENTS.md#changelog). Named releases use short medieval/RPG village names; hotfixes have no name. The release helper validates that the top entry is well-formed, synchronizes the package and UI versions, and prints the publication command:

```bash
npm run release:check -- <version>
npm run release:prepare -- <version> --write
npm run gate:release
```

When publication is explicitly requested:

1. Commit the release files and push `main`.
2. From a clean committed tree, create the annotated tag with `npm run release:prepare -- <version> --tag` and push `v<version>` to `origin`. The tag must point at the release commit; `--target` does not accept a raw SHA, so push the tag first.
3. Run the exact `gh release create` command printed by the helper. Its notes file contains the top `CHANGELOG.md` section verbatim.
4. When backfilling an older version, add `--latest=false` so the newest release remains marked Latest.
5. Verify the remote tag and GitHub release. Every pushed version must have both; no gaps (v0.20.0 was once pushed without one).

The Claude Code release router at [`.claude/skills/release/SKILL.md`](.claude/skills/release/SKILL.md) carries the same safe sequencing and never authorizes publication on its own.
