---
name: add-provider
description: Route a new ClaudeVille CLI provider through the adapter contract and registry defaults. Use only for a genuinely new provider; never use it for another model on an existing provider or as a substitute for the provider runbook.
---

# Add a provider

## When to use

Use for a new CLI/session source. The authoritative procedure is [Track A in the provider runbook](../../../docs/agent-provider-addition.md#track-a-new-provider). Use `add-model` for models on an existing provider.

## Inputs

- Stable provider id and local discovery source.
- Representative session/detail records and unsupported-field behavior.
- Watch/update behavior, model strings, default identity, pricing, and context window.
- Documentation and release scope.

## Steps

1. Follow Track A in `docs/agent-provider-addition.md` and the contract in `claudeville/adapters/README.md`.
2. Add `claudeville/adapters/<provider>.js`, register it in `claudeville/adapters/index.js`, and add representative records under `scripts/adapters/fixtures/<provider>/`.
3. Add the provider's fallback identity, pricing, and context policy to the `defaults` object in `claudeville/src/config/models.json`; add explicit model rows only for known models.
4. Run `npm run models:generate` and resolve representative model strings with `node scripts/models/resolve.mjs <provider> <model>`.
5. Run `node --check claudeville/adapters/<provider>.js`, `node --check claudeville/adapters/index.js`, `node scripts/smoke/adapters.mjs`, and `npm run check:adapter-fixtures`.
6. Run the remaining validation required by the provider runbook and update its documentation surfaces.

## Verification

- `npm run models:check`
- `node scripts/smoke/adapters.mjs`
- `npm run check:adapter-fixtures`
- `npm run test:unit`
- `npm run validate:quick`

## Never

- Never duplicate adapter parsing in UI code or omit the registry `defaults` entry.
- Never hand-edit generated model modules, touch port 4000, add a build/runtime dependency, or import `claudeville/vendor/*`.
