#!/usr/bin/env node
// End-to-end smoke for the folder-management topic (dashboard, hubs, manager).
//
// Boots the real pimote server in an isolated HOME against a fabricated
// multi-root folder tree (nested entries beneath skipped wrappers, persona
// folders, a shortcut-linked external repo, a dirty repo, named branches, a
// fabricated pi session), seeds a local model via PI_CODING_AGENT_DIR for the
// manager LLM, and drives the real PWA with agent-browser plus a second
// WebSocket probe client (two-client `folders_changed` sync).
//
// Discovery semantics under test: sparse scan with no depth bound (nested
// entries under SKIPPED wrappers are discovered, never inside included git
// repos), personas via AGENTS.md marker front matter, shortcuts via top-level
// out-of-tree symlinks of included folders, and FolderInfo defaults
// (nature/persona/shortcutCount/missing/repos?/userTags?).
//
// Optional environment variables:
//   PM_SHOTS=/tmp/dir  keep coherence screenshots outside the disposable sandbox
//   PM_KEEP=1          keep the sandbox even on a passing run

import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve, basename } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const REPO_ROOT = pathResolve(new URL('../../../', import.meta.url).pathname);
const PIMOTE_BIN = join(REPO_ROOT, 'bin', 'pimote.js');
const REAL_AGENT_DIR = join(process.env.HOME ?? '', '.pi', 'agent');
const BROWSER_SESSION = `project-management-${process.pid}`;

let failures = 0;
const softFailures = [];
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}
function soft(condition, message, note) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.log(`  ⊝ ${message} — environment-bounded: ${note}`);
    softFailures.push(message);
  }
}
function section(message) {
  console.log(`\n[pm-smoke] ${message}`);
}
function log(...args) {
  console.log('[pm-smoke]', ...args);
}

async function freePort() {
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

// ---------------------------------------------------------------- fixtures

async function gitInit(dir, branch, { dirty = false, commit = true } = {}) {
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

/** Persona folder: AGENTS.md opening with YAML front matter (string `name:` key). */
async function writePersona(dir, name, description) {
  await mkdir(dir, { recursive: true });
  const front = ['---', `name: ${name}`, `description: ${description}`, '---'].join('\n');
  await writeFile(join(dir, 'AGENTS.md'), `${front}\nYou are ${name}, a fixture persona.\n`);
}

async function seedSession(sessionsRoot, projectDir, userText, assistantText) {
  const sessionId = randomUUID();
  const sessionsDir = sessionsRoot;
  const encodedCwd = `--${projectDir.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const sessionDir = join(sessionsDir, encodedCwd);
  await mkdir(sessionDir, { recursive: true });
  const isoNow = new Date().toISOString();
  const filename = `${isoNow.replace(/:/g, '-')}_${sessionId}.jsonl`;
  // Entries form a tree via parentId; the replay walks root → leaf, so the
  // user → assistant chain must be linked or entries are orphaned.
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: isoNow, cwd: projectDir },
    {
      type: 'message',
      id: 'user-0001',
      parentId: sessionId,
      timestamp: isoNow,
      message: { role: 'user', content: [{ type: 'text', text: userText }], timestamp: Date.now() },
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
        timestamp: Date.now(),
        responseId: `resp_${sessionId}`,
      },
    },
  ];
  await writeFile(join(sessionDir, filename), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return sessionId;
}

/**
 * Folder-source fixture module (folder vocabulary — the `@pimote/sdk/folders`
 * seam: FolderSource.list() contributes `{ kind: 'repo' }` / `{ kind: 'hub' }`
 * entries, `onFolderOpen(folderPath)` provisions before any open). Written as
 * plain .mjs with JSDoc type references so the loader needs no workspace
 * resolution from the sandbox.
 */
function folderSourceModule({ repoDir, hubDir, memberPath, hookLog }) {
  return `// Smoke fixture folder source — @pimote/sdk/folders vocabulary.
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCb);

const REPO = ${JSON.stringify(repoDir)};
const HUB = ${JSON.stringify(hubDir)};
const MEMBER = ${JSON.stringify(memberPath)};
const HOOK_LOG = ${JSON.stringify(hookLog)};

/** @type {import('@pimote/sdk/folders').FolderSource} */
const smokeSource = {
  id: 'smoke-source',
  async list() {
    /** @type {import('@pimote/sdk/folders').SourceEntry[]} */
    return [
      { kind: 'repo', path: REPO, name: 'source-repo', branch: null, dirty: false, ahead: 0, behind: 0, tags: ['from-source'] },
      { kind: 'hub', path: HUB, name: 'kiwi', memberPaths: [MEMBER] },
    ];
  },
  /** Open hook: self-filter by path, scaffold the missing repo entry. */
  async onFolderOpen(folderPath) {
    await appendFile(HOOK_LOG, folderPath + '\\n');
    if (folderPath === REPO) {
      await mkdir(REPO, { recursive: true });
      await execFile('git', ['-C', REPO, 'init', '-b', 'main']);
      await writeFile(REPO + '/README.md', '# source-repo\\n');
    }
  },
};
export const sources = [smokeSource];
`;
}

// ------------------------------------------------------------------ server

function startPimote({ port, sandboxHome, agentDir, configPath, logPath }) {
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

async function stopPimote(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function waitForListening(child, port, logPath) {
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

// ------------------------------------------------------------- ws probe

let nextCmdId = 0;
class WsProbe {
  constructor(port, clientId) {
    this.url = `ws://127.0.0.1:${port}/ws?clientId=${clientId}`;
    this.pending = new Map();
    this.events = [];
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', (e) => reject(e.error ?? new Error('ws error')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === 'response' || message.success !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          pending(message);
        }
        return;
      }
      this.events.push({ at: Date.now(), event: message });
    });
  }

  send(payload) {
    const id = `probe-${++nextCmdId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`probe timeout waiting for response to ${payload.type}`)), 15_000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  /** Events received strictly after `since` (ms epoch). */
  eventsSince(since, type) {
    return this.events.filter((e) => e.at > since && (!type || e.event.type === type));
  }

  async waitForEvent(type, predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Scan the full history: the event may land while earlier awaits in the
      // caller are still settling, before waitForEvent is entered.
      const hits = this.events.filter((e) => e.event.type === type && (!predicate || predicate(e.event)));
      if (hits.length > 0) return hits[0].event;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${type} event`);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
  }
}

// ------------------------------------------------------------ agent-browser

async function browser(args, { allowFailure = false, timeoutMs = 30_000, retries = 2 } = {}) {
  const fullArgs = ['--session', BROWSER_SESSION, ...args];
  log('agent-browser', args.join(' '));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const child = spawn('agent-browser', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    await once(child, 'exit');
    clearTimeout(timer);
    const transient = /Resource temporarily unavailable|daemon may be busy/i.test(stdout + stderr);
    if ((child.exitCode === 0 && !timedOut) || allowFailure || (!transient && !timedOut) || attempt === retries) {
      if ((child.exitCode !== 0 || timedOut) && !allowFailure) {
        console.error(`[pm-smoke] agent-browser failed: ${args.join(' ')}\n${stderr}`);
        throw new Error(`agent-browser failed: ${args.join(' ')}`);
      }
      return { stdout, stderr, code: child.exitCode };
    }
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
  throw new Error('unreachable');
}

function parseEval(stdout) {
  const raw = stdout.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, '');
  }
}

async function evalBrowser(expression) {
  return parseEval((await browser(['eval', expression])).stdout);
}

