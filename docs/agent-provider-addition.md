# Provider, Model, And Agent Addition Runbook

Use this runbook when adding a new CLI provider, a new model for an existing provider, or a new visual identity/sprite variant. Keep the app desktop-only and zero-build.

## Common Contract

Every adapter-backed session should normalize unsupported features to `null`, `[]`, or `{}` instead of omitting fields where possible.

Required session-list fields:

| Field | Default when unsupported | Notes |
| --- | --- | --- |
| `provider` | required | Stable id consumed by registry, UI, and visual identity. |
| `sessionId` | required | Unique across providers; prefix if provider ids can collide. |
| `project` | `null` | Absolute path when available. |
| `model` | `'unknown'` or provider fallback | Free-form provider model string. |
| `status` | `'active'` | Client may infer idle/ended states later. |
| `lastActivity` | file mtime or `Date.now()` fallback | Millisecond epoch; sort key. |
| `lastTool` | `null` | Most recent tool name. |
| `lastMessage` | `null` | Short assistant/user-facing summary. |
| `tokenUsage` | `null` | Use normalized aliases documented in `claudeville/adapters/README.md`. |
| `gitEvents` | `[]` | Commit/push events only; omit dry-runs. |

Detail payloads should return `{ sessionId, toolHistory, messages, tokenUsage }` with empty arrays or `null` for unsupported sections.

## Track A: New Provider

1. Add `claudeville/adapters/<provider>.js` implementing the adapter contract from `claudeville/adapters/README.md`.
2. Register it in `claudeville/adapters/index.js` and confirm `/api/providers` reports the provider only when its local source directory exists.
3. Normalize session fields at the adapter boundary. Provider-specific record shapes should not leak into UI components.
4. Add watch paths for live updates. Prefer directory watches with filters over one watcher per file.
5. Add a provider entry under `defaults` in `claudeville/src/config/models.json`. It is the fallback pricing, context-window, mood, and visual identity used when no model row matches that provider.
6. Add a registry row for each initially supported model, then run `npm run models:generate` and resolve representative raw model strings with `npm run models:resolve <provider> <model>`.
7. Check `claudeville/src/application/AgentManager.js` handling for provider id, role, project grouping, status fallback, and parent/child relationships.
8. Update rendering policy in `claudeville/src/presentation/shared/ModelVisualIdentity.js` or `claudeville/src/domain/value-objects/AgentMood.js` only when the provider introduces a new `modelClass`, effort tier, equipment rule, or insignia rule. Registry-backed labels, colors, sprites, context windows, and mood values belong in `models.json`.
9. Add provider fixtures and tests, then smoke Dashboard cards, Sidebar rows, Activity Panel detail, and World sprites.
10. Update docs: `README.md`, `claudeville/adapters/README.md`, and this runbook when the contract changes.

## Track B: New Model For Existing Provider

1. Confirm the adapter already passes the model string through unchanged.
2. Add one ordered row to `claudeville/src/config/models.json`. Include a unique `id`, provider, ordered match aliases, one representative raw `sample`, display identity, model class/tier, mood, sprite/palette data, context window, and all four per-million-token pricing fields. Put a specific match before any broader family match because first match wins.
3. Run `npm run models:generate` to refresh the committed ESM and CommonJS modules. Do not edit `claudeville/src/config/models.generated.js` or `claudeville/src/config/models.generated.cjs` directly.
4. Run `npm run models:resolve <provider> <model>` with the raw model string and inspect the selected row, identity, context window, and rates before continuing.
5. Add the raw model string as a fixture line for the relevant adapter. Keep aliases on the same registry row rather than creating duplicate identities.
6. Run the registry, pricing, behavior, and adapter checks from the Validation Matrix. Add focused assertions when the new row introduces behavior that existing registry-completeness coverage does not exercise.
7. If the row uses a new `modelClass` or effort policy, update the rendering-policy code in `claudeville/src/presentation/shared/ModelVisualIdentity.js` or `claudeville/src/domain/value-objects/AgentMood.js`. If it needs a new sprite, follow Track C.
8. Run the render smoke with a fixture using the new model string, then add the user-visible change to `CHANGELOG.md`.

## Track C: New Visual Identity Or Sprite Variant

1. Add manifest entries under `claudeville/assets/sprites/manifest.yaml`; keep sprite IDs stable and descriptive, and record the source generation dimensions in `generationSize` for character entries.
2. Generate or add PNGs using the manifest-first workflow in [`scripts/sprites/generate.md`](../scripts/sprites/generate.md).
3. Point the relevant model registry row or provider default at the new sprite id and palette. Update `claudeville/src/presentation/shared/ModelVisualIdentity.js` only for effort/accessory/equipment policy that cannot be represented by registry data.
4. Verify `claudeville/src/presentation/dashboard-mode/AvatarCanvas.js`, World mode sprite composition, Activity Panel, and Dashboard cards all use the shared identity mapping.
5. Run sprite validation when dev dependencies are available.

## Validation Matrix

Backend/provider changes:

```bash
npm run check:adapters
npm run check:services
node --check claudeville/adapters/<provider>.js
node --check claudeville/adapters/index.js
node scripts/smoke/adapters.mjs
```

The adapter smoke currently covers Claude fixture behavior, not every provider. Run `npm run check:git-events` when provider changes affect git command extraction.

Model registry changes:

```bash
npm run models:check
npm run models:resolve <provider> <model>
node --test scripts/tests/model-registry.test.mjs
node --test scripts/tests/r2-02.pricing.test.mjs
npm run verify:render
```

Also run the existing adapter checks above when a fixture or parser changes. Run `scripts/tests/r2-06.model-behaviour.test.mjs` directly when the row adds a new mood, class, or effort-policy behavior.

Frontend identity changes use `npm run verify:render` for the isolated World, Dashboard, selection, and Activity Panel smoke. Follow with a manual pass on the maintained server when visual judgment is required.

Sprite changes:

```bash
npm run sprites:audit-refresh
npm run sprites:capture-fresh
npm run sprites:visual-diff
```

Docs-only changes:

```bash
git diff -- docs README.md AGENTS.md CLAUDE.md claudeville/CLAUDE.md
git status --short
```

The coordinator runs the broad validation gate. For a model change, the focused commands above provide the fast feedback loop.
