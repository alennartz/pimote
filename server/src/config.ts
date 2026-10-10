import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { PIMOTE_CONFIG_PATH, PIMOTE_STATE_DIR } from './paths.js';
import { DEFAULT_APP_NAME } from './branding.js';

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface VoiceConfig {
  /** Public WS URL the client opens for WebRTC signalling. */
  speechmuxSignalUrl?: string;
  /** Internal WS URL the voice extension connects to for the LlmBackend protocol. */
  speechmuxLlmWsUrl?: string;
}

export interface PimoteConfig {
  roots: string[];
  /**
   * The manager persona's working directory — distinct from the scan roots. Its entry is excluded
   * from folder listings and trees, so it never renders as a folder row even when it sits inside a
   * scan root. Default `~/.local/state/pimote/manager` (the state-local manager directory); a
   * leading `~`/`~/` is expanded to the home directory at load. Never the home directory or one of
   * its ancestors: pi loads an AGENTS.md into every session below it as ancestor context (review
   * finding 1).
   */
  managerRoot: string;
  /** Directory scanned for user folder-source modules. Default: PIMOTE_FOLDER_SOURCES_DIR. */
  folderSourcesDir?: string;
  idleTimeout: number;
  bufferSize: number;
  port: number;
  /** Display name for the web app and installed PWA (tab title, manifest, app name). Default "Pimote". */
  appName?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  /** Voice interpreter model. Falls back to defaultProvider/defaultModel if absent. */
  defaultInterpreterModel?: string;
  /** Voice worker model for `my-pi` subagent spawns. */
  defaultWorkerModel?: string;
  /** Voice subsystem config. */
  voice?: VoiceConfig;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidEmail?: string;
  /** Check npm for newer pimote releases. Default true. */
  updateCheck?: boolean;
  /** User-defined wrap-tag snippet palette for the AGENTS.md editor toolbar. */
  tagSnippets?: string[];
}

export const CONFIG_PATH = PIMOTE_CONFIG_PATH;

const DEFAULTS = {
  idleTimeout: 1_800_000, // 30 minutes
  bufferSize: 1000,
  port: 3000,
} as const;

/** Default manager root: a dedicated directory inside pimote's state dir. Never `~` — seeding the
 *  manager persona AGENTS.md into the home directory would load it as ancestor context for every
 *  pi session under home (review finding 1). */
const DEFAULT_MANAGER_ROOT = join(PIMOTE_STATE_DIR, 'manager');

/** Expand a leading `~`/`~/` to the home directory; any other value passes through unchanged. */
export function expandHomePath(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
}

/** True when `path` is a strict descendant of `dir` (canonical containment). */
function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Placement guard for the manager root (owner ruling on review findings 1 and
 * 10, split by harm). The boot seeds a persona AGENTS.md there, and pi loads
 * an AGENTS.md into every session at or below its folder as ancestor context.
 * A manager root that is or contains the home directory would silently steer
 * every pi session on the machine toward the manager persona — boot refuses
 * it. Paths must already be canonical.
 *
 * A manager root inside or equal to a scan root is legal: its only consequence
 * is a folder row beside the pinned manager surface, and the listing assembly
 * (`RepoIndex` `excludeEntryPaths`) drops that row.
 *
 * Returns the error message, or null when the placement is safe.
 */
export function managerRootPlacementError(managerRoot: string, home: string): string | null {
  if (managerRoot === home || isWithin(home, managerRoot)) {
    return (
      `Config "managerRoot" (${managerRoot}) must not be or contain the home directory (${home}). ` +
      'The boot-seeded manager persona AGENTS.md would load as ancestor context for every pi session below it. ' +
      'Set managerRoot to a dedicated directory outside your home tree.'
    );
  }
  return null;
}

