import { readdir, readlink, readFile, realpath } from 'node:fs/promises';

/**
 * Find external pi processes whose working directory matches `folderPath`.
 * Scans /proc to find processes running pi-coding-agent in the given folder.
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

  const pids: number[] = [];

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

      pids.push(pid);
    } catch (err: unknown) {
      // ENOENT (process exited), EACCES (no permission) — skip
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') continue;
      // Other errors — skip too, but don't crash
      continue;
    }
  }

  return pids;
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
export async function killExternalPiProcesses(folderPath: string): Promise<number> {
  const pids = await findExternalPiProcesses(folderPath);
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
