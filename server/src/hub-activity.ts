import { resolve, sep } from 'node:path';
import type { HubActivityPort } from './manager/types.js';

export interface HubActivitySources {
  /** Close idle, observerless session slots rooted at or below any requested
   *  path through the canonical session lifecycle; return the requested paths
   *  that still host a live session. */
  closeIdleSessionsAt(paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>>;
  externalPiWorkingDirectories(): Promise<ReadonlyArray<string>>;
}

/** Whether `child` is `ancestor` itself or lives strictly below it. */
function isWithin(child: string, ancestor: string): boolean {
  return child === ancestor || child.startsWith(ancestor + sep);
}

export class HubActivity implements HubActivityPort {
  constructor(private readonly sources: HubActivitySources) {}

  /** Close idle session slots in the requested subtrees, then report the
   *  requested paths that remain busy: a session that kept working or kept
   *  its observers, and external pi processes. Either source failing rejects:
   *  a disband guard must fail closed, never wave the hub through. */
  async closeIdleSessionsAt(paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    const [sessions, external] = await Promise.all([this.sources.closeIdleSessionsAt(paths), this.sources.externalPiWorkingDirectories()]);
    const workingDirectories = [...sessions, ...external].map((directory) => resolve(directory));
    const busy: string[] = [];
    for (const requested of paths) {
      const base = resolve(requested);
      if (workingDirectories.some((directory) => isWithin(directory, base))) busy.push(requested);
    }
    return busy;
  }
}
