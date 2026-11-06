import type { HubActivityPort } from './manager/types.js';

export interface HubActivitySources {
  sessionWorkingDirectories(): Promise<ReadonlyArray<string>>;
  externalPiWorkingDirectories(): Promise<ReadonlyArray<string>>;
}

export class HubActivity implements HubActivityPort {
  constructor(private readonly sources: HubActivitySources) {}

  async findBusyPaths(_paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    throw new Error('not implemented');
  }
}
