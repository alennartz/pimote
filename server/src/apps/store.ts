import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppStoreFile, PersistedAppRecord } from './types.js';

export interface AppStore {
  read(): Promise<AppStoreFile>;
  write(file: AppStoreFile): Promise<void>;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isPersistedAppRecord(value: unknown): value is PersistedAppRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.slug === 'string' &&
    typeof record.title === 'string' &&
    typeof record.target === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    (record.description === undefined || typeof record.description === 'string') &&
    (record.createdBySessionId === undefined || typeof record.createdBySessionId === 'string') &&
    (record.folderPath === undefined || typeof record.folderPath === 'string')
  );
}

/** Durable JSON file store for global Apps (`apps.json`), written atomically via temp file + rename. */
export class FileAppStore implements AppStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<AppStoreFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return { version: 1, apps: [] };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Failed to parse Apps store at ${this.filePath} as JSON`, { cause: error });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid Apps store at ${this.filePath}: expected an object`);
    }

    const file = parsed as Record<string, unknown>;
    if (file.version !== 1 || !Array.isArray(file.apps)) {
      throw new Error(`Unsupported Apps store format at ${this.filePath}`);
    }

    const apps: PersistedAppRecord[] = [];
    for (const entry of file.apps) {
      if (!isPersistedAppRecord(entry)) {
        throw new Error(`Invalid App record in ${this.filePath}`);
      }
      apps.push({
        slug: entry.slug,
        title: entry.title,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        target: entry.target,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        ...(entry.createdBySessionId !== undefined ? { createdBySessionId: entry.createdBySessionId } : {}),
        ...(entry.folderPath !== undefined ? { folderPath: entry.folderPath } : {}),
      });
    }

    return { version: 1, apps };
  }

  async write(file: AppStoreFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
    await rename(tmpPath, this.filePath);
  }
}
