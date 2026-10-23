# Pimote

## Vision

To build the IDE of the future.

Pimote is a PWA + Node.js server for remote access to pi (a coding agent), plus a native Android client for voice-first usage including Android Auto. Workspaces: `server/` (Node.js HTTP+WS), `client/` (SvelteKit PWA), `packages/` (published npm packages including `@pimote/sdk`), `shared/` (protocol types), and `mobile/android/` (native Kotlin app, Docker-based Gradle build via `make android-build` / `make android-test`).

## Project References

- **Codemap**: [codemap.md](codemap.md) — module map, responsibilities, dependencies, file ownership
- **Glossary**: [glossary.md](glossary.md) — the project's domain language — use its terms in code, docs, and conversation
- **Deployment**: [Deployment.md](Deployment.md) — local hosting setup, systemd service, make targets (gitignored)

## Maintenance Instructions

If `codemap.md` is missing or feels stale relative to what you find, say so — don't silently work around it.

## Pulling Features

A product manager persona exists in `../product-manager` if the user asks about pulling features or the backlog. spin up a long lived subagent in that cwd and interact with it.
