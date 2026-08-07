# Pimote

Pimote is a PWA + Node.js server for remote access to pi (a coding agent), plus a native Android client for voice-first usage including Android Auto. Workspaces: `server/` (Node.js HTTP+WS), `client/` (SvelteKit PWA), `packages/` (published npm packages including `@pimote/panels`), `shared/` (protocol types), and `mobile/android/` (native Kotlin app, Docker-based Gradle build via `make android-build` / `make android-test`).

## Project References

- **Codemap**: [codemap.md](codemap.md) — module map, responsibilities, dependencies, file ownership
- **Deployment**: [Deployment.md](Deployment.md) — local hosting setup, systemd service, make targets (gitignored)

## Maintenance Instructions

If `codemap.md` is missing or feels stale relative to what you find, say so — don't silently work around it.
