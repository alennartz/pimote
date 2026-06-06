#!/usr/bin/env node
// Smoke for the at-file-syntax-web topic: TUI-style `@`-file-path autocomplete
// in the web InputBar.
//
// Two layers, both against a real pimote booted on a sandboxed HOME with a
// fabricated on-disk pi session whose cwd is a known project tree:
//
//   Phase A — `complete_file_refs` over the WebSocket (robust, deterministic):
//     - `@`              lists the cwd tree (files terminal, dirs trailing `/`)
//     - `@to`            bare single-segment query fuzzy-matches from cwd
//     - `@src/`          last-slash scoping → base dir src, `@src/<entry>`
//     - `@src/ind`       scoped query → `@src/index.ts`
//     - `@"my d`         quoted token with a space → `@"my dir/"`
//     - `@"my dir/`      quoted-directory drill-in → `@"my dir/note.txt"`
//                        (review finding #2 regression guard)
//
//   Phase A2 — fd-missing degradation: a second pimote booted with `fd`/`fdfind`
//     stripped from PATH. `complete_file_refs` returns `items: []` and emits
//     exactly one `extension_ui_request` notify warning over the WS.
//
//   Phase B — InputBar interaction via agent-browser (real Chromium):
//     - typing `@` opens the dropdown with fd-backed suggestions
//     - selecting a file inserts `@path` and closes the menu
//     - selecting a directory inserts `@path/` and keeps the menu open
//     - `@` triggers mid-line (not only at line start)
//     - `/` slash completion stays mutually exclusive with `@`
//     - the composed `@path` token appears verbatim in the optimistic message
//
// No live LLM, speechmux, or network required. fd must be present for Phase A/B
// (Phase A2 deliberately hides it). Tracks and kills only the child PID it
// spawns. See README.md alongside this file and
// docs/manual-tests/at-file-syntax-web.md.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

