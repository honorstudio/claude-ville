---
name: verify-server
description: Route ClaudeVille server verification to isolated boot, security, and fatal-error smokes after server, adapter, service, API, or WebSocket changes. Never uses the maintained server or port 4000.
---

# Server Verification

Authoritative docs: `claudeville/CLAUDE.md` and `docs/design-decisions.md`.

## When to use

Run after changes to `server.js`, adapters, services, HTTP APIs, WebSocket behavior, startup, shutdown, or fatal-error handling.

## Inputs

No inputs. Run from the repository root.

## Steps

```bash
npm run verify:server
```

## Verification

Exit 0 means every isolated smoke passed. On failure, the first command and named assertion identify the affected contract; inspect that output and rerun the router command after repair.

## Never

Do not start, stop, kill, or probe the maintained server or port 4000. Do not replace the executable smokes with manual checks.
