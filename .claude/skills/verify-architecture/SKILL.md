---
name: verify-architecture
description: Route ClaudeVille architecture verification to its executable check after structural, adapter, CSS, server-bind, dependency, or root-agent-doc changes. Never mutates files or starts a server.
---

# Architecture Verification

Authoritative docs: `AGENTS.md` and `claudeville/CLAUDE.md`.

## When to use

Run after adding or moving source layers, adapters, CSS overlays, dependencies, server configuration, or root agent documentation.

## Inputs

No inputs. Run from the repository root.

## Steps

```bash
npm run verify:architecture
```

## Verification

Exit 0 and `architecture check passed` are success. On failure, use each named file or contract in the output as the repair target, then rerun the same command.

## Never

Do not hand-reproduce the checks, mutate files automatically, or start, stop, or probe a server.