const REPO_ROOT = pathResolve(new URL('../../../', import.meta.url).pathname);
const PIMOTE_BIN = join(REPO_ROOT, 'bin', 'pimote.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}
function section(name) {
  console.log(`\n[at-smoke] ${name}`);
}
function log(...args) {
  console.log('[at-smoke]', ...args);
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function waitForListening(child, port, logPath) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`pimote exited early with code ${child.exitCode}; see ${logPath}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (res.status < 500) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`pimote did not start listening on :${port} within 30s; see ${logPath}`);
}

function startPimote({ port, sandboxHome, logPath, pathOverride }) {
  const env = {
    ...process.env,
    HOME: sandboxHome,
    XDG_CONFIG_HOME: join(sandboxHome, '.config'),
    XDG_STATE_HOME: join(sandboxHome, '.local', 'state'),
    XDG_DATA_HOME: join(sandboxHome, '.local', 'share'),
    XDG_CACHE_HOME: join(sandboxHome, '.cache'),
    PIMOTE_PORT: String(port),
    NODE_ENV: 'production',
  };
  if (pathOverride !== undefined) env.PATH = pathOverride;
  const child = spawn(process.execPath, [PIMOTE_BIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tee = async (chunk) => {
    await appendFile(logPath, chunk).catch(() => {});
  };
  child.stdout.on('data', tee);
  child.stderr.on('data', tee);
  return child;
}

async function stopPimote(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 5_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function abCmd(args, { allowFailure = false, retries = 2, timeoutMs = 25_000 } = {}) {
  log('ab:', args.join(' '));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const child = spawn('agent-browser', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    await once(child, 'exit');
    clearTimeout(killer);
    const transient = /Resource temporarily unavailable|daemon may be busy/i.test(stdout + stderr);
    if ((child.exitCode === 0 && !timedOut) || allowFailure || (!transient && !timedOut) || attempt === retries) {
      if ((child.exitCode !== 0 || timedOut) && !allowFailure) {
        console.error(`[at-smoke] agent-browser ${args.join(' ')} -> exit ${child.exitCode}${timedOut ? ' (timed out)' : ''}`);
        if (stderr) console.error(stderr);
        throw new Error(`agent-browser failed: ${args.join(' ')}`);
      }
      return { stdout, stderr, code: child.exitCode };
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error('unreachable');
}

// Set the textarea value with a real input event + cursor at end so the Svelte
// `@`/`/` autocomplete trigger fires exactly as it would for live typing.
// agent-browser's `eval` runs in page context; we locate the (single) chat
// textarea, set value via the native setter, dispatch InputEvent, and place the
// caret at the end. Returns the resulting value for confirmation.
async function setInput(text) {
  const js = `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'NO_TEXTAREA';
    const proto = Object.getPrototypeOf(ta);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    ta.focus();
    setter.call(ta, ${JSON.stringify(text)});
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return ta.value;
  })()`;
  const raw = (await abCmd(['eval', js])).stdout.trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, '');
  }
}

// Read the current autocomplete dropdown item labels (the bold span text on each
// row). Empty array when the dropdown is not shown.
async function dropdownItems() {
  const js = `(() => {
    const pop = document.querySelector('.bg-popover');
    if (!pop) return JSON.stringify([]);
    return JSON.stringify(Array.from(pop.querySelectorAll('button span.font-medium')).map(s => s.textContent.trim()));
  })()`;
  const out = (await abCmd(['eval', js])).stdout.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"');
  try {
    return JSON.parse(out);
  } catch {
    return [];
  }
}

// Click the dropdown row whose bold label exactly equals `label`. Returns false
// when no such row is present.
async function clickDropdownItem(label) {
  const js = `(() => {
    const pop = document.querySelector('.bg-popover');
    if (!pop) return 'NO_POPUP';
    const btns = Array.from(pop.querySelectorAll('button'));
    const target = btns.find(b => {
      const s = b.querySelector('span.font-medium');
      return s && s.textContent.trim() === ${JSON.stringify(label)};
    });
    if (!target) return 'NO_ITEM';
    target.click();
    return 'CLICKED';
  })()`;
  const out = (await abCmd(['eval', js])).stdout.trim().replace(/^"|"$/g, '');
  return out === 'CLICKED';
}

async function inputValue() {
  const js = `(() => { const ta = document.querySelector('textarea'); return ta ? ta.value : 'NO_TEXTAREA'; })()`;
  const raw = (await abCmd(['eval', js])).stdout.trim();
  // agent-browser eval returns the value JSON-encoded; decode so embedded
  // double-quotes (from `@"…"` tokens) survive the round-trip intact.
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, '');
  }
}

// ---- pi session fabrication ----------------------------------------------

function fabricateSession({ cwd }) {
  const sessionId = randomUUID();
  const isoNow = new Date().toISOString();
  const lines = [];
  lines.push({ type: 'session', version: 3, id: sessionId, timestamp: isoNow, cwd });
  // A single user/assistant exchange so the session has visible history and the
  // InputBar renders in its normal (idle, ready-to-prompt) state.
  const uid = randomUUID().slice(0, 8);
  lines.push({
    type: 'message',
    id: uid,
    parentId: null,
    timestamp: isoNow,
    message: { role: 'user', content: [{ type: 'text', text: 'hello there' }], timestamp: Date.now() },
  });
  const aid = randomUUID().slice(0, 8);
  lines.push({
    type: 'message',
    id: aid,
    parentId: uid,
    timestamp: isoNow,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      api: 'openai-responses',
      provider: 'fabricated',
      model: 'gpt-5.3-codex',
      stopReason: 'stop',
      timestamp: Date.now(),
      responseId: `resp_${aid}`,
    },
  });
  return { lines, sessionId };
}

async function seedSession({ sandboxHome, projectDir, lines, sessionId }) {
  const piSessionsDir = join(sandboxHome, '.pi', 'agent', 'sessions');
  const encodedCwd = `--${projectDir.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const sessionDir = join(piSessionsDir, encodedCwd);
  await mkdir(sessionDir, { recursive: true });
  const isoNow = new Date().toISOString();
  const filenameStamp = isoNow.replace(/:/g, '-');
  const sessionPath = join(sessionDir, `${filenameStamp}_${sessionId}.jsonl`);
  await writeFile(sessionPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return sessionPath;
}

async function buildProjectTree(projectDir) {
  await mkdir(join(projectDir, 'src'), { recursive: true });
  await mkdir(join(projectDir, 'docs'), { recursive: true });
  await mkdir(join(projectDir, 'my dir'), { recursive: true });
  await mkdir(join(projectDir, '.git'), { recursive: true });
  await writeFile(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(projectDir, 'src', 'index.ts'), 'export const x = 1;\n');
  await writeFile(join(projectDir, 'src', 'util.ts'), 'export const y = 2;\n');
  await writeFile(join(projectDir, 'docs', 'readme.md'), '# readme\n');
  await writeFile(join(projectDir, 'my dir', 'note.txt'), 'note\n');
  await writeFile(join(projectDir, 'top.txt'), 'top\n');
}

// ---- WS helpers -----------------------------------------------------------

function openWs(port, version, clientId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=${encodeURIComponent(clientId)}&version=${encodeURIComponent(version)}`);
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', (ev) => reject(ev.error ?? new Error('ws error')), { once: true });
  });
}

function rpc(ws, id, payload, { collectEvents } = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error(`rpc ${payload.type} (${id}) timed out`));
    }, 15_000);
    const events = [];
    const onMsg = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (collectEvents && msg.type) events.push(msg);
      if (msg.id === id && typeof msg.success === 'boolean') {
        clearTimeout(timeout);
        ws.removeEventListener('message', onMsg);
        resolve({ response: msg, events });
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

async function openSession(ws, folderPath, sessionId) {
  const { response } = await rpc(ws, 'open-1', { type: 'open_session', folderPath, sessionId });
  if (!response.success) throw new Error(`open_session failed: ${response.error ?? 'unknown'}`);
  return response.data?.sessionId ?? sessionId;
}

async function completeFileRefs(ws, sessionId, prefix, opts) {
  const { response, events } = await rpc(ws, `cfr-${randomUUID().slice(0, 6)}`, { type: 'complete_file_refs', sessionId, prefix }, opts);
  if (!response.success) throw new Error(`complete_file_refs failed: ${response.error}`);
  return { items: response.data?.items ?? [], events };
}

function values(items) {
  return items.map((i) => i.value);
}

async function main() {
  console.log('[at-smoke] at-file-syntax-web smoke');

  const sandboxHome = await mkdtemp(join(tmpdir(), 'at-file-syntax-smoke-'));
  const xdgConfig = join(sandboxHome, '.config');
  const xdgState = join(sandboxHome, '.local', 'state');
  await mkdir(join(xdgConfig, 'pimote'), { recursive: true });
  await mkdir(xdgState, { recursive: true });

  const projectsRoot = join(sandboxHome, 'projects');
  const projectDir = join(projectsRoot, 'demo-project');
  await buildProjectTree(projectDir);

  const port = await getFreePort();
  const configPath = join(xdgConfig, 'pimote', 'config.json');
  await writeFile(configPath, JSON.stringify({ roots: [projectsRoot], port, bufferSize: 100 }, null, 2));

  const logPath = join(sandboxHome, 'pimote.log');
  log('sandbox HOME =', sandboxHome);
  log('port         =', port);

  const version = JSON.parse(await readFile(join(REPO_ROOT, 'client', 'build', '_app', 'version.json'), 'utf-8')).version;
  const baseUrl = `http://127.0.0.1:${port}`;

  let child;
  let fdMissingChild;
  try {
    section('Fabricate + seed pi session on disk');
    const fab = fabricateSession({ cwd: projectDir });
    const sessPath = await seedSession({ sandboxHome, projectDir, ...fab });
    assert(true, `seeded session ${sessPath}`);

    section('Boot pimote (fd present)');
    child = startPimote({ port, sandboxHome, logPath });
    await waitForListening(child, port, logPath);
    log('pimote listening');

    // =================================================================
    section('Phase A — complete_file_refs over WebSocket');
    // =================================================================
    const ws = await openWs(port, version, 'at-smoke');
    const sid = await openSession(ws, projectDir, fab.sessionId);
    log('opened session', sid);

    // `@` → lists the cwd tree; dirs trailing `/`, files terminal.
    {
      const { items } = await completeFileRefs(ws, sid, '@');
      const v = values(items);
      assert(v.includes('@src/'), `@ → directory token "@src/" present (got ${JSON.stringify(v)})`);
      assert(v.includes('@top.txt'), '@ → file token "@top.txt" present (terminal, no trailing slash)');
      assert(v.includes('@my dir/') || v.includes('@"my dir/"'), '@ → spaced dir surfaced (quoted because of the space)');
      const dirItems = v.filter((x) => x.replace(/"$/, '').endsWith('/'));
      assert(dirItems.length > 0, '@ → at least one directory item carries a trailing /');
    }

    // bare single-segment query fuzzy-matches from cwd.
    {
      const { items } = await completeFileRefs(ws, sid, '@to');
      const v = values(items);
      assert(v.includes('@top.txt'), `@to → "@top.txt" (bare single-segment query) (got ${JSON.stringify(v)})`);
    }

    // last-slash scoping: @src/ lists src contents reconstructed as @src/<entry>.
    {
      const { items } = await completeFileRefs(ws, sid, '@src/');
      const v = values(items);
      assert(v.includes('@src/index.ts') && v.includes('@src/util.ts'), `@src/ → @src/index.ts + @src/util.ts (got ${JSON.stringify(v)})`);
      assert(
        items.every((i) => i.label === 'index.ts' || i.label === 'util.ts'),
        '@src/ → labels are scope-relative (index.ts / util.ts), values carry the typed scope',
      );
    }

    // scoped query: @src/ind → @src/index.ts only.
    {
      const { items } = await completeFileRefs(ws, sid, '@src/ind');
      const v = values(items);
      assert(v.includes('@src/index.ts') && !v.includes('@src/util.ts'), `@src/ind → @src/index.ts only (got ${JSON.stringify(v)})`);
    }

    // quoted token with a space → quoted value.
    {
      const { items } = await completeFileRefs(ws, sid, '@"my d');
      const v = values(items);
      assert(v.includes('@"my dir/"'), `@"my d → quoted dir "@"my dir/"" (got ${JSON.stringify(v)})`);
    }

    // quoted-directory drill-in → children quoted (review finding #2 guard).
    {
      const { items } = await completeFileRefs(ws, sid, '@"my dir/');
      const v = values(items);
      assert(v.includes('@"my dir/note.txt"'), `@"my dir/ → "@"my dir/note.txt"" (quoted drill-in) (got ${JSON.stringify(v)})`);
    }

    ws.close();

    // =================================================================
    section('Phase A2 — fd missing → empty items + one-time warning');
    // =================================================================
    // Boot a second pimote whose PATH excludes fd / fdfind. Use a free port and
    // a fresh sandbox-state dir but the same fabricated session tree.
    const fdMissingPort = await getFreePort();
    const sanitizedPath = (process.env.PATH ?? '')
      .split(':')
      .filter((dir) => dir && dir !== '/home/alenna/.pi/agent/bin' && dir !== '/usr/bin' && dir !== '/bin')
      .join(':');
    // Build an isolated bin dir holding only the node toolchain symlinks we need
    // (node is invoked by absolute path, so an empty PATH would still boot, but
    // keep a minimal PATH so any incidental shell-outs other than fd survive).
    const fdMissingConfig = join(xdgConfig, 'pimote');
    const fdMissingLog = join(sandboxHome, 'pimote-nofd.log');
    // Verify fd is genuinely unreachable on the override PATH before asserting.
    const fdReachable = await new Promise((resolve) => {
      const probe = spawn('sh', ['-c', 'command -v fd || command -v fdfind'], {
        env: { ...process.env, PATH: sanitizedPath },
        stdio: 'ignore',
      });
      probe.on('exit', (code) => resolve(code === 0));
      probe.on('error', () => resolve(false));
    });
    if (fdReachable) {
      log('WARN: fd still reachable on sanitized PATH; fd-missing assertions skipped');
      assert(true, 'fd-missing path could not be isolated in this environment (skipped) — see note');
    } else {
      // Reuse the same config (roots/port get overridden by PIMOTE_PORT).
      await writeFile(join(fdMissingConfig, 'config.json'), JSON.stringify({ roots: [projectsRoot], port: fdMissingPort, bufferSize: 100 }, null, 2));
      fdMissingChild = startPimote({ port: fdMissingPort, sandboxHome, logPath: fdMissingLog, pathOverride: sanitizedPath });
      await waitForListening(fdMissingChild, fdMissingPort, fdMissingLog);
      const ws2 = await openWs(fdMissingPort, version, 'at-smoke-nofd');
      const sid2 = await openSession(ws2, projectDir, fab.sessionId);
      const first = await completeFileRefs(ws2, sid2, '@src', { collectEvents: true });
      assert(first.items.length === 0, `fd missing → complete_file_refs returns no items (got ${first.items.length})`);
      const notifyEvents = first.events.filter((e) => e.type === 'extension_ui_request' && e.method === 'notify');
      assert(notifyEvents.length === 1, `fd missing → exactly one notify warning emitted (got ${notifyEvents.length})`);
      assert(
        notifyEvents[0]?.notifyType === 'warning' && /fd not found/i.test(notifyEvents[0]?.message ?? ''),
        'fd missing → warning message names fd and is typed "warning"',
      );
      // Second request must NOT re-emit the warning (per-connection one-shot).
      const second = await completeFileRefs(ws2, sid2, '@docs', { collectEvents: true });
      const secondNotify = second.events.filter((e) => e.type === 'extension_ui_request' && e.method === 'notify');
      assert(secondNotify.length === 0, 'fd missing → warning is one-time (second request emits no further notify)');
      ws2.close();
      await stopPimote(fdMissingChild);
      fdMissingChild = undefined;
    }

    // =================================================================
    section('Phase B — InputBar interaction via agent-browser');
    // =================================================================
    await abCmd(['close'], { allowFailure: true });
    await abCmd(['open', `${baseUrl}/`]);
    await abCmd(['wait', '3000']);
    // Open the seeded session (firstMessage "hello there").
    await abCmd(['find', 'role', 'button', 'click', '--name', 'hello there'], { allowFailure: true });
    await abCmd(['wait', '2500']);
    // Confirm the chat textarea is present.
    const haveTextarea = (await abCmd(['eval', `!!document.querySelector('textarea')`])).stdout.includes('true');
    assert(haveTextarea, 'session view renders the chat textarea (InputBar)');

    // 1) Typing `@` opens the dropdown with fd-backed suggestions.
    await setInput('@');
    await abCmd(['wait', '600']); // debounce (200ms) + fetch
    let items = await dropdownItems();
    assert(items.length > 0, `typing "@" opens the fd-backed dropdown (got ${items.length} items: ${JSON.stringify(items).slice(0, 200)})`);
    assert(items.includes('top.txt'), '"@" dropdown lists "top.txt" among suggestions');

    // 2) Selecting a file inserts `@path` and closes the menu.
    if (await clickDropdownItem('top.txt')) {
      await abCmd(['wait', '400']);
      const val = await inputValue();
      assert(val === '@top.txt', `selecting file inserts "@top.txt" (got ${JSON.stringify(val)})`);
      const after = await dropdownItems();
      assert(after.length === 0, 'selecting a file closes the dropdown');
    } else {
      assert(false, 'could not click "top.txt" dropdown row');
    }

    // 3) Selecting a directory inserts `@path/` and keeps the menu open to drill in.
    await setInput('@s');
    await abCmd(['wait', '600']);
    const sItems = await dropdownItems();
    assert(sItems.includes('src/'), `"@s" dropdown offers the directory "src/" (got ${JSON.stringify(sItems)})`);
    if (await clickDropdownItem('src/')) {
      await abCmd(['wait', '700']); // drill-in re-fetch
      const val = await inputValue();
      assert(val === '@src/', `selecting directory inserts "@src/" (got ${JSON.stringify(val)})`);
      const drill = await dropdownItems();
      assert(drill.length > 0 && (drill.includes('index.ts') || drill.includes('util.ts')), `directory selection keeps the menu open and drills in (got ${JSON.stringify(drill)})`);
      // Drill one more level into a file → terminal token, menu closes.
      if (await clickDropdownItem('index.ts')) {
        await abCmd(['wait', '400']);
        const v2 = await inputValue();
        assert(v2 === '@src/index.ts', `drill-in file selection yields "@src/index.ts" (got ${JSON.stringify(v2)})`);
      } else {
        assert(false, 'could not click drilled-in "index.ts" row');
      }
    } else {
      assert(false, 'could not click "src/" dropdown row');
    }

    // 3b) Quoted-directory drill-in (review finding #2 guard, UI level): a
    //     directory reached through a spaced/quoted scope inserts the quoted
    //     token AND keeps the menu open to drill in. The closing quote sits
    //     after the trailing slash (`@"my dir/"`), so naive `endsWith('/')`
    //     detection would (and did) wrongly close the menu.
    await setInput('@my');
    await abCmd(['wait', '600']);
    const myItems = await dropdownItems();
    assert(myItems.includes('my dir/'), `"@my" dropdown offers the spaced directory "my dir/" (got ${JSON.stringify(myItems)})`);
    if (await clickDropdownItem('my dir/')) {
      await abCmd(['wait', '700']);
      const val = await inputValue();
      assert(val === '@"my dir/', `selecting spaced dir inserts the open quoted token '@"my dir/' (got ${JSON.stringify(val)})`);
      const drill = await dropdownItems();
      assert(drill.includes('note.txt'), `quoted-directory selection keeps the menu open and drills into "my dir/" (got ${JSON.stringify(drill)})`);
      if (await clickDropdownItem('note.txt')) {
        await abCmd(['wait', '400']);
        const v2 = await inputValue();
        assert(v2 === '@"my dir/note.txt"', `quoted drill-in file selection yields '@"my dir/note.txt"' (got ${JSON.stringify(v2)})`);
      } else {
        assert(false, 'could not click quoted drilled-in "note.txt" row');
      }
    } else {
      assert(false, 'could not click "my dir/" dropdown row');
    }

    // 4) `@` triggers mid-line (not only at line start).
    await setInput('please read @to');
    await abCmd(['wait', '600']);
    const midItems = await dropdownItems();
    assert(midItems.includes('top.txt'), `mid-line "@to" triggers completion (got ${JSON.stringify(midItems)})`);

    // 5) `/` slash completion stays mutually exclusive with `@`.
    await setInput('/');
    await abCmd(['wait', '500']);
    const slashItems = await dropdownItems();
    // Slash dropdown should contain slash commands (e.g. /new, /reload, /tree),
    // and must NOT contain file entries like top.txt / src/.
    const slashHasFiles = slashItems.some((x) => x === 'top.txt' || x === 'src/' || x === 'index.ts');
    assert(slashItems.length > 0, `"/" opens the slash-command dropdown (got ${JSON.stringify(slashItems).slice(0, 200)})`);
    assert(!slashHasFiles, '"/" dropdown shows slash commands, not file refs (mutually exclusive)');

    // 6) Composed `@path` token appears verbatim in the optimistic user message.
    await setInput('check @top.txt now');
    await abCmd(['wait', '300']);
    // Send via the visible Send button.
    const sent = await abCmd(
      ['eval', `(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const send = btns.find(b => /send/i.test(b.getAttribute('title')||'') || /send/i.test(b.textContent||''));
        if (!send) return 'NO_SEND';
        send.click();
        return 'SENT';
      })()`],
      { allowFailure: true },
    );
    await abCmd(['wait', '1500']);
    if (sent.stdout.includes('SENT')) {
      const echoed = (
        await abCmd(['eval', `(() => document.body.innerText.includes('check @top.txt now') ? 'YES' : 'NO')()`], { allowFailure: true })
      ).stdout;
      assert(echoed.includes('YES'), 'optimistic user message shows the literal "@top.txt" token unchanged (no expansion)');
    } else {
      assert(false, 'could not locate the Send button to dispatch the prompt');
    }

    const shotPath = process.env.AT_SHOT ? pathResolve(process.env.AT_SHOT) : join(sandboxHome, 'at-file-syntax.png');
    await abCmd(['screenshot', shotPath], { allowFailure: true });
    await abCmd(['close'], { allowFailure: true });
  } catch (err) {
    console.error('[at-smoke] FAILED:', err);
    failures++;
    try {
      await abCmd(['close'], { allowFailure: true });
    } catch {}
  } finally {
    await stopPimote(fdMissingChild).catch(() => {});
    await stopPimote(child).catch(() => {});
    log('pimote log path:', logPath);
    if (failures === 0) {
      await rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
    } else {
      log(`sandbox preserved for inspection: ${sandboxHome}`);
    }
  }

  console.log(`\n[at-smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[at-smoke] uncaught', err);
  process.exit(1);
});
