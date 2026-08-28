import type { UpdateStatus } from '../../shared/dist/index.js';

export type { UpdateStatus } from '../../shared/dist/index.js';

export interface UpdateChecker {
  getStatus(): Promise<UpdateStatus | null>;
}

export interface UpdateCheckerOptions {
  currentVersion: string;
  fetchLatestVersion: () => Promise<string>;
  now?: () => number;
  ttlMs?: number;
}

export function createUpdateChecker(_opts: UpdateCheckerOptions): UpdateChecker {
  throw new Error('not implemented');
}
