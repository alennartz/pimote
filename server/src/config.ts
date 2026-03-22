import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface PimoteConfig {
  roots: string[];
  idleTimeout: number;
  bufferSize: number;
  port: number;
}

const CONFIG_PATH = join(homedir(), '.config', 'pimote', 'config.json');

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
  };
}