/** Set a Svelte-bound input's value and fire the input event. */
async function fillSelector(selector, value) {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
  return (await evalBrowser(expr)) === true;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------------------- ui helpers

/** Text content of a folder row (icon label, name/subtitle, chips, badges). */
async function rowText(path) {
  return String(
    await evalBrowser(`(() => {
      const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(path)} + '"]');
      return s?.closest('.group')?.textContent ?? '';
    })()`),
  );
}

/** Row icon variant: code | code-hub | persona | persona-hub. */
async function rowIcon(path) {
  return await evalBrowser(`(() => {
    const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(path)} + '"]');
    return s?.closest('button')?.querySelector('svg[data-folder-icon]')?.getAttribute('data-folder-icon') ?? null;
  })()`);
}

/** Open the row context menu (long-press / right-click surface). */
async function openRowMenu(path) {
  const opened = await evalBrowser(`(() => {
    const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(path)} + '"]');
    const trigger = s?.closest('.group');
    if (!trigger) return false;
    const rect = trigger.getBoundingClientRect();
    trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 24, clientY: rect.top + 12 }));
    return true;
  })()`);
  await wait(400);
  return opened === true;
}

/** Click a context/dropdown menu item by its text. */
async function clickMenuItem(text) {
  const clicked = await evalBrowser(`(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"], [data-slot="context-menu-item"], [data-slot="dropdown-menu-item"]')).find((i) => i.textContent?.trim().includes(${JSON.stringify(text)}));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  await wait(500);
  return clicked === true;
}

/** Click a dialog button whose trimmed text matches exactly. */
async function clickDialogButton(text) {
  const clicked = await evalBrowser(`(() => {
    const btns = Array.from(document.querySelectorAll('[role="dialog"] button')).filter((b) => b.textContent?.trim() === ${JSON.stringify(text)});
    if (!btns.length) return false;
    btns.at(-1).click();
    return true;
  })()`);
  await wait(500);
  return clicked === true;
}

/** Put the one-box toolbar into manager mode (its composer replaces search). */
async function ensureManagerMode() {
  const ready = await evalBrowser(`Boolean(document.querySelector('textarea[aria-label="Message the manager"]'))`);
  if (ready !== true) {
    await evalBrowser(`(() => { const b = document.querySelector('button[aria-label="Switch to the manager"]'); if (!b) return false; b.click(); return true; })()`);
    await wait(300);
  }
  return (await evalBrowser(`Boolean(document.querySelector('textarea[aria-label="Message the manager"]'))`)) === true;
}

// -------------------------------------------------------------------- main

async function main() {
  console.log('[pm-smoke] folder-management dashboard/hub/manager smoke');
  const sandboxHome = await mkdtemp(join(tmpdir(), 'project-management-smoke-'));
  const configDir = join(sandboxHome, '.config', 'pimote');
  await mkdir(configDir, { recursive: true });

  // --- Agent dir for the sandbox: real models.json (local jetson provider),
  //     fresh settings.json defaulting to it (no credentials involved).
  const agentDir = join(sandboxHome, 'agent');
  await mkdir(agentDir, { recursive: true });
  const modelsSrc = join(REAL_AGENT_DIR, 'models.json');
  let jetsonUsable;
  try {
    const models = JSON.parse(await readFile(modelsSrc, 'utf8'));
    jetsonUsable = Boolean(models.providers?.jetson);
    if (jetsonUsable) await copyFile(modelsSrc, join(agentDir, 'models.json'));
  } catch {
    jetsonUsable = false;
  }

  // --- Folder tree (two configured roots + one external dir outside them).
  //     gamma is a SKIPPED wrapper (no marker, no .git): nested entries under
  //     it are discovered at any depth — there is no depth bound. Included
  //     git repos stop descent, so no fixture nests repos inside them.
  const rootA = join(sandboxHome, 'projects');
  const rootB = join(sandboxHome, 'work');
  const externalDir = join(sandboxHome, 'external'); // outside the scan roots
  await gitInit(join(rootA, 'alpha'), 'main');
  await gitInit(join(rootA, 'beta'), 'main', { dirty: true });
  await gitInit(join(rootA, 'gamma', 'lib'), 'main');
  await gitInit(join(rootA, 'gamma', 'sub', 'deep-repo'), 'main');
  await gitInit(join(rootA, 'gamma', 'sub', 'deeper', 'deepest'), 'main'); // deep under a skipped wrapper — discovered
  await gitInit(join(rootB, 'delta'), 'feature/zebra');
  await gitInit(join(externalDir, 'charlie'), 'main'); // external repo, reached via shortcut
  await writePersona(join(rootA, 'omega'), 'Omega', 'Fixture persona without shortcuts');
  await writePersona(join(rootA, 'sigma'), 'Sigma Persona', 'Fixture persona with a shortcut');
  await symlink(join(externalDir, 'charlie'), join(rootA, 'sigma', 'ext')); // top-level out-of-tree symlink → shortcut
  await seedSession(join(agentDir, 'sessions'), join(rootA, 'alpha'), 'What is the launch checklist?', '1. Fuel the rocket. 2. Wake the manager.');

  // --- Folder-source fixture (SDK folder vocabulary): a missing repo entry
  //     provisioned by its onFolderOpen hook (under a scan root, so the next
  //     scan flips its missing state), plus a hub entry that pimote would
  //     materialize on open (never opened here).
  const sourceRepoDir = join(rootB, 'source-repo');
  const sourceHubDir = join(externalDir, 'kiwi');
  const hookLog = join(sandboxHome, 'folder-source-hooks.log');
  const sourcesDir = join(sandboxHome, 'folder-sources');
  await mkdir(sourcesDir, { recursive: true });
  await writeFile(join(sourcesDir, 'smoke-folder-source.mjs'), folderSourceModule({ repoDir: sourceRepoDir, hubDir: sourceHubDir, memberPath: join(rootB, 'delta'), hookLog }));

  const configPath = join(configDir, 'config.json');
  const config = {
    roots: [rootA, rootB],
    folderSourcesDir: sourcesDir,
    port: 0, // replaced below
    bufferSize: 100,
    updateCheck: false,
    ...(jetsonUsable ? { defaultProvider: 'jetson', defaultModel: 'qwen3.8-27b' } : {}),
  };
  const port = await freePort();
  config.port = port;
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const logPath = join(sandboxHome, 'pimote.log');
  const shotsDir = process.env.PM_SHOTS ? pathResolve(process.env.PM_SHOTS) : sandboxHome;
  await mkdir(shotsDir, { recursive: true });

  log('sandbox HOME =', sandboxHome);
  log('roots        =', rootA, '+', rootB);
  log('port         =', port);
  log('jetson model =', jetsonUsable ? 'available (manager LLM live)' : 'UNAVAILABLE — manager LLM tests will be environment-bounded');

  let child;
  const westDir = join(rootA, 'west');
  const limaDir = join(rootA, 'lima');
  const zuluDir = join(rootA, 'zulu');
  const epsilon = join(rootA, 'epsilon');
  const omegaDir = join(rootA, 'omega');
  const sigmaDir = join(rootA, 'sigma');
  const charlieDir = join(externalDir, 'charlie');
  const deepRepoDir = join(rootA, 'gamma', 'sub', 'deep-repo');

  try {
    child = startPimote({ port, sandboxHome, agentDir, configPath, logPath });
    await waitForListening(child, port, logPath);

    // ============================================================
    section('W — list_folders structural probes (sparse scan, personas, shortcuts)');
    // ============================================================
    let probeA = new WsProbe(port, `pm-probe-a-${randomUUID().slice(0, 8)}`);
    let probeB = new WsProbe(port, `pm-probe-b-${randomUUID().slice(0, 8)}`);
    await probeA.open();
    await probeB.open();

    const list1 = await probeA.send({ type: 'list_folders' });
    const folders1 = list1.data?.folders ?? [];
    const byPath = new Map(folders1.map((f) => [f.path, f]));
    assert(list1.success === true, 'list_folders succeeds');
    assert(list1.data?.roots?.length === 2 && list1.data.roots.includes(rootA) && list1.data.roots.includes(rootB), 'roots echo both configured roots');
    for (const name of ['alpha', 'beta', 'delta']) {
      assert(byPath.has(name === 'delta' ? join(rootB, 'delta') : join(rootA, name)), `discovered code folder: ${name}`);
    }
    // Sparse descent: skipped wrappers are not entries; nested entries below
    // them surface at any depth — there is no depth bound.
    assert(!byPath.has(join(rootA, 'gamma')), 'skipped wrapper (gamma) is NOT a folder row');
    assert(byPath.has(join(rootA, 'gamma', 'lib')), 'nested entry under skipped wrapper discovered (gamma/lib)');
    assert(byPath.has(deepRepoDir), 'nested entry discovered (gamma/sub/deep-repo)');
    assert(byPath.has(join(rootA, 'gamma', 'sub', 'deeper', 'deepest')), 'deeply nested entry discovered — no depth bound (…/deepest)');
    // Persona folders (marker front matter, no .git).
    const omega = byPath.get(omegaDir);
    const sigma = byPath.get(sigmaDir);
    assert(
      omega?.nature === 'persona' && omega?.persona?.name === 'Omega' && omega?.persona?.description === 'Fixture persona without shortcuts',
      'persona row carries nature + persona metadata',
    );
    assert(omega?.name === 'omega', 'folder name is the basename, never the persona name');
    assert(sigma?.nature === 'persona' && sigma?.persona?.name === 'Sigma Persona', 'second persona row carries its marker name');
    assert(sigma?.shortcutCount === 1, 'shortcut-bearing persona reports shortcutCount 1 (persona-hub variant)');
    assert((byPath.get(join(rootA, 'beta'))?.shortcutCount ?? -1) === 0, 'plain code folder reports shortcutCount 0');
    // Shortcut-linked external repo: discovered through sigma's symlink.
    assert(byPath.get(charlieDir)?.nature === 'code', 'external repo reached via shortcut is its own code folder row');
    // Source-contributed rows.
    const sourceRepoRow = byPath.get(sourceRepoDir);
    assert(sourceRepoRow?.missing === true, 'source-listed repo absent on disk reports missing: true');
    assert(
      JSON.stringify(sourceRepoRow?.tags) === JSON.stringify(['from-source']) && (sourceRepoRow?.userTags ?? []).length === 0,
      'source tags land on the row without user tags',
    );
    const kiwi = byPath.get(sourceHubDir);
    assert(kiwi?.missing === true && kiwi?.repos?.length === 1, 'source hub row is missing on disk with its member repo listed');
    // FolderInfo defaults across the board.
    const badDefaults = folders1.filter(
      (f) =>
        typeof f.path !== 'string' ||
        typeof f.name !== 'string' ||
        f.name !== f.path.split('/').filter(Boolean).at(-1) ||
        (f.nature !== 'code' && f.nature !== 'persona') ||
        typeof f.shortcutCount !== 'number' ||
        f.favorite !== false ||
        f.archived !== false ||
        !Array.isArray(f.tags) ||
        typeof f.missing !== 'boolean' ||
        typeof f.activeSessionCount !== 'number' ||
        typeof f.externalProcessCount !== 'number',
    );
    assert(badDefaults.length === 0, `every FolderInfo row carries required defaults + basename names (${folders1.length} rows)`);
    const badPersona = folders1.filter((f) => (f.nature === 'persona') !== Boolean(f.persona));
    assert(badPersona.length === 0, 'persona metadata present iff nature === "persona"');

    // branch/dirty live on RepoInfo (list_repos and member repos), not FolderInfo.
    const reposList = await probeA.send({ type: 'list_repos' });
    const repoByPath = new Map((reposList.data?.repos ?? []).map((r) => [r.path, r]));
    assert(repoByPath.get(join(rootB, 'delta'))?.branch === 'feature/zebra', 'delta reports branch feature/zebra (list_repos)');
    assert(repoByPath.get(join(rootA, 'beta'))?.dirty === true, 'beta reports dirty=true (list_repos)');
    assert(repoByPath.get(join(rootA, 'alpha'))?.dirty === false, 'alpha reports dirty=false (list_repos)');
    assert(repoByPath.get(join(rootA, 'alpha'))?.branch === 'main', 'alpha reports branch main (list_repos)');
    assert(repoByPath.has(charlieDir), 'shortcut target repo appears in the repo index (list_repos)');
    assert(!repoByPath.has(omegaDir) && !repoByPath.has(sigmaDir), 'persona folders are excluded from the repo index');

    section('W — update_folder favorite + registry round-trip');
    const favResp = await probeA.send({ type: 'update_folder', folderPath: join(rootA, 'beta'), favorite: true });
    assert(favResp.success === true, 'update_folder favorite succeeds');
    const list2 = await probeA.send({ type: 'list_folders' });
    assert(list2.data.folders.find((f) => f.path === join(rootA, 'beta'))?.favorite === true, 'favorite round-trips through the registry');
    const bEvent = await probeB.waitForEvent('folders_changed', (e) => e.folders?.some((f) => f.path === join(rootA, 'beta') && f.favorite === true));
    assert(Boolean(bEvent), 'client B receives folders_changed with the favorite (two-client sync)');

    section('W — create_hub + disband_hub (server-level, disk effects)');
    const createResp = await probeB.send({ type: 'create_hub', name: 'west', root: rootA, memberPaths: [join(rootA, 'alpha'), join(rootA, 'beta')] });
    assert(createResp.success === true && createResp.data?.folderPath === westDir, 'create_hub returns the hub folder path');
    const westStat = await stat(join(westDir, 'AGENTS.md')).then(
      () => true,
      () => false,
    );
    assert(westStat, 'hub folder exists on disk with AGENTS.md');
    const linkAlpha = await readlink(join(westDir, 'alpha')).catch(() => null);
    const linkBeta = await readlink(join(westDir, 'beta')).catch(() => null);
    assert(linkAlpha === join(rootA, 'alpha') && linkBeta === join(rootA, 'beta'), 'symlinks point at the absolute member paths');
    const westGit = await stat(join(westDir, '.git')).then(
      () => true,
      () => false,
    );
    assert(westGit, 'hub is self-describing: git init ran in the hub folder');
    const westIgnore = await readFile(join(westDir, '.gitignore'), 'utf8').catch(() => '');
    const westIgnoreLines = westIgnore.split('\n').filter(Boolean);
    assert(
      westIgnoreLines.includes('/alpha') && westIgnoreLines.includes('/beta'),
      `.gitignore lists root-anchored member symlink patterns (got: ${JSON.stringify(westIgnoreLines)})`,
    );
    const agentsMd = await readFile(join(westDir, 'AGENTS.md'), 'utf8');
    assert(/alpha/i.test(agentsMd) && /beta/i.test(agentsMd) && /agents\.md/i.test(agentsMd), 'AGENTS.md names both members and the AGENTS convention');
    const aGotHub = await probeA.waitForEvent('folders_changed', (e) => e.folders?.some((f) => f.path === westDir && (f.repos?.length ?? 0) === 2));
    assert(Boolean(aGotHub), 'client A receives folders_changed with the new hub row (two-client sync)');
    const list3 = await probeA.send({ type: 'list_folders' });
    const west = list3.data.folders.find((f) => f.path === westDir);
    assert(west?.repos?.length === 2 && west.repos.every((r) => r.branch), 'hub row lists both members with branch info (disband-eligible repos)');
    assert(west?.nature === 'code' && west?.shortcutCount === 2, 'hub classifies as code with shortcutCount = member count');
    assert(west.repos.find((r) => r.path === join(rootA, 'beta'))?.dirty === true, 'member repo chip data carries dirty=true for beta');

    const disbandResp = await probeB.send({ type: 'disband_hub', folderPath: westDir });
    assert(disbandResp.success === true, 'disband_hub succeeds');
    const westGone = await stat(westDir).then(
      () => false,
      () => true,
    );
    assert(westGone, 'hub folder deleted from disk after disband');
    const alphaAlive = await stat(join(rootA, 'alpha', '.git')).then(
      () => true,
      () => false,
    );
    const betaAlive = await stat(join(rootA, 'beta', '.git')).then(
      () => true,
      () => false,
    );
    assert(alphaAlive && betaAlive, 'member repos untouched by disband');
    const refuse = await probeB.send({ type: 'disband_hub', folderPath: join(rootA, 'alpha') });
    assert(refuse.success === false, 'disband refuses a plain code folder');
    const refuseSource = await probeB.send({ type: 'disband_hub', folderPath: sourceHubDir });
    assert(refuseSource.success === false, 'disband refuses a source hub without a registry entry (no deletion ownership)');

    // Re-create west over WS so the browser phase can observe it appearing
    // live via folders_changed (two-client sync in the browser direction).
    await probeB.send({ type: 'create_hub', name: 'west', root: rootA, memberPaths: [join(rootA, 'alpha'), join(rootA, 'beta')] });

    // ============================================================
    section('W — unscanned-cwd session fallback (classifyFolder)');
    // ============================================================
    // Sessions may live in cwds outside the scan roots (voice, takeover,
    // session-replacement flows): list/open must work there and serve a
    // synthetic folder row classified on the fly — without listing or
    // curating the cwd merely because a session was opened in it.
    const strayCode = join(sandboxHome, 'stray-code'); // no git, no marker
    const strayPersona = join(sandboxHome, 'stray-persona'); // marker front matter
    await mkdir(strayCode, { recursive: true });
    await writePersona(strayPersona, 'Stray Persona', 'Persona outside the scan roots');
    await seedSession(join(agentDir, 'sessions'), strayCode, 'Session in an unscanned cwd', 'Answer from the fallback.');

    const straySessions = await probeA.send({ type: 'list_sessions', folderPath: strayCode });
    assert(
      straySessions.success === true && straySessions.data.sessions.some((s) => s.firstMessage === 'Session in an unscanned cwd'),
      'list_sessions lists sessions in an unscanned cwd',
    );

    const codeOpen = await probeA.send({ type: 'open_session', folderPath: strayCode });
    assert(codeOpen.success === true && Boolean(codeOpen.data?.sessionId), 'open_session succeeds in an unscanned plain cwd');
    const codeOpened = await probeA.waitForEvent('session_opened', (e) => e.sessionId === codeOpen.data.sessionId);
    const codeFolder = codeOpened?.folder;
    assert(
      codeFolder?.path === strayCode && codeFolder?.name === 'stray-code' && codeFolder?.nature === 'code' && codeFolder?.persona === undefined && codeFolder?.shortcutCount === 0,
      'fallback folder row: basename name, code nature (no marker, no git), shortcutCount 0',
    );
    assert(
      codeFolder?.favorite === false && codeFolder?.archived === false && codeFolder?.missing === false && Array.isArray(codeFolder?.tags) && codeFolder?.tags.length === 0,
      'fallback folder row carries plain defaults (favorite/archived/missing false, tags empty)',
    );

    const personaOpen = await probeA.send({ type: 'open_session', folderPath: strayPersona });
    assert(personaOpen.success === true && Boolean(personaOpen.data?.sessionId), 'open_session succeeds in an unscanned persona-marker cwd');
    const personaOpened = await probeA.waitForEvent('session_opened', (e) => e.sessionId === personaOpen.data?.sessionId);
    const personaFolder = personaOpened?.folder;
    assert(
      personaFolder?.nature === 'persona' &&
        personaFolder?.name === 'stray-persona' &&
        personaFolder?.persona?.name === 'Stray Persona' &&
        personaFolder?.persona?.description === 'Persona outside the scan roots',
      'fallback classifies the marker cwd as persona with its front-matter metadata',
    );

    const afterFallback = await probeA.send({ type: 'list_folders' });
    assert(
      !afterFallback.data.folders.some((f) => f.path === strayCode || f.path === strayPersona),
      'unscanned cwds are never listed merely because a session was opened there',
    );

    // ============================================================
    section('W — legacy registry read-compat (multiRepo → hubs)');
    // ============================================================
    // A registry.json written before the rename (legacy `multiRepo` key)
    // must load unchanged — hub membership, overrides, and user tags all
    // survive — and the next write persists the `hubs` key.
    const registryPath = join(sandboxHome, '.local', 'state', 'pimote', 'projects', 'registry.json');
    await mkdir(join(sandboxHome, '.local', 'state', 'pimote', 'projects'), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          overrides: {
            [join(rootA, 'beta')]: { favorite: true },
            [join(rootB, 'delta')]: { favorite: true, tags: ['legacy-tag'] },
          },
          multiRepo: [{ path: westDir, name: 'west', memberPaths: [join(rootA, 'alpha'), join(rootA, 'beta')] }],
        },
        null,
        2,
      ),
    );
    await stopPimote(child);
    child = startPimote({ port, sandboxHome, agentDir, configPath, logPath });
    await waitForListening(child, port, logPath);
    probeA.close();
    probeB.close();
    probeA = new WsProbe(port, `pm-probe-a3-${randomUUID().slice(0, 8)}`);
    probeB = new WsProbe(port, `pm-probe-b3-${randomUUID().slice(0, 8)}`);
    await probeA.open();
    await probeB.open();

    const legacyList = await probeA.send({ type: 'list_folders' });
    const legacyWest = legacyList.data?.folders?.find((f) => f.path === westDir);
    assert(legacyWest?.nature === 'code' && legacyWest?.shortcutCount === 2 && legacyWest?.repos?.length === 2, 'legacy multiRepo hub loads: row, member repos, shortcut count');
    const legacyDelta = legacyList.data?.folders?.find((f) => f.path === join(rootB, 'delta'));
    assert(
      legacyDelta?.favorite === true && legacyDelta?.tags?.includes('legacy-tag') && legacyDelta?.userTags?.includes('legacy-tag'),
      'legacy overrides load: favorite and removable user tags',
    );
    assert(legacyList.data?.folders?.find((f) => f.path === join(rootA, 'beta'))?.favorite === true, 'existing favorite override survives the legacy document');

    // The next mutation re-persists the document under the new `hubs` key.
    const migrateResp = await probeA.send({ type: 'update_folder', folderPath: join(rootA, 'alpha'), addTags: ['migrated'] });
    assert(migrateResp.success === true, 'curation mutation after legacy load succeeds');
    const persisted = JSON.parse(await readFile(registryPath, 'utf8'));
    assert(Array.isArray(persisted.hubs) && persisted.hubs.some((h) => h.path === westDir) && persisted.multiRepo === undefined, 'next write persists the hubs key (multiRepo retired)');
    await probeA.send({ type: 'update_folder', folderPath: join(rootA, 'alpha'), removeTags: ['migrated'] });

    // ============================================================
    section('B — dashboard render (desktop): icons, personas, sparse scan');
    // ============================================================
    await browser(['close'], { allowFailure: true });
    await browser(['set', 'viewport', '1280', '900']);
    await browser(['open', `http://127.0.0.1:${port}/`]);
    await browser(['wait', 3000]);
    const snap = (await browser(['snapshot', '-i'])).stdout;
    assert(snap.includes('New session'), 'dashboard exposes the New session button');
    const pageText = String(await evalBrowser('document.body.innerText'));
    for (const name of ['alpha', 'beta', 'delta', 'lib', 'deep-repo', 'deepest', 'charlie', 'source-repo', 'kiwi', 'Omega', 'Sigma Persona', 'west']) {
      assert(pageText.includes(name), `dashboard lists folder ${name}`);
    }
    assert(!pageText.includes('gamma'), 'skipped wrapper gamma absent from the dashboard');
    // Four icon variants by nature × shortcutCount.
    assert((await rowIcon(join(rootA, 'beta'))) === 'code', 'beta renders the code icon');
    assert((await rowIcon(westDir)) === 'code-hub', 'west renders the code-hub icon');
    assert((await rowIcon(omegaDir)) === 'persona', 'omega renders the persona icon');
    assert((await rowIcon(sigmaDir)) === 'persona-hub', 'sigma renders the persona-hub icon');
    // Persona rows lead with the persona display name + description subtitle.
    const omegaText = await rowText(omegaDir);
    assert(omegaText.includes('Omega') && omegaText.includes('Fixture persona without shortcuts'), 'persona row shows the persona name and description subtitle');
    const sigmaText = await rowText(sigmaDir);
    assert(sigmaText.includes('Sigma Persona') && !sigmaText.includes('sigma'), 'persona row never shows the folder basename as its name');
    // Hub create lives in the toolbar overflow menu (folder vocabulary).
    await browser(['click', 'button[title="More folder actions"]']);
    await browser(['wait', 400]);
    const toolbarMenuSnap = (await browser(['snapshot', '-i'])).stdout;
    assert(toolbarMenuSnap.includes('Create hub'), 'toolbar exposes the hub creation control');
    await browser(['press', 'Escape']);
    await browser(['wait', 300]);
    const managerAffordance = await evalBrowser(`Boolean(document.querySelector('button[aria-label="Switch to the manager"]'))`);
    assert(managerAffordance === true, 'manager affordance is in the home toolbar');

    // west was created by client B before this browser loaded, so it is
    // part of the initial list_folders payload.
    const westText = await rowText(westDir);
    assert(westText.includes('alpha') && westText.includes('beta'), 'hub member chips render on the west row');

    // Live broadcast INTO the browser: client A (probe) favorites a folder;
    // the dashboard re-renders without a reload.
    await probeA.send({ type: 'update_folder', folderPath: join(rootA, 'gamma', 'lib'), favorite: true });
    let libStar = false;
    for (let i = 0; i < 20; i++) {
      await wait(300);
      libStar = await evalBrowser(
        `(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(join(rootA, 'gamma', 'lib'))} + '"]'); return Boolean(s?.closest('.group')?.querySelector('svg.fill-yellow-500')); })()`,
      );
      if (libStar === true) break;
    }
    assert(libStar === true, 'favorite made by client A appears live in the browser (folders_changed re-render)');

    await browser(['screenshot', join(shotsDir, '01-dashboard.png')], { allowFailure: true });

    // ============================================================
    section('B — new-session dialog search (folders + persona display names)');
    // ============================================================
    await evalBrowser(`(() => { const b = document.querySelector('button[aria-label="New session"]'); if (!b) return false; b.click(); return true; })()`);
    await browser(['wait', 400]);
    await fillSelector('[role="dialog"] input[placeholder="Search folders"]', 'alp');
    await browser(['wait', 300]);
    const searchText = String(await evalBrowser('document.body.innerText'));
    assert(searchText.includes('alpha'), 'search keeps matching folder alpha');
    assert(!/\bdelta\b/.test(searchText.split('Start a new session')[1] ?? ''), 'search filters non-matching folders in the picker');
    await fillSelector('[role="dialog"] input[placeholder="Search folders"]', 'Sigma Persona');
    await browser(['wait', 300]);
    const personaSearch = String(await evalBrowser(`(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.innerText : ''; })()`));
    assert(personaSearch.includes('Sigma Persona') && !personaSearch.includes('delta'), 'picker search matches persona display names and filters the rest');
    await browser(['screenshot', join(shotsDir, '02-search.png')], { allowFailure: true });
    await browser(['find', 'role', 'button', 'click', '--name', 'Cancel']);
    await browser(['wait', 300]);

    // ============================================================
    section('B — new session from a folder (journey 1) + warm cache');
    // ============================================================
    const newSessionOk = await evalBrowser(`(() => { const b = document.querySelector('button[title="New session in alpha"]'); if (!b) return false; b.click(); return true; })()`);
    assert(newSessionOk === true, 'per-folder new-session button clickable');
    // The session composer replaces the manager pane; placeholders are not in
    // innerText, so assert on elements: a non-manager textarea + StatusBar gear.
    let composerSeen = false;
    for (let i = 0; i < 30; i++) {
      await wait(500);
      const state = await evalBrowser(
        `(() => ({ composer: Boolean(document.querySelector('textarea:not([aria-label="Message the manager"])')), status: Boolean(document.querySelector('[title="Session settings"]')) }))()`,
      );
      if (state?.composer) {
        composerSeen = true;
        assert(state.status === true, 'session StatusBar visible');
        break;
      }
    }
    assert(composerSeen, 'session view mounted (composer visible)');
    // Green active dot on alpha's row once back on the dashboard.
    const closeOk = await evalBrowser(
      `(() => { const x = document.querySelector('button.bg-primary span[title="Close session"]'); if (!x) return false; x.click(); return true; })()`,
    );
    assert(closeOk === true, 'viewed-session chip exposes Close session');
    await browser(['wait', 1500]);
    const dashText = String(await evalBrowser('document.body.innerText'));
    assert(dashText.includes('New session'), 'closing the session returns to the dashboard');
    assert((await rowText(join(rootA, 'beta'))).includes('beta'), 'warm cache: folder list survives session navigation without a reload');
    // Live-session indicator across clients: the probe opens a session in
    // beta; the dashboard (still open in the browser) lights beta's dot.
    await probeA.send({ type: 'open_session', folderPath: join(rootA, 'beta') });
    let betaDot = false;
    for (let i = 0; i < 20; i++) {
      await wait(500);
      betaDot = await evalBrowser(
        `(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(join(rootA, 'beta'))} + '"]'); return Boolean(s?.closest('.group')?.querySelector('.bg-status-connected')); })()`,
      );
      if (betaDot === true) break;
    }
    assert(betaDot === true, 'beta row shows the active-session dot for a session opened by another client');

    // ============================================================
    section('B — resume fabricated session (journey 1/2 settled half)');
    // ============================================================
    // One row tap expands the folder to its full session history.
    await evalBrowser(
      `(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(join(rootA, 'alpha'))} + '"]'); if (!s) return false; s.closest('button').click(); return true; })()`,
    );
    await browser(['wait', 600]);
    const resumeOk = await evalBrowser(
      `(() => { const rows = Array.from(document.querySelectorAll('button')).filter(b => (b.textContent ?? '').includes('launch checklist')); if (!rows.length) return 'no-row'; rows[0].click(); return 'clicked'; })()`,
    );
    log('resume row:', resumeOk);
    assert(resumeOk === 'clicked', 'session history row for the fabricated session is listed');
    await browser(['wait', 3000]);
    const resumeText = String(await evalBrowser('document.body.innerText'));
    assert(resumeText.includes('What is the launch checklist?'), 'resume renders the fabricated user message');
    assert(resumeText.includes('Fuel the rocket'), 'resume renders the fabricated assistant message');
    await browser(['screenshot', join(shotsDir, '03-resume.png')], { allowFailure: true });
    await evalBrowser(`document.querySelector('button.bg-primary span[title="Close session"]')?.click()`);
    await browser(['wait', 1500]);

    // ============================================================
    section('B — favorite + reload persistence (reconnect refetch)');
    // ============================================================
    const favBefore = Number(await evalBrowser(`document.querySelectorAll('svg.fill-yellow-500').length`));
    const favClick = await evalBrowser(`(() => { const b = document.querySelector('button[aria-label="Favorite alpha"]'); if (!b) return false; b.click(); return true; })()`);
    assert(favClick === true, 'alpha star button clickable');
    await browser(['wait', 800]);
    const favAfter = Number(await evalBrowser(`document.querySelectorAll('svg.fill-yellow-500').length`));
    assert(favAfter === favBefore + 1, `alpha star toggled to favorite (${favBefore} → ${favAfter})`);
    await browser(['reload']);
    await browser(['wait', 2500]);
    const alphaStarAfterReload = await evalBrowser(
      `(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(join(rootA, 'alpha'))} + '"]'); return Boolean(s?.closest('.group')?.querySelector('svg.fill-yellow-500')); })()`,
    );
    assert(alphaStarAfterReload === true, 'favorite survives reload');
    // Favorites-first ordering (manual ordering is retired).
    const favoriteOrder = await evalBrowser(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-folder-path]'));
      const flags = rows.map((s) => Boolean(s.closest('.group')?.querySelector('svg.fill-yellow-500')));
      const lastFav = flags.lastIndexOf(true);
      const firstPlain = flags.indexOf(false);
      return firstPlain === -1 || lastFav < firstPlain;
    })()`);
    assert(favoriteOrder === true, 'favorite rows sort above non-favorite rows');

    // ============================================================
    section('B — tags (add, search, persist, remove)');
    // ============================================================
    await evalBrowser(`(() => { const b = document.querySelector('button[aria-label="Add tag to alpha"]'); if (!b) return false; b.click(); return true; })()`);
    await browser(['wait', 400]);
    await fillSelector('[role="dialog"] input[placeholder="Tag name"]', 'client-work');
    await clickDialogButton('Add tag');
    await browser(['wait', 800]);
    assert((await rowText(join(rootA, 'alpha'))).includes('client-work'), 'tag chip renders on the folder row');
    // Search over tags surfaces the folder (toolbar search box).
    await fillSelector('input[aria-label="Search folders"]', 'client-work');
    await browser(['wait', 400]);
    const tagSearch = String(await evalBrowser('document.body.innerText'));
    assert(tagSearch.includes('alpha'), 'tag search surfaces the tagged folder');
    await fillSelector('input[aria-label="Search folders"]', '');
    await browser(['wait', 300]);
    // Reload persistence
    await browser(['reload']);
    await browser(['wait', 2500]);
    assert((await rowText(join(rootA, 'alpha'))).includes('client-work'), 'tag survives reload');
    // Remove via chip ×
    await evalBrowser(`(() => { const x = document.querySelector('button[aria-label="Remove tag client-work"]'); if (!x) return false; x.click(); return true; })()`);
    await browser(['wait', 800]);
    assert(!(await rowText(join(rootA, 'alpha'))).includes('client-work'), 'tag removal via chip x works');
    // Source-contributed tags are not user-removable.
    const sourceRowText = await rowText(sourceRepoDir);
    assert(sourceRowText.includes('from-source'), 'source tag chip renders on the source row');
    const removableSourceTag = await evalBrowser(`Boolean(document.querySelector('button[aria-label="Remove tag from-source"]'))`);
    assert(removableSourceTag === false, 'source-contributed tags carry no remove affordance');

    // ============================================================
    section('B — archive / show-archived');
    // ============================================================
    await probeA.send({ type: 'update_folder', folderPath: deepRepoDir, archived: true });
    let deepHidden = false;
    for (let i = 0; i < 20; i++) {
      await wait(300);
      deepHidden = (await evalBrowser(`Boolean(document.querySelector('[data-folder-path="' + ${JSON.stringify(deepRepoDir)} + '"]'))`)) === false;
      if (deepHidden) break;
    }
    assert(deepHidden === true, 'archived folder hidden by default (folders_changed applied)');
    await browser(['click', 'button[title="More folder actions"]']);
    await browser(['wait', 400]);
    const showArchivedClicked = await clickMenuItem('Show archived');
    assert(showArchivedClicked === true, 'toolbar exposes Show archived');
    await browser(['wait', 800]);
    const deepBadge = await rowText(deepRepoDir);
    assert(deepBadge.includes('Archived'), 'show-archived reveals the folder with an Archived badge');
    await browser(['screenshot', join(shotsDir, '04-archived.png')], { allowFailure: true });
    await probeA.send({ type: 'update_folder', folderPath: deepRepoDir, archived: false });
    await wait(1200);
    assert(!(await rowText(deepRepoDir)).includes('Archived'), 'unarchive removes the badge');
    await browser(['click', 'button[title="More folder actions"]']);
    await browser(['wait', 400]);
    await clickMenuItem('Hide archived');
    await browser(['wait', 600]);

    // ============================================================
    section('B — create folder (mkdir + git init)');
    // ============================================================
    await evalBrowser(`(() => { const b = document.querySelector('button[aria-label="New session"]'); if (!b) return false; b.click(); return true; })()`);
    await browser(['wait', 400]);
    await browser(['find', 'role', 'button', 'click', '--name', 'Create new folder']);
    await browser(['wait', 400]);
    // Two roots configured → root picker. Pick root A.
    await evalBrowser(
      `(() => { const btns = Array.from(document.querySelectorAll('[role="dialog"] button')).filter(b => b.textContent?.trim() === ${JSON.stringify(rootA)}); btns[0]?.click(); return btns.length; })()`,
    );
    await browser(['wait', 300]);
    await fillSelector('[role="dialog"] input[placeholder="Folder name"]', 'epsilon');
    await browser(['wait', 200]);
    await clickDialogButton('Create');
    let createOpened = false;
    for (let i = 0; i < 30; i++) {
      await wait(500);
      const composer = await evalBrowser(`Boolean(document.querySelector('textarea:not([aria-label="Message the manager"])'))`);
      if (composer === true) {
        createOpened = true;
        break;
      }
    }
    assert(createOpened, 'create flow opens the new session');
    await evalBrowser(`document.querySelector('button.bg-primary span[title="Close session"]')?.click()`);
    await browser(['wait', 2000]);
    const dashAfterCreate = String(await evalBrowser('document.body.innerText'));
    assert(dashAfterCreate.includes('epsilon'), 'created folder appears in the dashboard');
    const epsilonGit = await stat(join(epsilon, '.git')).then(
      () => true,
      () => false,
    );
    assert(epsilonGit, 'epsilon/.git exists on disk (mkdir + git init)');

    // ============================================================
    section('B — hub creation via UI dialog + member chips');
    // ============================================================
    await browser(['click', 'button[title="More folder actions"]']);
    await browser(['wait', 400]);
    const createHubMenu = await clickMenuItem('Create hub');
    assert(createHubMenu === true, 'toolbar menu opens the hub dialog');
    await browser(['wait', 600]);
    await fillSelector('[role="dialog"] input[placeholder="Hub name"]', 'lima');
    await browser(['wait', 200]);
    const rootPick = await evalBrowser(
      `(() => { const btns = Array.from(document.querySelectorAll('[role="dialog"] button')).filter(b => b.textContent?.trim() === ${JSON.stringify(rootA)}); if (!btns.length) return 0; btns[0].click(); return btns.length; })()`,
    );
    assert(Number(rootPick) >= 1, 'hub dialog lists configured roots');
    const memberClicks = await evalBrowser(
      `(() => {
        const rows = Array.from(document.querySelectorAll('[role="dialog"] button')).filter(b => b.textContent?.includes(${JSON.stringify(join(rootA, 'alpha'))}) || b.textContent?.includes(${JSON.stringify(join(rootB, 'delta'))}));
        rows.forEach(r => r.click());
        return rows.length;
      })()`,
    );
    assert(Number(memberClicks) === 2, 'member picker lists alpha and delta; both selected');
    await browser(['screenshot', join(shotsDir, '05-hub-dialog.png')], { allowFailure: true });
    await clickDialogButton('Create hub');
    await browser(['wait', 1500]);
    const afterCreate = String(await evalBrowser('document.body.innerText'));
    assert(afterCreate.includes('lima'), 'lima appears in the dashboard after UI creation');
    const limaChips = await rowText(limaDir);
    assert(limaChips.includes('alpha') && /main/.test(limaChips), 'lima chip: alpha with branch main');
    assert(limaChips.includes('delta') && /feature\/zebra/.test(limaChips), 'lima chip: delta with branch feature/zebra');
    await browser(['screenshot', join(shotsDir, '06-hub-chips.png')], { allowFailure: true });

    // Dirty chip visual: west contains beta (dirty).
    const westDirty = await evalBrowser(
      `(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(westDir)} + '"]'); const row = s?.closest('.group'); const chip = Array.from(row?.querySelectorAll('span[title]') ?? []).find(x => (x.getAttribute('title') ?? '').includes('beta')); return chip?.querySelector('span[title="Uncommitted changes"]') ? 'dirty-dot' : 'no-dirty-dot'; })()`,
    );
    assert(westDirty === 'dirty-dot', 'beta chip in west shows the dirty dot');

    // ============================================================
    section('B — disband via UI confirm');
    // ============================================================
    const limaMenu = await openRowMenu(limaDir);
    assert(limaMenu === true, 'row context menu opens on the hub row');
    const disbandItem = await clickMenuItem('Disband hub');
    assert(disbandItem === true, 'context menu exposes Disband hub');
    await browser(['wait', 400]);
    const disbandDialogText = String(await evalBrowser(`(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.textContent : ''; })()`));
    assert(disbandDialogText.includes('This deletes the hub folder'), 'disband dialog warns in hub vocabulary');
    await clickDialogButton('Disband');
    await browser(['wait', 1500]);
    const afterDisband = String(await evalBrowser('document.body.innerText'));
    assert(!afterDisband.includes('lima'), 'disbanded hub removed from the dashboard');
    const limaGone = await stat(limaDir).then(
      () => false,
      () => true,
    );
    assert(limaGone, 'lima folder deleted from disk');
    const deltaAlive = await stat(join(rootB, 'delta', '.git')).then(
      () => true,
      () => false,
    );
    assert(deltaAlive, 'member repo delta untouched by UI disband');
    // A generic shortcut-bearing folder shows the hub icon but gains no
    // deletion rights — sigma is not a registry/source hub.
    const sigmaMenu = await openRowMenu(sigmaDir);
    const sigmaDisband = await evalBrowser(
      `Boolean(Array.from(document.querySelectorAll('[role="menuitem"], [data-slot="context-menu-item"]')).find(i => i.textContent?.includes('Disband hub')))`,
    );
    assert(sigmaMenu && sigmaDisband === false, 'generic shortcut persona has no Disband hub menu entry');
    await browser(['press', 'Escape']);
    await browser(['wait', 300]);

    // ============================================================
    section('B — source hooks: missing source repo provisions on open');
    // ============================================================
    assert((await rowText(sourceRepoDir)).includes('source-repo'), 'missing source repo renders as a folder row');
    const missingTitle = await evalBrowser(
      `(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(sourceRepoDir)} + '"]'); return s?.closest('button')?.getAttribute('title') ?? ''; })()`,
    );
    assert(missingTitle === 'Open — its source will create this folder', 'missing folder row carries the source-creation title');
    const sourceRowClicked = await evalBrowser(
      `(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(sourceRepoDir)} + '"]'); if (!s) return false; s.closest('button').click(); return true; })()`,
    );
    assert(sourceRowClicked === true, 'clicking the missing row attempts the open');
    let provisioned = false;
    for (let i = 0; i < 20; i++) {
      await wait(400);
      provisioned = await stat(join(sourceRepoDir, '.git')).then(
        () => true,
        () => false,
      );
      if (provisioned) break;
    }
    assert(provisioned, 'onFolderOpen hook provisioned the missing repo (mkdir + git init)');
    const hookRan = await readFile(hookLog, 'utf8').then(
      (text) => text.split('\n').includes(sourceRepoDir),
      () => false,
    );
    assert(hookRan, 'onFolderOpen hook ran for the opened folder path');
    const listAfterHook = await probeA.send({ type: 'list_folders' });
    assert(listAfterHook.data.folders.find((f) => f.path === sourceRepoDir)?.missing === false, 'provisioned repo no longer reports missing');
    await evalBrowser(`document.querySelector('button.bg-primary span[title="Close session"]')?.click()`);
    await browser(['wait', 1500]);

    // ============================================================
    section('B — manager chat: streamed response (live LLM)');
    // ============================================================
    if (jetsonUsable) {
      const managerMode = await ensureManagerMode();
      assert(managerMode, 'manager composer reachable from the home toolbar');
      const filled = await fillSelector('textarea[aria-label="Message the manager"]', 'Reply with exactly: PONG');
      assert(filled, 'manager composer accepts text');
      await evalBrowser(`(() => { const b = document.querySelector('button[title="Send"]'); if (!b) return false; b.click(); return true; })()`);
      // Catch the working state (Abort button) early.
      let sawAbort = false;
      for (let i = 0; i < 12; i++) {
        await wait(250);
        const aborting = await evalBrowser(`Boolean(document.querySelector('button[title="Abort"]'))`);
        if (aborting === true) {
          sawAbort = true;
          break;
        }
      }
      soft(sawAbort, 'Send swaps to Abort while the manager is working', 'local model answered too fast to observe');
      // First admitted prompt opens the manager panel side-by-side on desktop.
      const panelSeen = await evalBrowser(
        `(() => { const b = document.querySelector('[aria-label="Dismiss manager conversation"]'); return Boolean(b && b.offsetParent !== null); })()`,
      );
      assert(panelSeen === true, 'manager conversation opens side-by-side on desktop');
      let replied = false;
      for (let i = 0; i < 90; i++) {
        await wait(1000);
        // Assistant text only — the user's own prompt contains "PONG".
        const pong = await evalBrowser(`/PONG/i.test(Array.from(document.querySelectorAll('.assistant-message')).map((e) => e.innerText).join(' '))`);
        if (pong === true) {
          replied = true;
          break;
        }
        const stillWorking = await evalBrowser(`Boolean(document.querySelector('button[title="Abort"]'))`);
        if (stillWorking !== true && i > 8) break;
      }
      soft(replied, 'manager streams a reply containing PONG', 'local model unreachable or slow — see server log');
      await browser(['screenshot', join(shotsDir, '07-manager-reply.png')], { allowFailure: true });
    } else {
      console.log('  ⊝ manager LLM journey skipped — no jetson provider in models.json');
      softFailures.push('manager LLM (no provider)');
    }

    // ============================================================
    section('B — manager tool use (pimote_list_folders through the ports)');
    // ============================================================
    if (jetsonUsable) {
      const listNow = await probeA.send({ type: 'list_folders' });
      const expectedCount = listNow.data.folders.length;
      await ensureManagerMode();
      await fillSelector(
        'textarea[aria-label="Message the manager"]',
        'Call the pimote_list_folders tool now. After it returns, reply with ONLY the number of folders, nothing else.',
      );
      await evalBrowser(`(() => { const b = document.querySelector('button[title="Send"]'); if (!b) return false; b.click(); return true; })()`);
      let sawToolCall = false;
      let answer = null;
      for (let i = 0; i < 90; i++) {
        await wait(1000);
        const state = await evalBrowser(
          `(() => {
            const assistant = Array.from(document.querySelectorAll('.assistant-message')).map((e) => e.innerText).join(' ');
            const toolNames = Array.from(document.querySelectorAll('.tool-block .tool-name')).map((e) => e.textContent.trim());
            return { toolCall: toolNames.includes('pimote_list_folders'), assistant, tail: document.body.innerText.slice(-400) };
          })()`,
        );
        if (state?.toolCall) sawToolCall = true;
        if (state && !state.tail.includes('Abort')) {
          const numbers = String(state.assistant ?? '').match(/\d+/g);
          if (numbers?.length) answer = Number(numbers[numbers.length - 1]);
          if (answer !== null && (state.toolCall || i > 30)) break;
        }
      }
      soft(sawToolCall, 'manager rendered a pimote_list_folders tool call', 'model chose not to call the tool');
      soft(answer === expectedCount, `manager answered the folder count (${answer} vs expected ${expectedCount})`, 'model reply unparseable or wrong');
      await browser(['screenshot', join(shotsDir, '08-manager-tool.png')], { allowFailure: true });
    }

    // ============================================================
    section('B — manager tool use (pimote_folder_tree)');
    // ============================================================
    if (jetsonUsable) {
      await ensureManagerMode();
      await fillSelector(
        'textarea[aria-label="Message the manager"]',
        'Call the pimote_folder_tree tool now (it takes no arguments). After it returns, reply with ONLY the word TREEDONE, nothing else.',
      );
      await evalBrowser(`(() => { const b = document.querySelector('button[title="Send"]'); if (!b) return false; b.click(); return true; })()`);
      let sawTreeCall = false;
      let treeDone = false;
      for (let i = 0; i < 90; i++) {
        await wait(1000);
        const state = await evalBrowser(
          `(() => {
            // Role-scoped: the user's own prompt names the tool and TREEDONE.
            const assistant = Array.from(document.querySelectorAll('.assistant-message')).map((e) => e.innerText).join(' ');
            const toolNames = Array.from(document.querySelectorAll('.tool-block .tool-name')).map((e) => e.textContent.trim());
            return { toolCall: toolNames.includes('pimote_folder_tree'), done: /TREEDONE/.test(assistant), tail: document.body.innerText.slice(-400) };
          })()`,
        );
        if (state?.toolCall) sawTreeCall = true;
        if (state?.done) {
          treeDone = true;
          break;
        }
        if (state && !state.tail.includes('Abort') && i > 30) break;
      }
      soft(sawTreeCall, 'manager rendered a pimote_folder_tree tool call', 'model chose not to call the tool');
      soft(treeDone, 'manager answered from the folder tree (TREEDONE)', 'model reply unparseable or missing');
      if (sawTreeCall) {
        // Expand the tool block and look at the rendered result payload.
        await evalBrowser(`(() => { const b = Array.from(document.querySelectorAll('.tool-block')).find((x) => x.querySelector('.tool-name')?.textContent.trim() === 'pimote_folder_tree'); if (!b) return false; b.querySelector('.tool-header')?.click(); return true; })()`);
        await wait(300);
        const shape = await evalBrowser(
          `(() => { const b = Array.from(document.querySelectorAll('.tool-block')).find((x) => x.querySelector('.tool-name')?.textContent.trim() === 'pimote_folder_tree'); const t = b?.innerText ?? ''; return /occurrences/i.test(t) && /shortcut/i.test(t); })()`,
        );
        soft(shape, 'rendered tree tool output carries the occurrences/shortcut shape', 'result render collapsed or tool errored');
      }
      await browser(['screenshot', join(shotsDir, '08b-manager-tree.png')], { allowFailure: true });
    }

    // ============================================================
    section('B — manager abort');
    // ============================================================
    if (jetsonUsable) {
      await ensureManagerMode();
      await fillSelector('textarea[aria-label="Message the manager"]', 'Count from 1 to 300 slowly, writing every number on its own line. Do not stop early.');
      await evalBrowser(`(() => { const b = document.querySelector('button[title="Send"]'); if (!b) return false; b.click(); return true; })()`);
      let abortClicked = false;
      for (let i = 0; i < 40; i++) {
        await wait(500);
        const working = await evalBrowser(`Boolean(document.querySelector('button[title="Abort"]'))`);
        if (working === true) {
          await evalBrowser(`(() => { const b = document.querySelector('button[title="Abort"]'); if (!b) return false; b.click(); return true; })()`);
          abortClicked = true;
          break;
        }
      }
      assert(abortClicked, 'abort flow: Abort button appeared and was clicked');
      // The toolbar renders Send only with a non-empty draft, so idle-after-
      // abort reads as the Abort control clearing.
      let idleAgain = false;
      for (let i = 0; i < 20; i++) {
        await wait(500);
        const working = await evalBrowser(`Boolean(document.querySelector('button[title="Abort"]'))`);
        if (working === false) {
          idleAgain = true;
          break;
        }
      }
      assert(idleAgain, 'abort returns the manager to idle (Abort clears)');
      if (abortClicked && idleAgain) {
        // Numeric tokens across the page: the rest of the dashboard is static
        // over the window, so a frozen count means the stream stopped.
        const countNumbers = () => evalBrowser(`(document.body.innerText.match(/\\b\\d+\\b/g) ?? []).length`);
        await wait(1500);
        const n1 = Number(await countNumbers());
        await wait(3000);
        const n2 = Number(await countNumbers());
        assert(n1 === n2, `run stopped after abort (stream frozen at ${n1} numbers)`);
      }
    }

    // ============================================================
    section('B — manager transcript is ephemeral across connections');
    // ============================================================
    await browser(['reload']);
    await browser(['wait', 3000]);
    const managerGone = await evalBrowser(`Boolean(document.querySelector('[aria-label="Dismiss manager conversation"]'))`);
    const pageAfterReload = String(await evalBrowser('document.body.innerText'));
    assert(managerGone === false && !pageAfterReload.includes('PONG'), 'fresh connection starts with an empty manager transcript');

    // ============================================================
    section('B — missing member chip after disk deletion + restart');
    // ============================================================
    await probeA.send({ type: 'create_hub', name: 'zulu', root: rootA, memberPaths: [join(rootA, 'beta')] });
    await rm(join(rootA, 'beta'), { recursive: true, force: true });
    await stopPimote(child);
    child = startPimote({ port, sandboxHome, agentDir, configPath, logPath });
    await waitForListening(child, port, logPath);
    probeA.close();
    probeB.close();
    probeA = new WsProbe(port, `pm-probe-a2-${randomUUID().slice(0, 8)}`);
    probeB = new WsProbe(port, `pm-probe-b2-${randomUUID().slice(0, 8)}`);
    await probeA.open();
    await probeB.open();
    const reconnectList = await probeA.send({ type: 'list_folders' });
    assert(reconnectList.success === true && reconnectList.data.folders.some((f) => f.path === zuluDir), 'probes reconnect after restart; list_folders serves the warm registry');
    await browser(['reload']);
    await browser(['wait', 3500]);
    const missingChip = await evalBrowser(
      `(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(zuluDir)} + '"]'); const row = s?.closest('.group'); if (!row) return 'no-row'; const chip = Array.from(row.querySelectorAll('span[title]')).find(x => (x.getAttribute('title') ?? '').includes('missing')); return chip ? chip.textContent?.trim() : 'no-chip'; })()`,
    );
    assert(String(missingChip).includes('missing'), `missing member renders the warning chip (got "${missingChip}")`);
    await browser(['screenshot', join(shotsDir, '09-missing-chip.png')], { allowFailure: true });
    // Cleanup: disband zulu so the registry is left tidy.
    await probeA.send({ type: 'disband_hub', folderPath: zuluDir });

    probeA.close();
    probeB.close();

    // ============================================================
    section('B — mobile dashboard (manager affordance)');
    // ============================================================
    await browser(['set', 'viewport', '390', '844']);
    await browser(['reload']);
    await browser(['wait', 2500]);
    const mobileText = String(await evalBrowser('document.body.innerText'));
    assert(mobileText.includes('alpha'), 'mobile dashboard shows the folders list fullscreen');
    const mobileToggle = await evalBrowser(
      `(() => { const b = document.querySelector('button[aria-label="Switch to the manager"]'); return b && getComputedStyle(b).display !== 'none' ? 'toggle' : 'none'; })()`,
    );
    assert(mobileToggle === 'toggle', 'mobile toolbar exposes the manager mode toggle');
    if (jetsonUsable) {
      await evalBrowser(`(() => { const b = document.querySelector('button[aria-label="Switch to the manager"]'); if (!b) return false; b.click(); return true; })()`);
      await browser(['wait', 400]);
      const composerVisible = await evalBrowser(
        `(() => ({ count: document.querySelectorAll('textarea[aria-label="Message the manager"]').length, visible: Array.from(document.querySelectorAll('textarea[aria-label="Message the manager"]')).some(t => t.offsetParent !== null) }))()`,
      );
      assert(composerVisible?.count >= 1 && composerVisible?.visible === true, 'manager mode composer is visible on mobile');
      await fillSelector('textarea[aria-label="Message the manager"]', 'Reply with exactly: MOBILE');
      await evalBrowser(`(() => { const b = document.querySelector('button[title="Send"]'); if (!b) return false; b.click(); return true; })()`);
      await browser(['wait', 1200]);
      const sheetComposer = await evalBrowser(
        `(() => { const b = document.querySelector('[aria-label="Dismiss manager conversation"]'); return Boolean(b && b.offsetParent !== null); })()`,
      );
      assert(sheetComposer === true, 'manager chat opens fullscreen on mobile once the conversation exists');
      await browser(['screenshot', join(shotsDir, '10-mobile-manager.png')], { allowFailure: true });
    } else {
      soft(false, 'mobile manager sheet (conversation-driven)', 'no jetson provider — the sheet needs an admitted prompt');
    }

    await browser(['close'], { allowFailure: true });
  } catch (error) {
    failures++;
    console.error('[pm-smoke] FAILED:', error);
    try {
      const text = await readFile(logPath, 'utf8');
      console.error('[pm-smoke] server log tail:\n' + text.slice(-8000));
    } catch {
      // Ignore missing log.
    }
    await browser(['close'], { allowFailure: true }).catch(() => {});
  } finally {
    await stopPimote(child).catch(() => {});
    log('server log path:', logPath);
    if (failures === 0 && !process.env.PM_KEEP) await rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
    else log('sandbox preserved for inspection:', sandboxHome);
  }

  if (softFailures.length) {
    console.log(`\n[pm-smoke] environment-bounded items: ${softFailures.length}`);
    for (const item of softFailures) console.log(`  ⊝ ${item}`);
  }
  console.log(`\n[pm-smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[pm-smoke] uncaught:', error);
  process.exit(1);
});
