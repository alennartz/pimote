import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface PimoteConfig {
  roots: string[];
  idleTimeout: number;
  bufferSize: number;
  port: number;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidEmail?: string;
}

export const CONFIG_PATH = join(homedir(), '.config', 'pimote', 'config.json');

const DEFAULTS = {
  idleTimeout: 1_800_000, // 30 minutes
  bufferSize: 1000,
  port: 3000,
} as const;

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
        `    "roots": ["/path/to/your/project"]\n` +
        `  }\n\n` +
        `Optional fields: port (default ${DEFAULTS.port}), ` +
        `idleTimeout (default ${DEFAULTS.idleTimeout}ms), ` +
        `bufferSize (default ${DEFAULTS.bufferSize})`
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
  if (
    !Array.isArray(obj.roots) ||
    obj.roots.length === 0 ||
    !obj.roots.every((r): r is string => typeof r === 'string')
  ) {
    throw new Error(
      `Config "roots" must be a non-empty array of strings in ${CONFIG_PATH}`
    );
  }

  return {
    roots: obj.roots,
    idleTimeout: typeof obj.idleTimeout === 'number' ? obj.idleTimeout : DEFAULTS.idleTimeout,
    bufferSize: typeof obj.bufferSize === 'number' ? obj.bufferSize : DEFAULTS.bufferSize,
    port: typeof obj.port === 'number' ? obj.port : DEFAULTS.port,
    vapidPublicKey: typeof obj.vapidPublicKey === 'string' ? obj.vapidPublicKey : undefined,
    vapidPrivateKey: typeof obj.vapidPrivateKey === 'string' ? obj.vapidPrivateKey : undefined,
    vapidEmail: typeof obj.vapidEmail === 'string' ? obj.vapidEmail : undefined,
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
  await writeFile(CONFIG_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

  return config;
}
