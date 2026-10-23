import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SessionMetadataEntry {
  archived?: boolean;
  archivedAt?: string;
}

interface SessionMetadataFile {
  version: 1;
  sessions: Record<string, SessionMetadataEntry>;
}

export class FileSessionMetadataStore {
  private sessions = new Map<string, SessionMetadataEntry>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SessionMetadataFile>;
      const entries = parsed.sessions ?? {};
      this.sessions = new Map(
        Object.entries(entries).filter(
          ([key, value]) =>
            typeof key === 'string' &&
            typeof value === 'object' &&
            value !== null &&
            (value.archived === undefined || typeof value.archived === 'boolean') &&
            (value.archivedAt === undefined || typeof value.archivedAt === 'string'),
        ) as Array<[string, SessionMetadataEntry]>,
      );
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.sessions = new Map();
        return;
      }
      throw new Error('Failed to load session metadata', { cause: err });
    }
  }

  get(path: string): SessionMetadataEntry | undefined {
    const entry = this.sessions.get(path);
    return entry ? { ...entry } : undefined;
  }

  isArchived(path: string): boolean {
    return this.sessions.get(path)?.archived === true;
  }

  getArchivedLookup(paths: string[]): Map<string, boolean> {
    return new Map(paths.map((path) => [path, this.isArchived(path)]));
  }

  setArchived(path: string, archived: boolean): Promise<void> {
    return this.mutate(async (sessions) => {
      const existing = sessions.get(path) ?? {};
      if (archived) {
        sessions.set(path, {
          ...existing,
          archived: true,
          archivedAt: existing.archivedAt ?? new Date().toISOString(),
        });
      } else {
        if (Object.keys(existing).length === 0) return;
        sessions.delete(path);
      }
      await this.save(sessions);
      this.sessions = sessions;
    });
  }

  delete(path: string): Promise<void> {
    return this.mutate(async (sessions) => {
      if (!sessions.delete(path)) return;
      await this.save(sessions);
      this.sessions = sessions;
    });
  }

  private mutate(operation: (sessions: Map<string, SessionMetadataEntry>) => Promise<void>): Promise<void> {
    const current = this.mutationQueue.then(() => operation(new Map(this.sessions)));
    this.mutationQueue = current.catch(() => undefined);
    return current;
  }

  private async save(sessions: Map<string, SessionMetadataEntry>): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = this.filePath + '.tmp';
      const payload: SessionMetadataFile = {
        version: 1,
        sessions: Object.fromEntries(sessions.entries()),
      };
      await writeFile(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
      await rename(tmpPath, this.filePath);
    } catch (err) {
      throw new Error('Failed to save session metadata', { cause: err });
    }
  }
}
