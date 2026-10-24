import { truncateTail } from '@earendil-works/pi-coding-agent';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PIMOTE_TOOL_SPILL_DIR } from '../paths.js';

/**
 * Spill guard for the manager find tools (pimote_find_folders,
 * pimote_find_sessions). A result whose serialized rows exceed the inline
 * budget keeps its first rows in the tool result and spills the rest to a
 * JSONL file under the pimote state dir; the payload carries the file path
 * plus a jq/grep hint, so the agent searches the remainder with CLI tools
 * instead of holding it in context. Byte-based on the serialized rows —
 * folder rows vary 13x (plain row ~390B, 20-member hub ~5KB), so row counts
 * are the wrong unit.
 */

/** Target inline budget for serialized rows. An oversized first row stays inline. */
export const SPILL_INLINE_BYTES = 16 * 1024;

/** Spill files older than this are pruned (best-effort) on the next spill. */
const SPILL_TTL_MS = 24 * 60 * 60 * 1000;

/** Pointer to the spilled remainder, embedded in the tool payload. */
export interface SpillInfo {
  /** Absolute path of the spill file; one JSON row per line, same order. */
  file: string;
  /** Rows in the spill file. */
  rows: number;
  /** UTF-8 bytes in the spill file. */
  bytes: number;
  /** Instruction for searching the file with CLI tools. */
  hint: string;
}

/** The list tool's rows after the guard: the inline prefix, plus spill
 *  metadata when the guard fired. */
export interface SpillOutcome<T> {
  rows: T[];
  spill?: SpillInfo;
  warning?: string;
}

/** Pack rows under the inline budget and spill the rest to a JSONL file.
 *  The optional signal is the caller's interruption hook: checked at entry
 *  and before the file write, so an aborted turn neither serializes nor
 *  spills. Pure measuring aside, the one write is the module's whole side
 *  effect. Always keeps at least one row inline, even when a single row
 *  exceeds the budget — an empty inline result would tell the agent nothing. */
export async function spillRows<T>(tool: string, rows: readonly T[], signal?: AbortSignal): Promise<SpillOutcome<T>> {
  signal?.throwIfAborted();
  const serialized = rows.map((row) => JSON.stringify(row));
  const totalBytes = serialized.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  if (totalBytes <= SPILL_INLINE_BYTES) return { rows: [...rows] };

  let cut = 0;
  let used = 0;
  while (cut < serialized.length) {
    const lineBytes = Buffer.byteLength(serialized[cut]) + 1;
    if (cut > 0 && used + lineBytes > SPILL_INLINE_BYTES) break;
    used += lineBytes;
    cut += 1;
  }
  // The whole result fits after all — possible when a single monster row
  // passes the total check but nothing remains behind it. Keep it inline;
  // an empty spill file would point the agent at nothing.
  if (cut === serialized.length) return { rows: [...rows] };

  const spilled = serialized.slice(cut);
  const file = join(PIMOTE_TOOL_SPILL_DIR, `${tool}-${stamp()}.jsonl`);
  signal?.throwIfAborted();
  const contents = `${spilled.join('\n')}\n`;
  const bytes = Buffer.byteLength(contents);
  try {
    await mkdir(PIMOTE_TOOL_SPILL_DIR, { recursive: true });
    await writeFile(file, contents);
  } catch (error) {
    signal?.throwIfAborted();
    await unlink(file).catch(() => {});
    const reason = truncateTail(error instanceof Error ? error.message : String(error), { maxLines: 3, maxBytes: 512 });
    return {
      rows: rows.slice(0, cut),
      warning: `Full output is unavailable because the spill file could not be saved: ${reason.content}${reason.truncated ? ' (error truncated)' : ''}. ${spilled.length} rows are omitted from this view. Use tighter filters to retrieve them.`,
    };
  }
  await pruneOldSpills();

  return {
    rows: rows.slice(0, cut),
    spill: {
      file,
      rows: spilled.length,
      bytes,
      hint:
        `${spilled.length} of ${rows.length} rows were saved to ${file} (${bytes} bytes, ${spilled.length} lines). ` +
        `The file contains JSONL rows in result order. Search it with jq or grep, for example: ` +
        `jq -c 'select(.name // .id | test("PATTERN"; "i"))' ${file}.`,
    },
  };
}

/** Collision-safe file stamp: millisecond time plus a short random suffix. */
function stamp(): string {
  return `${new Date().toISOString().replaceAll(':', '-')}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Delete spill files past the TTL. Best-effort: a failure to prune must
 *  never fail the tool result the prune serves. */
async function pruneOldSpills(): Promise<void> {
  try {
    const cutoff = Date.now() - SPILL_TTL_MS;
    const files = await readdir(PIMOTE_TOOL_SPILL_DIR);
    await Promise.all(
      files
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (name) => {
          const path = join(PIMOTE_TOOL_SPILL_DIR, name);
          const mtime = (await stat(path)).mtimeMs;
          if (mtime < cutoff) await unlink(path).catch(() => {});
        }),
    );
  } catch {
    // Pruning is opportunistic: races with concurrent prunes or an unreadable
    // state dir leave an extra file for the next spill to sweep.
  }
}
