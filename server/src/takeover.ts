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

/** One root external pi process with its resolved working directory. */
interface ExternalPiProcessInfo {
  pid: number;
  cwd: string;
}

/**
 * Scan /proc for external pi processes with their working directories.
 *
 * `rootsOnly` controls how sub-agents are treated:
 * - true: exclude descendants of the current process (pimote server) and of
 *   any other pi process — only "root" pi processes come back. Takeover's
 *   exact-directory conflict check keeps this rule.
 * - false: exclude only the current process and its descendants — every
 *   other pi process counts, including sub-agents spawned by an external pi
 *   elsewhere. The disband activity guard uses this rule: a sub-agent whose
 *   cwd sits inside the hub subtree must never be silently ignored.
 *
 * Throws when /proc itself cannot be read: the disband activity guard fails
 * closed rather than treating an unavailable enumeration as "no activity".
 */
async function scanExternalPiProcesses(rootsOnly: boolean): Promise<ExternalPiProcessInfo[]> {
  const myPid = process.pid;

  const entries = await readdir('/proc');

  // First pass: collect all external pi processes (excluding ourselves)
  const allProcesses: ExternalPiProcessInfo[] = [];

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

      // Check cmdline to verify it's a pi process
      const cmdlineRaw = await readFile(`/proc/${pid}/cmdline`, 'utf-8');
      // cmdline uses null bytes as separators
      const cmdline = cmdlineRaw.replace(/\0/g, ' ').trim();

      if (!isPiProcess(cmdline)) continue;

      allProcesses.push({ pid, cwd: resolvedCwd });
    } catch (err: unknown) {
      // ENOENT (process exited), EACCES (no permission) — skip
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') continue;
      // Other errors — skip too, but don't crash
      continue;
    }
  }

  if (allProcesses.length === 0) return [];

  // Second pass: filter out pi processes the requested rule excludes. The
  // root rule drops any process descended from this server or from another
  // pi process; the guard rule drops only this server's descendants.
  const ancestorPids = rootsOnly ? new Set([myPid, ...allProcesses.map((processInfo) => processInfo.pid)]) : new Set([myPid]);
  const rootProcesses: ExternalPiProcessInfo[] = [];

  for (const processInfo of allProcesses) {
    if (await isDescendantOfAny(processInfo.pid, ancestorPids)) continue;
    rootProcesses.push(processInfo);
  }

  return rootProcesses;
}

/**
 * Find external pi processes whose working directory matches `folderPath`.
 * Scans /proc to find processes running pi-coding-agent in the given folder.
 * Same exclusions as the root-only scan (`rootsOnly: true`).
 */
export async function findExternalPiProcesses(folderPath: string): Promise<number[]> {
  let resolvedFolder: string;
  try {
    resolvedFolder = await realpath(folderPath);
  } catch {
    return [];
  }

  let processes: ExternalPiProcessInfo[];
  try {
    processes = await scanExternalPiProcesses(true);
  } catch {
    return [];
  }

  return processes.filter((processInfo) => processInfo.cwd === resolvedFolder).map((processInfo) => processInfo.pid);
}

/**
 * Working directories of every external pi process outside this server,
 * deduplicated — sub-agents of external pi processes included, so the
 * disband activity guard's subtree checks cannot miss them. Throws when
 * /proc cannot be read so the guard fails closed (never an empty "all
 * clear").
 */
export async function listExternalPiWorkingDirectories(): Promise<string[]> {
  const processes = await scanExternalPiProcesses(false);
  return [...new Set(processes.map((processInfo) => processInfo.cwd))];
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
