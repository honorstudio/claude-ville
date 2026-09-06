# Release workflow and retained artifacts

**Status:** `ready` · read-only review · Codex `sol low` · session `01a062b9-1055-7c72-9e7d-b25dae5b20b1` · 148s · 2026-09-02

Slice 5 of the six-part agentic-DX review. Consolidated into `agents/plans/claudeville-agentic-dx-plan.md`.

## Findings

1. Release metadata is manually duplicated and has already developed inconsistent semantics. `package.json` stores the full version (`0.39.1`) while the UI displays only `v0.39` ([package.json:3](package.json:3), [claudeville/index.html:34](claudeville/index.html:34)). AGENTS documents those different shapes but does not define the transformation for hotfixes or patch releases ([AGENTS.md:107](AGENTS.md:107)). History shows the UI sometimes displayed full patch versions through `v0.34.2`, then reverted to major/minor for `v0.35+`; an agent cannot infer the intended rule reliably.

2. Actual release practice is less deterministic than the documented “release commit → push → tag that commit → GitHub release” flow ([AGENTS.md:111](AGENTS.md:111)). Most recent tags point at `release: v…` commits, but exceptions include:

   - `v0.36.0` points to `38621238` (`fix(gpu): …`), not a release-named commit.
   - `v0.37.0` is `e7737d5e` with a `perf:` subject.
   - `v0.39.1` points to follow-up docs commit `7c94666e`, not release commit `67ce2064`.
   - `v0.20.0` is now tagged at `f7f9d05e`, consistent with the documented backfill incident ([AGENTS.md:115](AGENTS.md:115)).

   This makes “the release commit” ambiguous for agents and automation.

3. Changelog headers are mostly machine-parseable, but the documented grammar does not describe the historical file. Current formats are explicit at [AGENTS.md:93](AGENTS.md:93), yet older hotfixes contain date ranges, e.g. `May 5–16` and `Apr 29–30` ([CHANGELOG.md:1206](CHANGELOG.md:1206), [CHANGELOG.md:1244](CHANGELOG.md:1244)), and named releases also use ranges ([CHANGELOG.md:1297](CHANGELOG.md:1297)). A strict validator must validate the new top entry only or grandfather historical headers.

4. The changelog viewer has a second, independent parser. The server serves the raw file ([claudeville/server.js:703](claudeville/server.js:703)); `TopBar._changelogToHtml()` separately recognizes named/hotfix headers using permissive, non-anchored regexes ([claudeville/src/presentation/shared/TopBar.js:1329](claudeville/src/presentation/shared/TopBar.js:1329), [claudeville/src/presentation/shared/TopBar.js:1344](claudeville/src/presentation/shared/TopBar.js:1344)). An invalid release header can therefore be silently omitted from the modal rather than rejected. The release validator should not reuse this presentation parser: it needs strict validation and structured section extraction, while the viewer needs safe rendering.

5. The release gate validates code but not release metadata. `gate:release` runs quick validation and smoke tests ([package.json:44](package.json:44)), but nothing checks package version, UI version, top changelog entry, tag existence, or extracted release notes. Agents can complete an expensive release gate and still ship inconsistent metadata.

6. The retained-artifact index is already incomplete. `agents/README.md` calls itself the current inventory and says statuses mirror artifacts ([agents/README.md:11](agents/README.md:11)), but omits:

   - `agents/NFS-5.md`, an implemented performance plan with owner, date, status, and seven linked investigations ([agents/plans/nfs-5.md](../../plans/nfs-5.md)).
   - `agents/research/nfs-5/`.
   - `agents/research/claudeville-agentic-dx-review/`.

   The index has only two research entries ([agents/README.md:27](agents/README.md:27)). `NFS-5.md` belongs under `agents/plans/nfs-5.md`; its current root placement violates the documented artifact taxonomy ([agents/README.md:3](agents/README.md:3)).

