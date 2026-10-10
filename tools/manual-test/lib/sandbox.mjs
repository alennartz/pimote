// Shared sandbox/server helpers for manual-test tools.
//
// Every tool boots a real `bin/pimote.js` in an isolated HOME (its own
// XDG dirs + PI_CODING_AGENT_DIR + PIMOTE_CONFIG_PATH) against fabricated
// folder/session fixtures. Track and kill only the child PID a tool spawns;
// never use pattern-based pkill against shared binary paths.
//
// Exports:
//   freePort()                                        — one free TCP port
//   gitInit(dir, branch, { dirty, commit })           — fabricate a git repo
//   writePersona(dir, name, description)              — persona folder (marker)
//   seedSession(sessionsRoot, projectDir, text, …)    — fabricated pi session
//     (options.at controls entry timestamps for recency fixtures)
//   startPimote({ port, sandboxHome, agentDir, configPath, logPath })
//   stopPimote(child)
//   waitForListening(child, port, logPath)

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve as pathResolve, basename } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { seedSessionDir } from './session-dir.mjs';

const execFile = promisify(execFileCb);

export const REPO_ROOT = pathResolve(new URL('../../../', import.meta.url).pathname);
export const PIMOTE_BIN = join(REPO_ROOT, 'bin', 'pimote.js');

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export async function gitInit(dir, branch, { dirty = false, commit = true } = {}) {
  await mkdir(dir, { recursive: true });
  const git = (...args) => execFile('git', ['-C', dir, ...args]);
  await git('init', '-b', branch);
  await writeFile(join(dir, 'README.md'), `# ${basename(dir)}\n`);
  if (commit) {
    await git('add', '.');
    await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init');
  }
  if (dirty) await writeFile(join(dir, 'dirty.txt'), 'uncommitted\n');
}

/** Persona folder: AGENTS.md opening with YAML front matter (`kind: persona`, string `name:` key). */
export async function writePersona(dir, name, description) {
  await mkdir(dir, { recursive: true });
  const front = ['---', 'kind: persona', `name: ${name}`, `description: ${description}`, '---'].join('\n');
  await writeFile(join(dir, 'AGENTS.md'), `${front}\nYou are ${name}, a fixture persona.\n`);
}

/**
 * Fabricated pi session jsonl under the SDK-exact session-dir encoding.
 * Entries form a tree via parentId (the replay walks root → leaf).
 * `options.at` fixes entry timestamps so recency-ordering fixtures control
 * `SessionSummary.modified` deterministically.
 */
export async function seedSession(sessionsRoot, projectDir, userText, assistantText, { at } = {}) {
  const sessionId = randomUUID();
  const sessionDir = seedSessionDir(sessionsRoot, projectDir);
  await mkdir(sessionDir, { recursive: true });
  const isoNow = (at ?? new Date()).toISOString();
  const ms = Date.parse(isoNow);
  const filename = `${isoNow.replace(/:/g, '-')}_${sessionId}.jsonl`;
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: isoNow, cwd: projectDir },
    {
      type: 'message',
      id: 'user-0001',
      parentId: sessionId,
      timestamp: isoNow,
      message: { role: 'user', content: [{ type: 'text', text: userText }], timestamp: ms },
    },
    {
      type: 'message',
      id: 'asst-0001',
      parentId: 'user-0001',
      timestamp: isoNow,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: assistantText }],
        api: 'openai-completions',
        provider: 'fabricated',
        model: 'fixture',
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: ms,
        responseId: `resp_${sessionId}`,
      },
    },
  ];
  await writeFile(join(sessionDir, filename), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return sessionId;
}

export function startPimote({ port, sandboxHome, agentDir, configPath, logPath }) {
  const env = {
    ...process.env,
    HOME: sandboxHome,
    XDG_CONFIG_HOME: join(sandboxHome, '.config'),
    XDG_STATE_HOME: join(sandboxHome, '.local', 'state'),
    XDG_DATA_HOME: join(sandboxHome, '.local', 'share'),
    XDG_CACHE_HOME: join(sandboxHome, '.cache'),
    PI_CODING_AGENT_DIR: agentDir,
    PIMOTE_CONFIG_PATH: configPath,
    NODE_ENV: 'production',
  };
  const child = spawn(process.execPath, [PIMOTE_BIN, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tee = (chunk) => {
    void appendFile(logPath, chunk).catch(() => {});
  };
  child.stdout.on('data', tee);
  child.stderr.on('data', tee);
  return child;
}

export async function stopPimote(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 300));
}

export async function waitForListening(child, port, logPath) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`pimote exited early (${child.exitCode}); see ${logPath}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Retry while the process completes boot.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`pimote did not listen on :${port} within 30s; see ${logPath}`);
}