export async function loadConfig(): Promise<PimoteConfig> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, 'utf-8');
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Config file not found at ${CONFIG_PATH}\n\n` +
          `Create it with at least a "roots" array, e.g.:\n\n` +
          `  {\n` +
          `    "roots": ["/path/to/scan/roots"]\n` +
          `  }\n\n` +
          `Optional fields: port (default ${DEFAULTS.port}), ` +
          `idleTimeout (default ${DEFAULTS.idleTimeout}ms), ` +
          `bufferSize (default ${DEFAULTS.bufferSize}), ` +
          `managerRoot (the manager persona's working directory, default "${DEFAULT_MANAGER_ROOT}"), ` +
          `appName (display name for the web app and installed PWA, default "${DEFAULT_APP_NAME}")`,
        { cause: err },
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse ${CONFIG_PATH} as JSON`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config at ${CONFIG_PATH} must be a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  // Validate roots
  if (!Array.isArray(obj.roots) || obj.roots.length === 0 || !obj.roots.every((r): r is string => typeof r === 'string')) {
    throw new Error(`Config "roots" must be a non-empty array of strings in ${CONFIG_PATH}`);
  }

  // Validate managerRoot — string-based like roots; deliberately no filesystem-existence checks.
  if (obj.managerRoot !== undefined && (typeof obj.managerRoot !== 'string' || obj.managerRoot.length === 0)) {
    throw new Error(`Config "managerRoot" must be a non-empty string in ${CONFIG_PATH}`);
  }

  return {
    roots: obj.roots,
    managerRoot: expandHomePath(typeof obj.managerRoot === 'string' ? obj.managerRoot : DEFAULT_MANAGER_ROOT, homedir()),
    // Deprecated legacy key read-compat: `projectSourcesDir` is superseded by `folderSourcesDir` (will be retired).
    folderSourcesDir: typeof obj.folderSourcesDir === 'string' ? obj.folderSourcesDir : typeof obj.projectSourcesDir === 'string' ? obj.projectSourcesDir : undefined,
    idleTimeout: typeof obj.idleTimeout === 'number' ? obj.idleTimeout : DEFAULTS.idleTimeout,
    bufferSize: typeof obj.bufferSize === 'number' ? obj.bufferSize : DEFAULTS.bufferSize,
    port: typeof obj.port === 'number' ? obj.port : DEFAULTS.port,
    appName: typeof obj.appName === 'string' ? obj.appName : undefined,
    defaultProvider: typeof obj.defaultProvider === 'string' ? obj.defaultProvider : undefined,
    defaultModel: typeof obj.defaultModel === 'string' ? obj.defaultModel : undefined,
    defaultThinkingLevel: typeof obj.defaultThinkingLevel === 'string' ? obj.defaultThinkingLevel : undefined,
    defaultInterpreterModel: typeof obj.defaultInterpreterModel === 'string' ? obj.defaultInterpreterModel : undefined,
    defaultWorkerModel: typeof obj.defaultWorkerModel === 'string' ? obj.defaultWorkerModel : undefined,
    voice: parseVoiceConfig(obj.voice),
    vapidPublicKey: typeof obj.vapidPublicKey === 'string' ? obj.vapidPublicKey : undefined,
    vapidPrivateKey: typeof obj.vapidPrivateKey === 'string' ? obj.vapidPrivateKey : undefined,
    vapidEmail: typeof obj.vapidEmail === 'string' ? obj.vapidEmail : undefined,
    updateCheck: typeof obj.updateCheck === 'boolean' ? obj.updateCheck : undefined,
    tagSnippets: Array.isArray(obj.tagSnippets) ? obj.tagSnippets.filter((s): s is string => typeof s === 'string') : undefined,
  };
}

function parseVoiceConfig(v: unknown): VoiceConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  return {
    speechmuxSignalUrl: typeof o.speechmuxSignalUrl === 'string' ? o.speechmuxSignalUrl : undefined,
    speechmuxLlmWsUrl: typeof o.speechmuxLlmWsUrl === 'string' ? o.speechmuxLlmWsUrl : undefined,
  };
}

export async function ensureVapidKeys(config: PimoteConfig): Promise<PimoteConfig> {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    return config;
  }

  const webpush = await import('web-push');
  const keys = webpush.default.generateVAPIDKeys();

  config.vapidPublicKey = keys.publicKey;
  config.vapidPrivateKey = keys.privateKey;

  // Read existing file to preserve all fields, then merge in new keys
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // If file doesn't exist or can't be parsed, start fresh
  }

  existing.vapidPublicKey = keys.publicKey;
  existing.vapidPrivateKey = keys.privateKey;

  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  // Atomic write (tmp + rename) so a crash mid-write can't corrupt the config.
  const tmpPath = CONFIG_PATH + '.tmp';
  await writeFile(tmpPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, CONFIG_PATH);

  return config;
}