7. Plan status syntax is recognizable but not fully standardized. Most plans use `**Status:**`, yet values vary in code formatting and phrasing ([agents/plans/claudeville-comprehensive-remediation-plan.md:3](agents/plans/claudeville-comprehensive-remediation-plan.md:3), [agents/plans/claudeville-semantic-diorama-rendering-plan.md:3](agents/plans/claudeville-semantic-diorama-rendering-plan.md:3)). The index records two prior stale-status corrections ([agents/README.md:20](agents/README.md:20), [agents/README.md:22](agents/README.md:22)), demonstrating that manual synchronization fails.

8. `open-followups.md` is useful as a technical ledger—items have source, trigger, status, and measurements ([agents/plans/open-followups.md:24](agents/plans/open-followups.md:24))—but is stale and weakly actionable. Its checkout marker remains `v0.37.0` ([agents/plans/open-followups.md:5](agents/plans/open-followups.md:5)); entries have no stable ID, owner, added/last-reviewed date, or target milestone. The “long pressure soak before a release push” is still marked open despite later releases ([agents/plans/open-followups.md:58](agents/plans/open-followups.md:58)).

9. PR verification requests do not match AGENTS’ evidence requirements. The template only provides generic checkboxes for “focused checks,” docs, screenshots, and versioning ([.github/pull_request_template.md:9](.github/pull_request_template.md:9)). It does not ask for commands/results, manual World/Dashboard checks, pre-existing failures, affected validation tier, or release/tag evidence required by [AGENTS.md:56](AGENTS.md:56) and [AGENTS.md:111](AGENTS.md:111).

10. Issue templates collect reproduction context but not verification-ready acceptance evidence. Bug reports make reproduction mandatory but environment and logs optional ([.github/ISSUE_TEMPLATE/bug_report.yml:35](.github/ISSUE_TEMPLATE/bug_report.yml:35)); visual reports do not require viewport or screenshots ([.github/ISSUE_TEMPLATE/world_visual_issue.yml:33](.github/ISSUE_TEMPLATE/world_visual_issue.yml:33)); provider reports omit Grok and OMP from the provider dropdown ([.github/ISSUE_TEMPLATE/provider_support.yml:10](.github/ISSUE_TEMPLATE/provider_support.yml:10)). Agents must reconstruct missing context before implementation.

11. Git hygiene is policy-only. The destructive-command prohibition is clear ([AGENTS.md:83](AGENTS.md:83)), but lacks mechanical enforcement. Broad substring blocking would create harmful false positives: `git restore --staged` only unstages, while `rm -rf node_modules/.cache` may be intentional cleanup.

## Proposals

1. **Dependency-free release toolchain** — Effort: M; impact: every release, maintainer and release agents.

   Add:

   - `scripts/release/changelog.mjs`: pure `parseChangelog()`, `parseReleaseHeader()`, and `extractReleaseSection()`.
   - `scripts/release/prepare.mjs`.
   - `scripts/tests/release-changelog.test.mjs`.
   - `package.json` scripts `release:check` and `release:prepare`.

   CLI: `node scripts/release/prepare.mjs <version> [--write] [--tag] [--commit <sha>]`. Default is dry-run: validate target/version syntax, require the first `##` entry to match exactly, show package/index diffs, print extracted notes and the exact `gh release create` command. `--write` updates package JSON and `.topbar__version`; `--tag` requires clean metadata, absent local tag, and creates only a local annotated tag at `--commit` or `HEAD`—never pushes or invokes `gh`.

   Define UI version explicitly as `v<major>.<minor>`, preserving current `v0.39`; full version stays in package/changelog/tag.

   Acceptance: parser tests cover named release, hotfix, section boundary, mismatched target, malformed top header, and historical date-range tolerance below the top entry; dry-run changes no files; `--write` yields matching metadata; output notes equal the target changelog section verbatim. Risk: automating tag creation can tag the wrong commit; mitigate with dry-run default, clean-tree/HEAD display, explicit confirmation text, and no remote mutation.

