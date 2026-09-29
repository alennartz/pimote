// Shared pi session-dir encoding for manual-test smokes.
//
// Ground truth (pi SDK 0.87.1,
// node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js,
// getDefaultSessionDirPath): the per-cwd session dir under
// <agentDir>/sessions/ is
//
//   `--${resolvePath(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
//
// i.e. the cwd is RESOLVED first, then leading slash stripped and every
// `/`, `\`, `:` replaced with '-'. SDK history (verified against published
// tarballs): 0.74.0–0.75.x encoded the raw cwd string; 0.76.0+ resolve
// first. Every version keeps the trailing '--'. The two formulas only
// diverge for non-clean cwd strings (relative paths, trailing slashes,
// '..' segments).
//
// Use seedSessionDir() when writing fixtures (always SDK-exact, so the
// real SessionManager.list(cwd) finds them). Use existingSessionDirs()
// when reading or cleaning fixtures that may predate a helper migration —
// it tolerates both the resolved and the raw-string encodings.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** SDK-exact encoding of a cwd into a session dir name (resolve first). */
export function encodeSessionDirName(cwd) {
  return `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`;
}

/** Legacy encoding of a cwd (raw string, no resolve) — pre-0.76 SDKs. */
export function encodeRawSessionDirName(cwd) {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * Canonical dir for seeding a session jsonl for `cwd` under a sessions
 * root. Always the SDK-exact encoding, so SessionManager.list(cwd) —
 * which reads only <sessionsRoot>/<encoded>/ — finds the fixture.
 */
export function seedSessionDir(sessionsRoot, cwd) {
  return join(sessionsRoot, encodeSessionDirName(cwd));
}

/**
 * Every sessions-root subdir a fixture for `cwd` might live in, deduped,
 * SDK-exact first. Use when reading or deleting pre-existing fixtures so
 * ones seeded under either era's encoding are still found.
 */
export function sessionDirCandidates(sessionsRoot, cwd) {
  const names = [encodeSessionDirName(cwd), encodeRawSessionDirName(cwd)];
  return [...new Set(names)].map((name) => join(sessionsRoot, name));
}

/** sessionDirCandidates() filtered down to dirs that exist on disk. */
export function existingSessionDirs(sessionsRoot, cwd) {
  return sessionDirCandidates(sessionsRoot, cwd).filter((dir) => existsSync(dir));
}
