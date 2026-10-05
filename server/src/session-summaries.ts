import { createReadStream, type Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

/**
 * One on-disk session's list metadata — exactly the fields `list_sessions`
 * puts on the wire, derived by streaming each session file once and keeping
 * only what the list needs. Deliberately not pi's `SessionInfo`: that type
 * also materializes `allMessagesText` (every message's full text joined),
 * which no consumer of this listing reads.
 */
export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

/**
 * The default session directory for a folder. Mirrors pi's
 * `getDefaultSessionDir()` — not re-exported by the package root, so the
 * encoding is reproduced here: resolve the cwd, strip one leading separator,
 * turn remaining separators and colons into dashes, wrap in `--` under
 * `<agentDir>/sessions/`. If pi ever changes the encoding, listings would
 * come back empty; `sessionDirFor` is exported so tests can pin the format.
 */
export function sessionDirFor(cwd: string, agentDir: string = getAgentDir()): string {
  const home = homedir();
  const expanded = cwd === '~' ? home : cwd.startsWith('~/') ? join(home, cwd.slice(2)) : cwd;
  const resolved = resolve(expanded);
  const safePath = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(agentDir, 'sessions', safePath);
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** null = parsed, not a session file (no header); remembered so it isn't re-read. */
  summary: SessionSummary | null;
}

/** A parsed JSONL line. Fields are read loosely, exactly as pi does. */
interface ParsedEntry {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  parentSession?: unknown;
  name?: unknown;
  message?: unknown;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function parseLine(line: string): ParsedEntry | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as ParsedEntry | null;
  } catch {
    return null; // skip malformed lines
  }
}

function isMessageWithContent(message: unknown): boolean {
  // pi's helper throws on non-object messages. Deliberately total here: one
  // malformed entry must not reject a real session file (see `summarize`).
  return typeof message === 'object' && message !== null && typeof (message as { role?: unknown }).role === 'string' && 'content' in message;
}

function extractTextContent(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: unknown; text?: unknown } | null>)
    .filter((block) => block?.type === 'text')
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join(' ');
}

function activityTime(entry: ParsedEntry): number | undefined {
  const message = entry.message;
  if (!isMessageWithContent(message)) return undefined;
  const role = (message as { role?: unknown }).role;
  if (role !== 'user' && role !== 'assistant') return undefined;
  const messageTimestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof messageTimestamp === 'number') return messageTimestamp;
  const entryTime = new Date(entry.timestamp as string).getTime();
  return Number.isNaN(entryTime) ? undefined : entryTime;
}

/**
 * Stream one session file and derive its summary — the SDK's `buildSessionInfo`
 * without `allMessagesText`, so one pass reads/parses each line once and keeps
 * only scalars.
 *
 * Three outcomes, deliberately not conflated: `null` means "not a session
 * file" (no session header); a thrown error means the file could not be read
 * and must surface to the caller — a session whose summary is unknown may
 * never silently drop out of a strict listing (the boot GC allow-list runs on
 * exactly that guarantee); everything else is a summary. Malformed entries are
 * skipped rather than rejecting the file, diverging from the SDK's strict
 * parse on purpose: one bad line must not make a real session vanish from
 * listings and allow-lists.
 */
async function summarize(filePath: string, stats: Stats): Promise<SessionSummary | null> {
  let header: ParsedEntry | null = null;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = '';
  let lastActivity: number | undefined;

  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (!header) {
      // First parseable line must be the session header; anything else means
      // this file is not a pimote/pi session.
      if (entry.type !== 'session') return null;
      header = entry;
      continue;
    }
    // Session name: latest session_info wins, including explicit clears.
    if (entry.type === 'session_info') name = typeof entry.name === 'string' ? entry.name.trim() || undefined : undefined;
    if (entry.type !== 'message') continue;
    messageCount++;
    const activity = activityTime(entry);
    if (activity !== undefined) lastActivity = Math.max(lastActivity ?? 0, activity);
    const message = entry.message as { role?: unknown; content?: unknown };
    if (!isMessageWithContent(message)) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const textContent = extractTextContent(message);
    if (!textContent) continue;
    if (!firstMessage && message.role === 'user') firstMessage = textContent;
  }
  if (!header) return null;

  const headerTime = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
  const modified = typeof lastActivity === 'number' && lastActivity > 0 ? new Date(lastActivity) : !Number.isNaN(headerTime) ? new Date(headerTime) : stats.mtime;
  // Both dates are always valid: every consumer formats them with
  // `toISOString()`, which throws on an Invalid Date. A garbage header
  // timestamp falls back to the file mtime like `modified` does.
  const created = !Number.isNaN(headerTime) ? new Date(headerTime) : stats.mtime;

  return {
    path: filePath,
    id: header.id as string,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    name,
    parentSessionPath: typeof header.parentSession === 'string' ? header.parentSession : undefined,
    created,
    modified,
    messageCount,
    firstMessage: firstMessage || '(no messages)',
  };
}