2. **Release skill as a thin operator guide** — Effort: S; impact: Claude Code release tasks.

   Add `.claude/skills/release/SKILL.md` wrapping the script, because release work includes judgment and remote steps beyond parsing. It should require: inspect status; choose named vs hotfix; write changelog; run dry-run; run `--write`; run `npm run gate:release`; review diff; commit; push only when requested; create/push tag; extract notes; run the printed `gh release` command; verify tag/release; rerun status. It must state that `--tag` is local-only and that backfills use `--latest=false`.

   Acceptance: an agent can execute a release without manually editing version strings or copying notes. Risk: docs and script can drift; SKILL should delegate syntax to `--help`, not duplicate regexes.

3. **Artifact manifest check in quick validation** — Effort: M; impact: every retained plan/research addition.

   Standardize the first metadata block to `**Status:** \`<status>\`` and add `scripts/agents/check-artifacts.mjs` plus `check:artifacts` in `validate:quick`. Parse `agents/README.md` tables and assert every `agents/plans/*.md`, `agents/research/*/`, and `agents/handover/*.md` is indexed exactly once, targets exist, and plan status matches exactly.

   Move `agents/NFS-5.md` to `agents/plans/nfs-5.md` and index both it and `research/nfs-5/`; index the agentic-DX research directory when retained.

   Acceptance: current omissions fail with actionable paths; mismatched status fails; deleting or adding an artifact requires one index edit. Risk: temporary in-progress research may fail CI; convention should permit `agents/research/<slug>/.draft` exclusion or require work-in-progress outside retained `/agents`.

4. **Make follow-ups assignable** — Effort: S; impact: planning and handoffs.

   Give each open item `ID`, `Owner`, `Added`, `Last reviewed`, and `Target/trigger`; update the document-level checkout marker during release preparation. Add checks for unique IDs and required fields.

   Acceptance: every unchecked item has ownership or explicit `unassigned`, a review date, source link, and trigger. Risk: dates can still become stale; validator should enforce presence, not arbitrary freshness.

5. **Evidence-oriented contribution templates** — Effort: S; impact: every PR and reported defect.

   Update `.github/pull_request_template.md` with “Changed paths,” “Commands and results,” “Manual browser evidence / not applicable,” “Pre-existing failures,” and release tag/GitHub-release verification. Make bug environment required; make visual viewport and capture evidence required-or-explained; add Grok and OMP to provider options.

   Acceptance: a PR states exact executed commands and results, not merely checked boxes. Risk: extra friction for docs-only PRs; include explicit “N/A — reason.”

6. **Token-aware destructive-command deny list** — Effort: S; impact: all tool-driven changes.

   The hook reviewer should deny:

   - `git reset --hard` and `git reset --merge|--keep`.
   - `git checkout -- <path>` and checkout of paths from `HEAD`/commit.
   - `git restore` when it mutates the worktree; allow `git restore --staged` only when `--worktree` is absent.
   - all `git clean` modes that can delete (`-f`, `-d`, `-x`, `-X`).
   - `git stash drop|clear`.
   - recursive forced deletion: tokenized `rm` options containing both `r/R` and `f`.
   - executables `kill`, `pkill`, `killall`, plus pipelines resolving a port to PIDs and terminating them.

   Match parsed command tokens/AST where available, not substrings. Require explicit approval override. False-positive risks include recoverable cache cleanup, throwaway worktrees, `git clean -n` previews, and `git restore --staged`; previews (`git clean -n/-dn`) and non-worktree unstaging should remain allowed.

## Open questions

- Repository history proves tags, but the allowed offline review cannot verify that every tag has a corresponding GitHub Release or reconstruct the exact historical `gh release` commands.
- It is unclear whether the newly present `agents/research/claudeville-agentic-dx-review/` is intended as retained output or temporary work from the ongoing six-part review; the index should only add it if retention is intended.
