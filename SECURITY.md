# Security Policy

## Reporting A Vulnerability

Do not open a public issue for vulnerabilities, exposed secrets, local file disclosure risks, path traversal, parser abuse, or local server access-control problems.

Use GitHub private vulnerability reporting from this repository's **Security** tab when available. Include:

- affected endpoint, file path, or adapter
- impact and prerequisites
- reproduction steps or proof-of-concept details
- whether provider logs, local paths, credentials, tokens, or private session content may be exposed

If private vulnerability reporting is unavailable, contact the maintainer through a private channel before sharing details publicly.

## Scope

In scope:

- `claudeville/server.js` HTTP and WebSocket behavior
- provider adapter parsing and path handling
- local file disclosure or traversal risks
- repository automation and configuration

Out of scope:

- upstream CLI bugs or provider service outages
- reports requiring access to another person's machine or account
- denial-of-service testing without prior coordination
- screenshots, logs, or fixtures that expose private session content without a concrete vulnerability

## Handling

The maintainer will triage credible reports privately, prioritize fixes by severity, and publish public details only after a mitigation is available.

Supported version: the current `main` branch.
