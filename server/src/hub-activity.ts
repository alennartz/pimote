import { resolve, sep } from 'node:path';
import type { HubActivityPort } from './manager/types.js';

export interface HubActivitySources {
  sessionWorkingDirectories(): Promise<ReadonlyArray<string>>;
  externalPiWorkingDirectories(): Promise<ReadonlyArray<string>>;
}

/** Whether `child` is `ancestor` itself or lives strictly below it. */
function isWithin(child: string, ancestor: string): boolean {
  return child === ancestor || child.startsWith(ancestor + sep);
}

export class HubActivity implements HubActivityPort {
  constructor(private readonly sources: HubActivitySources) {}

  /** The subset of `paths` whose subtree contains a live session or external
   *  pi working directory. Either source failing rejects: a disband guard
   *  must fail closed, never wave the hub through. */
  async findBusyPaths(paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    const [sessions, external] = await Promise.all([this.sources.sessionWorkingDirectories(), this.sources.externalPiWorkingDirectories()]);
    const workingDirectories = [...sessions, ...external].map((directory) => resolve(directory));
    const busy: string[] = [];
    for (const requested of paths) {
      const base = resolve(requested);
      if (workingDirectories.some((directory) => isWithin(directory, base))) busy.push(requested);
    }
    return busy;
  }
}
