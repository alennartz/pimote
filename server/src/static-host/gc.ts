/**
 * Boot-time garbage collection of the per-session static-host persistence dir.
 *
 * Reads `storeDir`, deletes any `<sessionId>.json` whose sessionId is not in
 * `validSessionIds`. The directory not existing is not an error (returns OK
 * without doing anything). Has no knowledge of the registry, the extension,
 * or the HTTP layer.
 *
 * Called from `server/src/index.ts` after `FolderIndex` initialisation and
 * before `server.start()` so the HTTP route never sees a stale slug pointing
 * at a folder that the agent has long since deleted.
 */
export async function gcStaticHostStore(_args: { storeDir: string; validSessionIds: Set<string> }): Promise<void> {
  throw new Error('not implemented');
}
