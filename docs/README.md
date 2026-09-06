# Documentation

ClaudeVille documentation stays current, task-oriented, and close to the code it governs. Historical plans and raw proofs belong under `agents/` only when they remain useful enough to retain.

## Start Here

1. Read the root `README.md` for product shape and quick start.
2. Read `AGENTS.md` or `CLAUDE.md` for shared-checkout rules and validation routing.
3. Read `claudeville/CLAUDE.md` for runtime ownership and invariants.
4. Use the catalog below to find the authoritative contract, runbook, checklist, or reference.

## Documentation Catalog

| Document | Status | Classification | Purpose |
| --- | --- | --- | --- |
| [`docs/README.md`](README.md) | Current | Reference | Indexes maintained documentation and routes contributors to owner-level guidance. |
| [`docs/agent-provider-addition.md`](agent-provider-addition.md) | Current | Runbook | Adds providers or model-registry rows, including fixture and validation routes. |
| [`docs/building-style-contract.md`](building-style-contract.md) | Current | Contract | Defines building silhouette, material, palette, lighting, and landmark-quality rules. |
| [`docs/design-decisions.md`](design-decisions.md) | Current | Reference | Records load-bearing architecture decisions, rationale, and change obligations. |
| [`docs/material-channel-contract.md`](material-channel-contract.md) | Current | Contract | Defines semantic drawables, material channels, sidecars, atlases, and deterministic defaults. |
| [`docs/motion-budget.md`](motion-budget.md) | Current | Contract | Defines animation allocation gates, pulse bands, and reduced-motion fallbacks. |
| [`docs/pixellab-reference.md`](pixellab-reference.md) | Current | Reference | Covers PixelLab capabilities, parameters, lifecycle, and API pitfalls; the generation runbook remains under `scripts/sprites/`. |
| [`docs/rendering-baselines.md`](rendering-baselines.md) | Current | Reference | Defines deterministic renderer evidence, capture metadata, scenario matrix, and performance comparisons. |
| [`docs/troubleshooting.md`](troubleshooting.md) | Current | Runbook | Diagnoses first-hour setup, providers, APIs, graphics, and opt-in hook ingestion. |
| [`docs/visual-experience-crafting.md`](visual-experience-crafting.md) | Current | Reference | Explains how to adapt ClaudeVille's world-metaphor method to other domains. |
| [`docs/world-visual-qa-checklist.md`](world-visual-qa-checklist.md) | Current | Checklist | Reviews deterministic World scenes, visual hierarchy, effects, materials, and regressions. |

## Workflow Index

| Workflow | Authoritative route |
| --- | --- |
| Hook ingestion | [Permission prompts are inferred or arrive late](troubleshooting.md#permission-prompts-are-inferred-or-arrive-late) documents the payload schema and opt-in Claude Code dogfood setup. |
| Screenshot capture | Run `npm run verify:render` for UI screenshot and console evidence. Use `npm run sprites:capture-baseline` or `npm run sprites:capture-fresh`, followed by `npm run sprites:visual-diff`, for sprite comparisons. |
| Sprite generation | Follow [`scripts/sprites/generate.md`](../scripts/sprites/generate.md); use the PixelLab reference only for tool/API specifics. |
| Retained proofs and plans | Check [`agents/README.md`](../agents/README.md) before adding or relying on an artifact. |

## Documentation Rules

- Prefer one maintained authority. Code-owner detail belongs in the nearest README; project-wide decisions belong in the relevant contract or decision record.
- Keep runbooks executable: name exact commands, symptoms, and files. Remove stale line references.
- Keep large proofs and screenshots out of `docs/`; retain them under `agents/research/` only when future work needs them.
- Use English for edited documentation and UI copy.
- Validate structure and links with `npm run verify:architecture`; use `npm run check:artifacts` when retained artifacts change.

## Related Owner Docs

| Location | Purpose |
| --- | --- |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Contribution lanes, setup, remotes, pull requests, and release publication. |
| [`claudeville/CLAUDE.md`](../claudeville/CLAUDE.md) | Server invariants, model registry, frontend ownership, sprites, and event bus. |
| [`claudeville/adapters/README.md`](../claudeville/adapters/README.md) | Adapter contract and per-provider source formats. |
| [World mode README](../claudeville/src/presentation/character-mode/README.md) | Renderer pipeline, selection, draw order, and canvas contracts. |
| [Dashboard mode README](../claudeville/src/presentation/dashboard-mode/README.md) | Card lifecycle, details, and keyboard behavior. |
| [Shared presentation README](../claudeville/src/presentation/shared/README.md) | Shared chrome, Activity Panel, model identity, selection, and detail cache. |
