import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { findExternalPiProcesses, killExternalPiProcesses } from './takeover.js';

let tempDir: string;
const spawnedProcesses: ChildProcess[] = [];

afterEach(async () => {
  // Clean up any spawned processes
  for (const proc of spawnedProcesses) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already dead
    }
  }
  spawnedProcesses.length = 0;

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

function spawnSleepProcess(cwd: string): ChildProcess {
  const child = spawn('sleep', ['60'], { cwd, stdio: 'ignore', detached: true });
  child.unref();
  spawnedProcesses.push(child);
  return child;
}

describe('findExternalPiProcesses', () => {
  it('excludes non-pi processes even if cwd matches', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pimote-takeover-test-'));

    // Spawn a sleep process in tempDir — not a pi process
    const child = spawnSleepProcess(tempDir);
    // Give it a moment to start
    await new Promise((resolve) => setTimeout(resolve, 100));

    const pids = await findExternalPiProcesses(tempDir);

    // sleep is not a pi process, so it should NOT be in the results
    expect(pids).not.toContain(child.pid);
  });

  it('returns empty array for non-existent folder', async () => {
    const pids = await findExternalPiProcesses('/tmp/this-folder-does-not-exist-' + Date.now());
    expect(pids).toEqual([]);
  });

  it('excludes pi sub-processes of the current process (server sub-agents)', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pimote-takeover-test-'));

    // Create a symlink named 'pi' pointing to 'sleep' so isPiProcess matches argv[0]
    const { symlink } = await import('node:fs/promises');
    const piLink = join(tempDir, 'pi');
    await symlink('/usr/bin/sleep', piLink);

    const child = spawn(piLink, ['60'], { cwd: tempDir, stdio: 'ignore', detached: true });
    child.unref();
    spawnedProcesses.push(child);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const pids = await findExternalPiProcesses(tempDir);

    // This is a child of process.pid (the server), so it should be excluded
    expect(pids).not.toContain(child.pid);
  });

  it('excludes pi sub-processes of another pi process (external pi sub-agents)', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pimote-takeover-test-'));

    const { symlink, writeFile, chmod, readFile } = await import('node:fs/promises');
    const piLink = join(tempDir, 'pi');
    await symlink('/usr/bin/sleep', piLink);

    const pidFile = join(tempDir, 'pids');

    // Double-fork script: the intermediate shell exits immediately, causing
    // the real processes to be reparented to init (pid 1). This ensures
    // they are NOT descendants of process.pid (the test runner / server).
    // The inner script spawns a parent "pi" that backgrounds a child "pi".
    const script = join(tempDir, 'run-pi-tree.sh');
    await writeFile(
      script,
      [
        '#!/bin/sh',
        // Inner layer: runs detached from the test process
        "sh -c '",
        `  "${piLink}" 60 &`, // child pi (backgrounded)
        `  child_pid=$!`,
        `  parent_pid=$$`,
        `  echo "$parent_pid $child_pid" > "${pidFile}"`,
        `  exec "${piLink}" 60`, // parent execs into pi
        "' &",
        // Outer shell exits immediately — orphans the inner tree
        'exit 0',
      ].join('\n'),
    );
    await chmod(script, '755');

    const launcher = spawn(script, [], {
      cwd: tempDir,
      stdio: 'ignore',
      detached: true,
    });
    launcher.unref();
    // Launcher exits immediately, no need to track

    // Wait for the pid file to appear and the processes to stabilize
    let parentPid = 0,
      childPid = 0;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const content = (await readFile(pidFile, 'utf-8')).trim();
        const [p, c] = content.split(' ').map(Number);
        if (p > 0 && c > 0) {
          parentPid = p;
          childPid = c;
          break;
        }
      } catch {
        // pid file not yet written
      }
    }

    expect(parentPid).toBeGreaterThan(0);
    expect(childPid).toBeGreaterThan(0);

    // Track for cleanup
    const cleanup = (pid: number) =>
      ({
        kill: (sig: string) => {
          try {
            process.kill(pid, sig as any);
          } catch {}
        },
      }) as any;
    spawnedProcesses.push(cleanup(parentPid));
    spawnedProcesses.push(cleanup(childPid));

    const pids = await findExternalPiProcesses(tempDir);

    // The parent pi is a root external pi process — it should be detected.
    // The child pi is a sub-process of that parent pi — it should be excluded.
    expect(pids).not.toContain(childPid);
    expect(pids).toContain(parentPid);
    expect(pids.length).toBe(1);
  });

  it('returns empty array when no processes match', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pimote-takeover-test-'));
    const pids = await findExternalPiProcesses(tempDir);
    expect(pids).toEqual([]);
  });

  it('handles concurrent disappearing PIDs gracefully', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pimote-takeover-test-'));

    // Spawn and immediately kill a process — simulates a PID that vanishes mid-scan
    const child = spawnSleepProcess(tempDir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should not throw
    const pids = await findExternalPiProcesses(tempDir);
    expect(Array.isArray(pids)).toBe(true);
  });
});

describe('killExternalPiProcesses', () => {
  it('returns 0 when no pi processes found', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pimote-takeover-test-'));
    const killed = await killExternalPiProcesses(tempDir);
    expect(killed).toBe(0);
  });

  it('returns 0 for non-existent folder', async () => {
    const killed = await killExternalPiProcesses('/tmp/no-such-dir-' + Date.now());
    expect(killed).toBe(0);
  });

  it('does not kill non-pi processes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pimote-takeover-test-'));

    const child = spawnSleepProcess(tempDir);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const killed = await killExternalPiProcesses(tempDir);
    expect(killed).toBe(0);

    // Verify the sleep process is still alive
    let alive = false;
    try {
      process.kill(child.pid!, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);
  });
});
