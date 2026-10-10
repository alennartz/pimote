import { realpath } from 'node:fs/promises';
import type { PimoteConfig } from '../config.js';

/** A session's facts, as the attachment rule sees it. */
export interface ManagerAttachmentSession {
  /** The session's working directory. */
  cwd: string;
}

/**
 * Manager extension attachment rule (plan: manager-lifecycle):
 * `loadManagerExtension(session) = canonical(session.cwd) === canonical(config.managerRoot)`.
 *
 * Evaluated once at session assembly, alongside the existing extension
 * factories. Canonical identity (glossary: canonical path) is the real path,
 * so a symlinked manager root and its target attach identically. Equality,
 * not containment: a session below the manager root is an ordinary folder
 * session and never loads the manager extension. No config flag; no runtime
 * toggling. No folder-list session can satisfy the rule: boot rejects a
 * `managerRoot` that equals or contains a scan root
 * (`managerRootPlacementError` in `config.ts`), so the manager root is never
 * a discovered folder row. Known residual: a manager root nested inside a
 * scan root still surfaces as a persona row — its discovery carve-out is
 * deferred to cleanup (review finding 10).
 * Filesystem canonicalization errors propagate to the caller.
 */
export async function loadManagerExtension(session: ManagerAttachmentSession, config: Pick<PimoteConfig, 'managerRoot'>): Promise<boolean> {
  const [cwd, managerRoot] = await Promise.all([realpath(session.cwd), realpath(config.managerRoot)]);
  return cwd === managerRoot;
}
