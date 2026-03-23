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
