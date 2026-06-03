# Pimote

Pimote is a PWA + Node.js server for remote access to pi (a coding agent), plus a native Android client for voice-first usage including Android Auto. Workspaces: `server/` (Node.js HTTP+WS), `client/` (SvelteKit PWA), `packages/` (published npm packages including `@pimote/panels`), `shared/` (protocol types), and `mobile/android/` (native Kotlin app, Docker-based Gradle build via `make android-build` / `make android-test`).

## Read the codemap first

Before grepping, finding, or otherwise searching this repo to orient yourself, **read `codemap.md` at the repo root**. It is the authoritative map of what lives where, how the pieces fit together, and how to build/test each surface.

If `codemap.md` is missing or feels stale relative to what you find, say so — don't silently work around it.
