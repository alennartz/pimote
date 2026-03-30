import { readdir, readlink, readFile, realpath } from 'node:fs/promises';

/**
 * Check if `pid` is a descendant (child, grandchild, etc.) of any PID in `ancestorPids`
 * by walking the ppid chain via /proc/<pid>/stat.
 * A PID is not considered a descendant of itself.
 */
async function isDescendantOfAny(pid: number, ancestorPids: Set<number>): Promise<boolean> {
  let current = pid;
  // Walk up to 64 levels to avoid infinite loops on broken /proc data
  for (let i = 0; i < 64; i++) {
    let stat: string;
    try {
      stat = await readFile(`/proc/${current}/stat`, 'utf-8');
    } catch {
      return false;
    }
    // /proc/<pid>/stat format: pid (comm) state ppid ...
    // comm can contain spaces and parens, so find the last ')' first
    const lastParen = stat.lastIndexOf(')');
    if (lastParen === -1) return false;
    const afterComm = stat.slice(lastParen + 2); // skip ') '
    const fields = afterComm.split(' ');
    // fields[0] = state, fields[1] = ppid
    const ppid = Number(fields[1]);
    if (!Number.isInteger(ppid) || ppid <= 0) return false;
    if (ancestorPids.has(ppid)) return true;
    // Reached init — not a descendant
    if (ppid === 1) return false;
    current = ppid;
  }
  return false;
}

/**
 * Find external pi processes whose working directory matches `folderPath`.
 * Scans /proc to find processes running pi-coding-agent in the given folder.
 *
 * Excludes:
 * - The current process (pimote server)
 * - Descendants of the current process (sub-agents spawned by this server)
 * - Descendants of any other pi process (sub-agents spawned by an external pi)
 *
 * Only "root" pi processes — those not parented by another pi process or this
 * server — are returned as conflicts.
 */
export async function findExternalPiProcesses(folderPath: string): Promise<number[]> {
  const myPid = process.pid;

  let resolvedFolder: string;
  try {
    resolvedFolder = await realpath(folderPath);
  } catch {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return [];
  }

  // First pass: collect all pi processes in this folder (excluding ourselves)
  const allPiPids: number[] = [];

  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === myPid) continue;

    try {
      // Check cwd
      const cwd = await readlink(`/proc/${pid}/cwd`);
      let resolvedCwd: string;
      try {
        resolvedCwd = await realpath(`/proc/${pid}/cwd`);
      } catch {
        resolvedCwd = cwd;
      }

      if (resolvedCwd !== resolvedFolder) continue;

      // Check cmdline to verify it's a pi process
      const cmdlineRaw = await readFile(`/proc/${pid}/cmdline`, 'utf-8');
      // cmdline uses null bytes as separators
      const cmdline = cmdlineRaw.replace(/\0/g, ' ').trim();

      if (!isPiProcess(cmdline)) continue;

      allPiPids.push(pid);
    } catch (err: unknown) {
      // ENOENT (process exited), EACCES (no permission) — skip
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') continue;
      // Other errors — skip too, but don't crash
      continue;
    }
  }

  if (allPiPids.length === 0) return [];

  // Second pass: filter out any pi process that is a descendant of
  // this server or of another pi process in the set.
  const ancestorPids = new Set([myPid, ...allPiPids]);
  const rootPids: number[] = [];

  for (const pid of allPiPids) {
    if (await isDescendantOfAny(pid, ancestorPids)) continue;
    rootPids.push(pid);
  }

  return rootPids;
}

/**
 * Check if a cmdline string belongs to a pi-coding-agent process.
 */
function isPiProcess(cmdline: string): boolean {
  if (cmdline.includes('pi-coding-agent')) return true;
  // Check if any argv[0] ends with '/pi' or is exactly 'pi'
  const parts = cmdline.split(/\s+/);
  for (const part of parts) {
    if (part === 'pi' || part.endsWith('/pi')) return true;
  }
  return false;
}

/**
 * Kill external pi processes in the given folder.
 * Sends SIGTERM, waits 1 second, then SIGKILL if needed.
 * Returns the number of processes killed.
 */
export async function killExternalPiProcesses(folderPath: string, targetPids?: number[]): Promise<number> {
  let pids = await findExternalPiProcesses(folderPath);
  if (targetPids && targetPids.length > 0) {
    pids = pids.filter((pid) => targetPids.includes(pid));
  }
  if (pids.length === 0) return 0;

  let killed = 0;

  // Send SIGTERM to all
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      killed++;
    } catch {
      // Process already gone
    }
  }

  if (killed === 0) return 0;

  // Wait 1 second for graceful shutdown
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Check survivors and SIGKILL
  for (const pid of pids) {
    try {
      process.kill(pid, 0); // Check if alive
      // Still alive — force kill
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone between check and kill
      }
    } catch {
      // Already dead — good
    }
  }

  return killed;
}