/** Options for `SessionSummaryIndex.list`. */
export interface SessionSummaryListOptions {
  /** Throw when any session file failed to read/parse instead of returning the
   *  partial listing — callers whose completeness is safety-critical (the boot
   *  GC allow-list) must never see a silently incomplete result. */
  failOnError?: boolean;
}

interface FolderListing {
  summaries: SessionSummary[];
  /** Per-file read/parse failures, surfaced by `list` but never cached. */
  errors: unknown[];
}

/**
 * Per-file summary cache over a folder's session directory.
 *
 * Session listings are pure functions of append-only `.jsonl` files, so a file
 * whose `(mtimeMs, size)` is unchanged since last time is served from cache —
 * a warm dashboard load stats ~600 files and parses only the ones that were
 * written since the previous list. This replaces calling pi's
 * `SessionManager.list()` per request, which re-read and re-parsed every line
 * of every session file (~700 MB here) on every dashboard load.
 *
 * No invalidation API: mtime+size is the invalidation, deletion is pruned by
 * each directory listing. Read/parse failures are never cached — only proven
 * outcomes ("summarized" or "not a session file") are — so a transient error
 * can never pin a session's omission until the file is touched. Process-
 * lifetime cache — the boot enumeration warms it before the first client can
 * connect.
 */
export class SessionSummaryIndex {
  private readonly folders = new Map<string, Map<string, CacheEntry>>();
  private readonly inFlight = new Map<string, Promise<FolderListing>>();

  constructor(private readonly agentDir?: string) {}

  /**
   * Summaries for every session file in the folder's session directory, newest
   * first. Files that failed to read/parse are omitted from the result and
   * reported — thrown under `failOnError`, warned otherwise.
   */
  async list(folderPath: string, options: SessionSummaryListOptions = {}): Promise<SessionSummary[]> {
    let promise = this.inFlight.get(folderPath);
    if (!promise) {
      promise = this.listFolder(folderPath).finally(() => this.inFlight.delete(folderPath));
      this.inFlight.set(folderPath, promise);
    }
    const { summaries, errors } = await promise;
    if (errors.length > 0) {
      if (options.failOnError) throw new Error(`Failed to read ${errors.length} session file(s) in ${folderPath}`, { cause: errors[0] });
      for (const error of errors) console.warn(`[SessionSummaryIndex] failed to read a session file in ${folderPath}:`, error);
    }
    return summaries;
  }

  private async listFolder(folderPath: string): Promise<FolderListing> {
    const dir = sessionDirFor(folderPath, this.agentDir);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.folders.delete(folderPath);
        return { summaries: [], errors: [] };
      }
      throw error;
    }

    const files = names.filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name));
    const live = new Set(files);
    const cache = this.folders.get(folderPath) ?? new Map<string, CacheEntry>();

    const errors: unknown[] = [];
    const summaries = await mapWithConcurrency(files, 10, async (file) => {
      let stats: Stats;
      try {
        stats = await stat(file);
      } catch {
        return null; // deleted between readdir and stat
      }
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === stats.mtimeMs && hit.size === stats.size) return hit.summary;
      let summary: SessionSummary | null;
      try {
        summary = await summarize(file, stats);
      } catch (error) {
        // A read failure is not "not a session file": surface it and leave the
        // cache untouched so the omission is retried instead of pinned.
        errors.push(error);
        return null;
      }
      cache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, summary });
      return summary;
    });

    for (const key of [...cache.keys()]) {
      if (!live.has(key)) cache.delete(key);
    }
    this.folders.set(folderPath, cache);

    return {
      summaries: summaries.filter((summary): summary is SessionSummary => summary !== null).sort((a, b) => b.modified.getTime() - a.modified.getTime()),
      errors,
    };
  }
}
