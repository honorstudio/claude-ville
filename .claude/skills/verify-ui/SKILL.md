---
name: verify-ui
description: Gather automated ClaudeVille UI render evidence and guide read-only visual judgment after presentation, CSS, or asset changes. Never starts, stops, or kills the maintained server.
---

# UI Verification

Authoritative docs: `AGENTS.md` and the READMEs under `claudeville/src/presentation/`.

## When to use

Run after presentation, CSS, interaction, rendering, or visual-asset changes.

## Inputs

The changed behavior and review target. Run commands from the repository root.

## Steps

```bash
npm run verify:render
```

Review the printed screenshots and diagnostics. For judgment-heavy review, open the operator-maintained `http://localhost:4000` read-only and inspect the changed behavior in World and Dashboard as relevant.

## Verification

Require an exit-0 render smoke with its artifact directory, plus a concise record of the visual judgment and any relevant browser errors.

## Never

Do not start, stop, restart, kill, or take ownership of the maintained server or port 4000. Do not mutate application data during visual review.
