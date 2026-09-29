#!/usr/bin/env node
// End-to-end smoke for the project-management topic (dashboard, hubs, manager).
//
// Boots the real pimote server in an isolated HOME against a fabricated
// multi-root project tree (nested repos, a dirty repo, named branches, a
// fabricated pi session), seeds a local model via PI_CODING_AGENT_DIR for the
// manager LLM, and drives the real PWA with agent-browser plus a second
// WebSocket probe client (two-client `projects_changed` sync).
//
// Optional environment variables:
//   PM_SHOTS=/tmp/dir  keep coherence screenshots outside the disposable sandbox
//   PM_KEEP=1          keep the sandbox even on a passing run

import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile, appendFile } from 'node:fs/promises';
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

// -------------------------------------------------------------------- main

async function main() {
  console.log('[pm-smoke] project-management dashboard/hub/manager smoke');
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

  // --- Project tree.
  const rootA = join(sandboxHome, 'projects');
  const rootB = join(sandboxHome, 'work');
  await gitInit(join(rootA, 'alpha'), 'main');
  await gitInit(join(rootA, 'beta'), 'main', { dirty: true });
  await gitInit(join(rootA, 'gamma', 'lib'), 'main');
  await gitInit(join(rootA, 'gamma', 'sub', 'deep-repo'), 'main');
  await gitInit(join(rootA, 'gamma', 'sub', 'deeper', 'deepest'), 'main'); // depth 4 — must NOT be discovered
  await gitInit(join(rootB, 'delta'), 'feature/zebra');
  await seedSession(join(agentDir, 'sessions'), join(rootA, 'alpha'), 'What is the launch checklist?', '1. Fuel the rocket. 2. Wake the manager.');

  const configPath = join(configDir, 'config.json');
  const config = {
    roots: [rootA, rootB],
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
  const hubWest = join(rootA, 'hub-west');
  const hubLima = join(rootA, 'hub-lima');
  const hubZulu = join(rootA, 'hub-zulu');
  const epsilon = join(rootA, 'epsilon');

  try {
    child = startPimote({ port, sandboxHome, agentDir, configPath, logPath });
    await waitForListening(child, port, logPath);

    // ============================================================
    section('W — WebSocket structural probes');
    // ============================================================
    let probeA = new WsProbe(port, `pm-probe-a-${randomUUID().slice(0, 8)}`);
    let probeB = new WsProbe(port, `pm-probe-b-${randomUUID().slice(0, 8)}`);
    await probeA.open();
    await probeB.open();

    const list1 = await probeA.send({ type: 'list_projects' });
    const projects1 = list1.data?.projects ?? [];
    const byPath = new Map(projects1.map((p) => [p.path, p]));
    assert(list1.success === true, 'list_projects succeeds');
    assert(list1.data?.roots?.length === 2 && list1.data.roots.includes(rootA) && list1.data.roots.includes(rootB), 'roots echo both configured roots');
    for (const name of ['alpha', 'beta', 'delta']) {
      assert(byPath.has(name === 'delta' ? join(rootB, 'delta') : join(rootA, name)), `discovered single project: ${name}`);
    }
    // gamma itself is a plain directory, not a repo — only its children are repos.
    assert(!byPath.has(join(rootA, 'gamma')), 'plain directory containing repos is NOT listed as a project');
    assert(byPath.has(join(rootA, 'gamma', 'lib')), 'depth-2 repo discovered (gamma/lib)');
    assert(byPath.has(join(rootA, 'gamma', 'sub', 'deep-repo')), 'depth-3 repo discovered (gamma/sub/deep-repo)');
    assert(!byPath.has(join(rootA, 'gamma', 'sub', 'deeper', 'deepest')), 'depth-4 repo NOT discovered (depth bound)');
    assert(byPath.get(join(rootA, 'alpha'))?.kind === 'single', 'alpha is a single project');
    // branch/dirty live on RepoInfo (list_repos and hub members), not ProjectInfo.
    const reposList = await probeA.send({ type: 'list_repos' });
    const repoByPath = new Map((reposList.data?.repos ?? []).map((r) => [r.path, r]));
    assert(repoByPath.get(join(rootB, 'delta'))?.branch === 'feature/zebra', 'delta reports branch feature/zebra (list_repos)');
    assert(repoByPath.get(join(rootA, 'beta'))?.dirty === true, 'beta reports dirty=true (list_repos)');
    assert(repoByPath.get(join(rootA, 'alpha'))?.dirty === false, 'alpha reports dirty=false (list_repos)');
    assert(repoByPath.get(join(rootA, 'alpha'))?.branch === 'main', 'alpha reports branch main (list_repos)');
    assert(
      projects1.every((p) => typeof p.activeSessionCount === 'number'),
      'every project carries activeSessionCount',
    );
    const sortedNames = projects1.map((p) => p.name);
    const nameSorted = [...sortedNames].sort((a, b) => a.localeCompare(b));
    assert(JSON.stringify(sortedNames) === JSON.stringify(nameSorted), 'default listing is name-sorted');

    section('W — update_project favorite + registry round-trip');
    const favResp = await probeA.send({ type: 'update_project', projectPath: join(rootA, 'beta'), favorite: true });
    assert(favResp.success === true, 'update_project favorite succeeds');
    const list2 = await probeA.send({ type: 'list_projects' });
    assert(list2.data.projects.find((p) => p.path === join(rootA, 'beta'))?.favorite === true, 'favorite round-trips through the registry');
    const bEvent = await probeB.waitForEvent('projects_changed', (e) => e.projects?.some((p) => p.path === join(rootA, 'beta') && p.favorite === true));
    assert(Boolean(bEvent), 'client B receives projects_changed with the favorite (two-client sync)');

    section('W — create_hub_project + disband_project (server-level, disk effects)');
    const hubResp = await probeB.send({ type: 'create_hub_project', name: 'hub-west', root: rootA, repoPaths: [join(rootA, 'alpha'), join(rootA, 'beta')] });
    assert(hubResp.success === true && hubResp.data?.projectPath === hubWest, 'create_hub_project returns the hub path');
    const westStat = await stat(join(hubWest, 'AGENTS.md')).then(
      () => true,
      () => false,
    );
    assert(westStat, 'hub folder exists on disk with AGENTS.md');
    const linkAlpha = await readlink(join(hubWest, 'alpha')).catch(() => null);
    const linkBeta = await readlink(join(hubWest, 'beta')).catch(() => null);
    assert(linkAlpha === join(rootA, 'alpha') && linkBeta === join(rootA, 'beta'), 'symlinks point at the absolute member paths');
    const agentsMd = await readFile(join(hubWest, 'AGENTS.md'), 'utf8');
    assert(/alpha/i.test(agentsMd) && /beta/i.test(agentsMd) && /agents\.md/i.test(agentsMd), 'AGENTS.md names both members and the AGENTS convention');
    const aGotHub = await probeA.waitForEvent('projects_changed', (e) => e.projects?.some((p) => p.path === hubWest && p.kind === 'multi'));
    assert(Boolean(aGotHub), 'client A receives projects_changed with the new hub');
    const list3 = await probeA.send({ type: 'list_projects' });
    const west = list3.data.projects.find((p) => p.path === hubWest);
    assert(west?.repos?.length === 2 && west.repos.every((r) => r.branch), 'hub lists both members with branch info');
    assert(west.repos.find((r) => r.path === join(rootA, 'beta'))?.dirty === true, 'hub member chip data carries dirty=true for beta');

    const disbandResp = await probeB.send({ type: 'disband_project', projectPath: hubWest });
    assert(disbandResp.success === true, 'disband_project succeeds');
    const westGone = await stat(hubWest).then(
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
    const refuse = await probeB.send({ type: 'disband_project', projectPath: join(rootA, 'alpha') });
    assert(refuse.success === false, 'disband refuses a single-repo project');

    // Re-create hub-west over WS so the browser phase can observe it appearing
    // live via projects_changed (two-client sync in the browser direction).
    await probeB.send({ type: 'create_hub_project', name: 'hub-west', root: rootA, repoPaths: [join(rootA, 'alpha'), join(rootA, 'beta')] });

    // ============================================================
    section('B — dashboard render (desktop)');
    // ============================================================
    await browser(['close'], { allowFailure: true });
    await browser(['set', 'viewport', '1280', '900']);
    await browser(['open', `http://127.0.0.1:${port}/`]);
    await browser(['wait', 3000]);
    const snap = (await browser(['snapshot', '-i'])).stdout;
    assert(snap.includes('New session'), 'dashboard exposes the New session button');
    const pageText = String(await evalBrowser('document.body.innerText'));
    for (const name of ['alpha', 'beta', 'delta', 'lib', 'deep-repo']) {
      assert(pageText.includes(name), `dashboard lists project ${name}`);
    }
    assert(!pageText.includes('deepest'), 'depth-4 repo absent from the dashboard');
    // Hub creation lives in the toolbar overflow menu (redesign: compact projects toolbar).
    await browser(['click', 'button[title="More project actions"]']);
    await browser(['wait', 400]);
    const hubMenuSnap = (await browser(['snapshot', '-i'])).stdout;
    assert(hubMenuSnap.includes('Create multi-repo hub'), 'toolbar exposes the hub creation control');
    await browser(['press', 'Escape']);
    await browser(['wait', 300]);
    const managerVisible = await evalBrowser(
      `(() => { const ta = document.querySelector('textarea[aria-label="Message the manager"]'); return Boolean(ta && ta.offsetParent !== null); })()`,
    );
    assert(managerVisible === true, 'manager chat is side-by-side on desktop');

    // hub-west was created by client B before this browser loaded, so it is
    // part of the initial list_projects payload.
    assert(pageText.includes('hub-west'), 'hub created over WS is in the dashboard listing');

    // Live broadcast INTO the browser: client A (probe) favorites a project;
    // the dashboard re-renders without a reload.
    await probeA.send({ type: 'update_project', projectPath: join(rootA, 'gamma', 'lib'), favorite: true });
    let libStar = false;
    for (let i = 0; i < 20; i++) {
      await wait(300);
      libStar = await evalBrowser(
        `(() => { const row = Array.from(document.querySelectorAll('main .rounded-lg')).find(r => r.textContent?.trim().startsWith('lib')); return Boolean(row?.querySelector('svg.fill-yellow-500')); })()`,
      );
      if (libStar === true) break;
    }
    assert(libStar === true, 'favorite made by client A appears live in client A browser (projects_changed re-render)');
    const westChipText = await evalBrowser(
      `Array.from(document.querySelectorAll('span[title]')).filter(s => s.querySelector('span') && /alpha|beta/.test(s.textContent ?? '')).map(s => s.getAttribute('title')).join('|')`,
    );
    assert(String(westChipText).includes(join(rootA, 'alpha')), 'hub-west member chips render (title carries repo path)');

    await browser(['screenshot', join(shotsDir, '01-dashboard.png')], { allowFailure: true });

    // ============================================================
    section('B — new-session dialog search');
    // ============================================================
    await evalBrowser(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find(b => !b.getAttribute('title') && b.textContent?.trim().startsWith('New session')); b?.click(); return Boolean(b); })()`,
    );
    await browser(['wait', 400]);
    await fillSelector('input[placeholder="Search projects"]', 'alp');
    await browser(['wait', 300]);
    const searchText = String(await evalBrowser('document.body.innerText'));
    assert(searchText.includes('alpha'), 'search keeps matching project alpha');
    assert(!/\bdelta\b/.test(searchText.split('Start a new session')[1] ?? ''), 'search filters non-matching projects in the picker');
    await browser(['screenshot', join(shotsDir, '02-search.png')], { allowFailure: true });
    await browser(['find', 'role', 'button', 'click', '--name', 'Cancel']);
    await browser(['wait', 300]);

    // ============================================================
    section('B — new session from a project (journey 1)');
    // ============================================================
    const newSessionOk = await evalBrowser(`(() => { const b = document.querySelector('button[title="New session in alpha"]'); if (!b) return false; b.click(); return true; })()`);
    assert(newSessionOk === true, 'per-project new-session button clickable');
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
    // Live-session indicator across clients: the probe opens a session in
    // beta; the dashboard (still open in the browser) lights beta's dot.
    await probeA.send({ type: 'open_session', folderPath: join(rootA, 'beta') });
    let betaDot = false;
    for (let i = 0; i < 20; i++) {
      await wait(500);
      betaDot = await evalBrowser(
        `(() => { const row = Array.from(document.querySelectorAll('main .rounded-lg')).find(r => r.textContent?.trim().startsWith('beta')); return Boolean(row?.querySelector('.bg-status-connected')); })()`,
      );
      if (betaDot === true) break;
    }
    assert(betaDot === true, 'beta row shows the active-session dot for a session opened by another client');

    // ============================================================
    section('B — resume fabricated session (journey 1/2 settled half)');
    // ============================================================
    const resumeOk = await evalBrowser(
      `(() => { const rows = Array.from(document.querySelectorAll('button')).filter(b => (b.textContent ?? '').includes('launch checklist')); if (!rows.length) return 'no-row'; rows[0].click(); return 'clicked'; })()`,
    );
    log('resume row:', resumeOk);
    await browser(['wait', 3000]);
    const resumeText = String(await evalBrowser('document.body.innerText'));
    assert(resumeText.includes('What is the launch checklist?'), 'resume renders the fabricated user message');
    assert(resumeText.includes('Fuel the rocket'), 'resume renders the fabricated assistant message');
    await browser(['screenshot', join(shotsDir, '03-resume.png')], { allowFailure: true });
    await evalBrowser(`document.querySelector('button.bg-primary span[title="Close session"]')?.click()`);
    await browser(['wait', 1500]);

    // ============================================================
    section('B — favorite + reload persistence');
    // ============================================================
    const favBefore = Number(await evalBrowser(`document.querySelectorAll('main .rounded-lg svg.fill-yellow-500').length`));
    const favClick = await evalBrowser(
      `(() => { const rows = Array.from(document.querySelectorAll('button[title^="Manage project"]')); for (const manage of rows) { if ((manage.closest('.rounded-lg')?.textContent ?? '').trim().startsWith('alpha')) { manage.click(); return true; } } return false; })()`,
    );
    log('favorite menu open:', favClick);
    await browser(['wait', 400]);
    await browser(['find', 'role', 'menuitem', 'click', '--name', 'Favorite']);
    await browser(['wait', 800]);
    const favAfter = Number(await evalBrowser(`document.querySelectorAll('main .rounded-lg svg.fill-yellow-500').length`));
    assert(favAfter === favBefore + 1, `alpha star toggled to favorite (${favBefore} → ${favAfter})`);
    await browser(['reload']);
    await browser(['wait', 2500]);
    const alphaStarAfterReload = await evalBrowser(
      `(() => { const row = Array.from(document.querySelectorAll('main .rounded-lg')).find(r => r.textContent?.trim().startsWith('alpha')); return Boolean(row?.querySelector('svg.fill-yellow-500')); })()`,
    );
    assert(alphaStarAfterReload === true, 'favorite survives reload');

    // ============================================================
    section('B — manual order (move up)');
    // ============================================================
    // Move delta up until it reaches the top (name-sorted start position may vary).
    const firstNameEval = `(() => { const s = document.querySelector('main .rounded-lg [data-project-name]'); return s?.textContent?.trim() ?? ''; })()`;
    let first = String(await evalBrowser(firstNameEval));
    log('list order before move, first row:', first);
    let moves = 0;
    while (first !== 'delta' && moves < 8) {
      const opened = await evalBrowser(
        `(() => { const rows = Array.from(document.querySelectorAll('button[title^="Manage project"]')); for (const manage of rows) { if ((manage.closest('.rounded-lg')?.textContent ?? '').includes('delta')) { manage.click(); return true; } } return false; })()`,
      );
      if (opened !== true) break;
      await browser(['wait', 500]);
      const disabled = await evalBrowser(
        `(() => { const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(i => i.textContent?.includes('Move up')); return item ? item.getAttribute('disabled') !== null || item.dataset.disabled === '' : 'no-menu'; })()`,
      );
      if (disabled === true) break;
      await browser(['find', 'role', 'menuitem', 'click', '--name', 'Move up']);
      await browser(['wait', 1200]);
      first = String(await evalBrowser(firstNameEval));
      moves++;
    }
    assert(first === 'delta', `moved delta to the top of the list in ${moves} move(s) (got "${first}")`);
    await browser(['reload']);
    await browser(['wait', 2500]);
    const deltaFirstAfterReload = await evalBrowser(
      `(() => { const first = document.querySelector('main .rounded-lg [data-project-name]'); return first?.textContent?.trim() ?? ''; })()`,
    );
    assert(deltaFirstAfterReload === 'delta', 'manual order survives reload');

    // ============================================================
    section('B — archive / show-archived');
    // ============================================================
    await evalBrowser(
      `(() => { const rows = Array.from(document.querySelectorAll('button[title^="Manage project"]')); for (const manage of rows) { if ((manage.closest('.rounded-lg')?.textContent ?? '').includes('deep-repo')) { manage.click(); return true; } } return false; })()`,
    );
    await browser(['wait', 500]);
    await browser(['find', 'role', 'menuitem', 'click', '--name', 'Archive project']);
    await browser(['wait', 1000]);
    const deepRowExpr = `Array.from(document.querySelectorAll('main .rounded-lg')).find(r => r.textContent?.trim().startsWith('deep-repo'))`;
    const deepHidden = await evalBrowser(`Boolean((${deepRowExpr})?.textContent?.includes('deep-repo'))`);
    assert(deepHidden === false, 'archived project hidden by default');
    await browser(['click', 'button[title="More project actions"]']);
    await browser(['wait', 400]);
    await browser(['find', 'role', 'menuitem', 'click', '--name', 'Show archived']);
    await browser(['wait', 1200]);
    const deepRowShown = await evalBrowser(
      `(() => { const row = (${deepRowExpr}); return row ? (row.textContent?.includes('Archived') ? 'badge' : 'visible-no-badge') : 'hidden'; })()`,
    );
    assert(deepRowShown === 'badge', 'show-archived reveals project with Archived badge');
    await browser(['screenshot', join(shotsDir, '04-archived.png')], { allowFailure: true });
    await evalBrowser(
      `(() => { const rows = Array.from(document.querySelectorAll('button[title^="Manage project"]')); for (const manage of rows) { if ((manage.closest('.rounded-lg')?.textContent ?? '').includes('deep-repo')) { manage.click(); return true; } } return false; })()`,
    );
    await browser(['wait', 500]);
    await browser(['find', 'role', 'menuitem', 'click', '--name', 'Unarchive project']);
    await browser(['wait', 1000]);
    const unarchivedBadge = await evalBrowser(`(() => { const row = (${deepRowExpr}); return row ? row.textContent?.includes('Archived') : 'hidden'; })()`);
    assert(unarchivedBadge === false, 'unarchive removes the badge');

    // ============================================================
    section('B — create project (mkdir + git init)');
    // ============================================================
    await evalBrowser(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find(b => !b.getAttribute('title') && b.textContent?.trim().startsWith('New session')); b?.click(); return Boolean(b); })()`,
    );
    await browser(['wait', 400]);
    await browser(['find', 'role', 'button', 'click', '--name', 'Create new project']);
    await browser(['wait', 400]);
    // Two roots configured → root picker. Pick root A.
    await evalBrowser(
      `(() => { const btns = Array.from(document.querySelectorAll('[role="dialog"] button')).filter(b => b.textContent?.trim() === ${JSON.stringify(rootA)}); btns[0]?.click(); return btns.length; })()`,
    );
    await browser(['wait', 300]);
    await fillSelector('[role="dialog"] input[placeholder="Project name"]', 'epsilon');
    await browser(['wait', 200]);
    await evalBrowser(
      `(() => { const btns = Array.from(document.querySelectorAll('[role="dialog"] button')).filter(b => b.textContent?.trim() === 'Create'); btns.at(-1)?.click(); return btns.length; })()`,
    );
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
    assert(dashAfterCreate.includes('epsilon'), 'created project appears in the dashboard');
    const epsilonGit = await stat(join(epsilon, '.git')).then(
      () => true,
      () => false,
    );
    assert(epsilonGit, 'epsilon/.git exists on disk (mkdir + git init)');

    // ============================================================
    section('B — hub creation via UI dialog + repo chips');
    // ============================================================
    await browser(['click', 'button[title="More project actions"]']);
    await browser(['wait', 400]);
    await browser(['find', 'role', 'menuitem', 'click', '--name', 'Create multi-repo hub']);
    await browser(['wait', 600]);
    await fillSelector('[role="dialog"] input[placeholder="Hub name"]', 'hub-lima');
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
    await browser(['find', 'role', 'button', 'click', '--name', 'Create hub']);
    await browser(['wait', 1500]);
    const afterHub = String(await evalBrowser('document.body.innerText'));
    assert(afterHub.includes('hub-lima'), 'hub-lima appears in the dashboard after UI creation');
    const limaChips = String(
      await evalBrowser(
        `(() => { const hubRow = Array.from(document.querySelectorAll('main .rounded-lg')).find(r => r.textContent?.includes('hub-lima')); return hubRow?.textContent ?? ''; })()`,
      ),
    );
    assert(limaChips.includes('alpha') && /main/.test(limaChips), 'hub-lima chip: alpha with branch main');
    assert(limaChips.includes('delta') && /feature\/zebra/.test(limaChips), 'hub-lima chip: delta with branch feature/zebra');
    await browser(['screenshot', join(shotsDir, '06-hub-chips.png')], { allowFailure: true });

    // Dirty chip visual: hub-west contains beta (dirty).
    const westDirty = await evalBrowser(
      `(() => { const hubRow = Array.from(document.querySelectorAll('main .rounded-lg')).find(r => r.textContent?.includes('hub-west')); if (!hubRow) return 'no-row'; const chips = Array.from(hubRow.querySelectorAll('span[title]')).find(s => (s.getAttribute('title') ?? '').includes('beta')); return chips?.querySelector('span[title="Uncommitted changes"]') ? 'dirty-dot' : 'no-dirty-dot'; })()`,
    );
    assert(westDirty === 'dirty-dot', 'beta chip in hub-west shows the dirty dot');

    // ============================================================
    section('B — disband via UI confirm');
    // ============================================================
    await evalBrowser(
      `(() => { const rows = Array.from(document.querySelectorAll('button[title^="Manage project"]')); for (const manage of rows) { if ((manage.closest('.rounded-lg')?.textContent ?? '').includes('hub-lima')) { manage.click(); return true; } } return false; })()`,
    );
    await browser(['wait', 500]);
    await browser(['find', 'role', 'menuitem', 'click', '--name', 'Disband project']);
    await browser(['wait', 400]);
    await evalBrowser(
      `(() => { const btns = Array.from(document.querySelectorAll('[role="dialog"] button')).filter(b => b.textContent?.trim() === 'Disband'); btns.at(-1)?.click(); return btns.length; })()`,
    );
    await browser(['wait', 1500]);
    const afterDisband = String(await evalBrowser('document.body.innerText'));
    assert(!afterDisband.includes('hub-lima'), 'disbanded hub removed from the dashboard');
    const limaGone = await stat(hubLima).then(
      () => false,
      () => true,
    );
    assert(limaGone, 'hub-lima folder deleted from disk');
    const deltaAlive = await stat(join(rootB, 'delta', '.git')).then(
      () => true,
      () => false,
    );
    assert(deltaAlive, 'member repo delta untouched by UI disband');

    // ============================================================
    section('B — manager chat: streamed response (live LLM)');
    // ============================================================
    if (jetsonUsable) {
      const filled = await fillSelector('textarea[aria-label="Message the manager"]', 'Reply with exactly: PONG');
      assert(filled, 'manager composer accepts text');
      await browser(['find', 'role', 'button', 'click', '--name', 'Send']);
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
      let replied = false;
      for (let i = 0; i < 90; i++) {
        await wait(1000);
        const pong = await evalBrowser(`/PONG/i.test((document.querySelector('main') ?? document.body).innerText)`);
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
    section('B — manager tool use (pimote_list_projects through the ports)');
    // ============================================================
    if (jetsonUsable) {
      const listNow = await probeA.send({ type: 'list_projects' });
      const expectedCount = listNow.data.projects.length;
      await fillSelector(
        'textarea[aria-label="Message the manager"]',
        'Call the pimote_list_projects tool now. After it returns, reply with ONLY the number of projects, nothing else.',
      );
      await browser(['find', 'role', 'button', 'click', '--name', 'Send']);
      let sawToolCall = false;
      let answer = null;
      for (let i = 0; i < 90; i++) {
        await wait(1000);
        const state = await evalBrowser(
          `(() => {
            const main = document.querySelector('main') ?? document.body;
            const text = main.innerText;
            const toolCall = Boolean(main.querySelector('[class*="tool"], details, pre')) && /pimote_list_projects/i.test(text);
            return { toolCall, tail: text.slice(-400) };
          })()`,
        );
        if (state?.toolCall) sawToolCall = true;
        if (state && !state.tail.includes('Abort')) {
          const numbers = state.tail.match(/\d+/g);
          if (numbers?.length) answer = Number(numbers[numbers.length - 1]);
          if (answer !== null && (state.toolCall || i > 30)) break;
        }
      }
      soft(sawToolCall, 'manager rendered a pimote_list_projects tool call', 'model chose not to call the tool');
      soft(answer === expectedCount, `manager answered the project count (${answer} vs expected ${expectedCount})`, 'model reply unparseable or wrong');
      await browser(['screenshot', join(shotsDir, '08-manager-tool.png')], { allowFailure: true });
    }

    // ============================================================
    section('B — manager abort');
    // ============================================================
    if (jetsonUsable) {
      await fillSelector('textarea[aria-label="Message the manager"]', 'Count from 1 to 300 slowly, writing every number on its own line. Do not stop early.');
      await browser(['find', 'role', 'button', 'click', '--name', 'Send']);
      let abortClicked = false;
      for (let i = 0; i < 40; i++) {
        await wait(500);
        const working = await evalBrowser(`Boolean(document.querySelector('button[title="Abort"]'))`);
        if (working === true) {
          await browser(['find', 'role', 'button', 'click', '--name', 'Abort']);
          abortClicked = true;
          break;
        }
      }
      assert(abortClicked, 'abort flow: Abort button appeared and was clicked');
      let backToSend = false;
      for (let i = 0; i < 20; i++) {
        await wait(500);
        const send = await evalBrowser(`Boolean(document.querySelector('button[title="Send"]'))`);
        if (send === true) {
          backToSend = true;
          break;
        }
      }
      assert(backToSend, 'abort returns the manager to idle (Send visible again)');
      if (abortClicked && backToSend) {
        const countNumbers = () =>
          evalBrowser(
            `(() => { const area = Array.from(document.querySelectorAll('div')).filter(d => d.querySelector?.('textarea[aria-label="Message the manager"]')).at(-1); return ((area ?? document.body).innerText.match(/\\b\\d+\\b/g) ?? []).length; })()`,
          );
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
    const managerArea = String(
      await evalBrowser(
        `(() => { const panes = Array.from(document.querySelectorAll('div')).filter(d => d.querySelector?.('textarea[aria-label="Message the manager"]')); const pane = panes.at(-1); return pane ? pane.innerText : document.body.innerText; })()`,
      ),
    );
    assert(!managerArea.includes('PONG'), 'fresh connection starts with an empty manager transcript');

    // ============================================================
    section('B — missing member chip after disk deletion + restart');
    // ============================================================
    await probeA.send({ type: 'create_hub_project', name: 'hub-zulu', root: rootA, repoPaths: [join(rootA, 'beta')] });
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
    await browser(['reload']);
    await browser(['wait', 3500]);
    const missingChip = await evalBrowser(
      `(() => { const hubRow = Array.from(document.querySelectorAll('main .rounded-lg')).find(r => r.textContent?.includes('hub-zulu')); if (!hubRow) return 'no-row'; const chip = Array.from(hubRow.querySelectorAll('span[title]')).find(s => (s.getAttribute('title') ?? '').includes('missing')); return chip ? chip.textContent?.trim() : 'no-chip'; })()`,
    );
    assert(String(missingChip).includes('missing'), `missing member renders the warning chip (got "${missingChip}")`);
    await browser(['screenshot', join(shotsDir, '09-missing-chip.png')], { allowFailure: true });
    // Cleanup: disband hub-zulu so the registry is left tidy.
    await probeA.send({ type: 'disband_project', projectPath: hubZulu });

    probeA.close();
    probeB.close();

    // ============================================================
    section('B — mobile dashboard (manager affordance)');
    // ============================================================
    await browser(['set', 'viewport', '390', '844']);
    await browser(['reload']);
    await browser(['wait', 2500]);
    const mobileText = String(await evalBrowser('document.body.innerText'));
    assert(mobileText.includes('alpha'), 'mobile dashboard shows the projects list fullscreen');
    // Redesign: the FAB became the spotlight affordance — an md:hidden button on
    // the home column that opens the fullscreen manager sheet.
    const managerSpotlight = await evalBrowser(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Ask the manager') && getComputedStyle(b).display !== 'none'); return b ? 'spotlight' : 'none'; })()`,
    );
    assert(managerSpotlight === 'spotlight', 'mobile shows the Manager spotlight affordance');
    await evalBrowser(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Ask the manager') && getComputedStyle(b).display !== 'none'); b?.click(); return Boolean(b); })()`,
    );
    await browser(['wait', 600]);
    const sheetComposer = await evalBrowser(
      `(() => ({ count: document.querySelectorAll('textarea[aria-label="Message the manager"]').length, visible: Array.from(document.querySelectorAll('textarea[aria-label="Message the manager"]')).some(t => t.offsetParent !== null) }))()`,
    );
    assert(sheetComposer?.count >= 1 && sheetComposer?.visible === true, 'manager sheet opens fullscreen on mobile');
    await browser(['screenshot', join(shotsDir, '10-mobile-manager.png')], { allowFailure: true });

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
