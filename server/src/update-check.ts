import { gt as semverGt } from 'semver';
import type { UpdateStatus } from '../../shared/dist/index.js';

export type { UpdateStatus } from '../../shared/dist/index.js';

const NPM_LATEST_URL = 'https://registry.npmjs.org/@pimote/pimote/latest';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface UpdateChecker {
  getStatus(): Promise<UpdateStatus | null>;
}

export interface UpdateCheckerOptions {
  currentVersion: string;
  fetchLatestVersion: () => Promise<string>;
  now?: () => number;
  ttlMs?: number;
}

/** Compute the notification payload for two semver strings without I/O. */
function computeUpdateStatus(currentVersion: string, latestVersion: string): UpdateStatus | null {
  if (!semverGt(latestVersion, currentVersion)) return null;

  return {
    currentVersion,
    latestVersion,
    releaseUrl: `https://github.com/alennartz/pimote/releases/tag/pimote-v${latestVersion}`,
  };
}

export function createUpdateChecker(opts: UpdateCheckerOptions): UpdateChecker {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  let checkedAt: number | null = null;
  let cachedStatus: UpdateStatus | null = null;
  let inFlight: Promise<UpdateStatus | null> | null = null;

  async function refresh(): Promise<UpdateStatus | null> {
    try {
      const latestVersion = await opts.fetchLatestVersion();
      cachedStatus = computeUpdateStatus(opts.currentVersion, latestVersion);
    } catch {
      // Keep the previous result when the registry is unavailable. A cold
      // failure therefore resolves to null, while a refresh failure does not
      // make an already-visible notification disappear.
    } finally {
      // Failed attempts count toward the TTL too, otherwise a broken registry
      // would be hit on every accepted connection.
      checkedAt = now();
    }

    return cachedStatus;
  }

  return {
    getStatus(): Promise<UpdateStatus | null> {
      const currentTime = now();
      if (checkedAt !== null && currentTime - checkedAt < ttlMs) {
        return Promise.resolve(cachedStatus);
      }
      if (inFlight) return inFlight;

      inFlight = refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

/** Fetch the latest published pimote version from npm's registry endpoint. */
export async function fetchLatestVersionFromNpm(): Promise<string> {
  const response = await fetch(NPM_LATEST_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('npm registry response is not an object');
  }

  const version = (payload as Record<string, unknown>).version;
  if (typeof version !== 'string') {
    throw new Error('npm registry response has no version');
  }

  return version;
}
