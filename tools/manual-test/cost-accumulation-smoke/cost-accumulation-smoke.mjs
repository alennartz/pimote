#!/usr/bin/env node
// PWA-side smoke for the cost-accumulation topic.
//
// Verifies the per-session lifetime dollar cost surfaced in the StatusBar:
//   - A session whose on-disk branch carries priced assistant entries shows
//     the formatSessionCost-formatted figure ($X.XX) in the StatusBar.
//   - get_session_meta succeeds (does not throw) and reports a numeric
//     lifetimeCostUsd equal to the sum over *assistant* entries only
//     (user / toolResult / model_change entries do not contribute).
//   - A zero-spend session hides the indicator entirely.
//
// No live LLM is needed: we fabricate a pi session JSONL whose assistant
// entries carry real-format `usage.cost.total` values, which pi's
// SessionManager rehydrates into the in-memory branch on open — the exact
// path the plan relies on for restart survival. See README.md alongside this
// file and docs/manual-tests/cost-accumulation.md.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
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
  console.log(`\n[cost-smoke] ${name}`);
}
function log(...args) {
  console.log('[cost-smoke]', ...args);
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

function startPimote({ port, sandboxHome, logPath }) {
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

async function abCmd(args, { allowFailure = false, retries = 2, timeoutMs = 20_000 } = {}) {
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
        console.error(`[cost-smoke] agent-browser ${args.join(' ')} -> exit ${child.exitCode}${timedOut ? ' (timed out)' : ''}`);
        if (stderr) console.error(stderr);
        throw new Error(`agent-browser failed: ${args.join(' ')}`);
      }
      return { stdout, stderr, code: child.exitCode };
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error('unreachable');
}

// ---- pi session fabrication ----------------------------------------------

// Build a linear pi session JSONL chain. `assistantCosts` is the list of
// `usage.cost.total` values applied to the assistant turns; non-assistant
// entries (user / toolResult / model_change) are interleaved to exercise the
// server-side filtering in sumAssistantCostUsd. Returns { lines, sessionId }.
function fabricateSession({ cwd, assistantCosts, promptLabel = 'prompt' }) {
  const sessionId = randomUUID();
  const isoNow = new Date().toISOString();
  const lines = [];
  let prevId = null;
  const nextId = () => randomUUID().slice(0, 8);

  // Root session record (no parentId).
  lines.push({ type: 'session', version: 3, id: sessionId, timestamp: isoNow, cwd });

  // A model_change entry — non-message, must not contribute.
  const mc = nextId();
  lines.push({ type: 'model_change', id: mc, parentId: prevId, timestamp: isoNow, model: 'gpt-5.3-codex' });
  prevId = mc;

  for (let i = 0; i < assistantCosts.length; i++) {
    // User turn (role user — must not contribute).
    const uid = nextId();
    lines.push({
      type: 'message',
      id: uid,
      parentId: prevId,
      timestamp: isoNow,
      message: { role: 'user', content: [{ type: 'text', text: `${promptLabel} ${i + 1}` }], timestamp: Date.now() },
    });
    prevId = uid;

    // Assistant turn carrying usage.cost.total (the only contributor).
    const cost = assistantCosts[i];
    const aid = nextId();
    lines.push({
      type: 'message',
      id: aid,
      parentId: prevId,
      timestamp: isoNow,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `response ${i + 1}` }],
        api: 'openai-responses',
        provider: 'fabricated',
        model: 'gpt-5.3-codex',
        usage: {
          input: 1000,
          output: 500,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1500,
          cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
        responseId: `resp_${aid}`,
      },
    });
    prevId = aid;

    // A toolResult-style user message (role user — must not contribute).
    const tid = nextId();
    lines.push({
      type: 'message',
      id: tid,
      parentId: prevId,
      timestamp: isoNow,
      message: { role: 'user', content: [{ type: 'toolResult', toolCallId: `tc_${i}`, output: 'ok' }], timestamp: Date.now() },
    });
    prevId = tid;
  }

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

function formatSessionCost(usd) {
  // Mirror client/src/lib/session-summary.ts formatSessionCost for assertions.
  if (usd <= 0) return null;
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(2);
}

async function main() {
  console.log('[cost-smoke] cost-accumulation PWA-side smoke');

  const sandboxHome = await mkdtemp(join(tmpdir(), 'cost-accumulation-smoke-'));
  const xdgConfig = join(sandboxHome, '.config');
  const xdgState = join(sandboxHome, '.local', 'state');
  await mkdir(join(xdgConfig, 'pimote'), { recursive: true });
  await mkdir(xdgState, { recursive: true });

  const projectsRoot = join(sandboxHome, 'projects');
  const pricedProject = join(projectsRoot, 'priced-project');
  const freshProject = join(projectsRoot, 'fresh-project');
  for (const dir of [pricedProject, freshProject]) {
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  }

  const port = await getFreePort();
  const configPath = join(xdgConfig, 'pimote', 'config.json');
  await writeFile(configPath, JSON.stringify({ roots: [projectsRoot], port, bufferSize: 100 }, null, 2));

  const logPath = join(sandboxHome, 'pimote.log');
  log('sandbox HOME =', sandboxHome);
  log('port         =', port);

  // Priced session: assistant costs 0.50 + 0.73 = 1.23 → "$1.23".
  const pricedCosts = [0.5, 0.73];
  const expectedSum = pricedCosts.reduce((a, b) => a + b, 0);
  const expectedDisplay = formatSessionCost(expectedSum); // "$1.23"

  // Zero session: assistant turns all cost 0 → lifetimeCostUsd 0 → hidden.
  const zeroCosts = [0, 0];

  let child;
  try {
    section('Fabricate pi session JSONLs on disk');
    const priced = fabricateSession({ cwd: pricedProject, assistantCosts: pricedCosts, promptLabel: 'priced prompt' });
    const pricedPath = await seedSession({ sandboxHome, projectDir: pricedProject, ...priced });
    assert(true, `seeded priced session (Σ=${expectedSum} → ${expectedDisplay}) ${pricedPath}`);

    const zero = fabricateSession({ cwd: freshProject, assistantCosts: zeroCosts, promptLabel: 'fresh prompt' });
    const zeroPath = await seedSession({ sandboxHome, projectDir: freshProject, ...zero });
    assert(true, `seeded zero-spend session ${zeroPath}`);

    section('Boot pimote');
    child = startPimote({ port, sandboxHome, logPath });
    await waitForListening(child, port, logPath);
    log('pimote listening');

    const baseUrl = `http://127.0.0.1:${port}`;
    const version = JSON.parse(await (await import('node:fs/promises')).readFile(join(REPO_ROOT, 'client', 'build', '_app', 'version.json'), 'utf-8')).version;

    // -----------------------------------------------------------------
    section('get_session_meta over WS: priced + zero sessions');
    // -----------------------------------------------------------------
    const metaFor = async (sessionId, folderPath) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=cost-smoke&version=${encodeURIComponent(version)}`);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', (ev) => reject(ev.error ?? new Error('ws error')), { once: true });
      });
      try {
        // Open the existing session from disk so it lands in the SessionManager.
        // Reopening by id replies on the command response (id 'open-1'), not
        // necessarily a session_opened event.
        const opened = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('open_session timed out')), 15_000);
          const onMsg = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              // Command responses carry no `type` field, just `id`/`success`.
              if (msg.id === 'open-1' && typeof msg.success === 'boolean') {
                clearTimeout(timeout);
                ws.removeEventListener('message', onMsg);
                if (!msg.success) reject(new Error(`open_session failed: ${msg.error ?? 'unknown'}`));
                // Reopening from disk assigns a fresh in-memory sessionId.
                else resolve(msg.data?.sessionId ?? sessionId);
              }
            } catch {
              /* ignore */
            }
          };
          ws.addEventListener('message', onMsg);
          ws.send(JSON.stringify({ id: 'open-1', type: 'open_session', folderPath, sessionId }));
        });
        // Now fetch meta.
        const meta = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('get_session_meta timed out')), 10_000);
          const onMsg = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.id === 'meta-1' && typeof msg.success === 'boolean') {
                clearTimeout(timeout);
                ws.removeEventListener('message', onMsg);
                if (!msg.success) reject(new Error(`get_session_meta failed: ${msg.error}`));
                else resolve(msg.data.meta);
              }
            } catch {
              /* ignore */
            }
          };
          ws.addEventListener('message', onMsg);
          ws.send(JSON.stringify({ id: 'meta-1', type: 'get_session_meta', sessionId: opened }));
        });
        return meta;
      } finally {
        ws.close();
      }
    };

    const pricedMeta = await metaFor(priced.sessionId, pricedProject);
    assert(pricedMeta && typeof pricedMeta.lifetimeCostUsd === 'number', `priced get_session_meta returns numeric lifetimeCostUsd (got ${JSON.stringify(pricedMeta?.lifetimeCostUsd)})`);
    assert(Math.abs((pricedMeta?.lifetimeCostUsd ?? 0) - expectedSum) < 1e-9, `priced lifetimeCostUsd === Σ assistant costs (${expectedSum}); user/toolResult/model_change excluded (got ${pricedMeta?.lifetimeCostUsd})`);

    const zeroMeta = await metaFor(zero.sessionId, freshProject);
    assert(zeroMeta && typeof zeroMeta.lifetimeCostUsd === 'number', `zero get_session_meta returns numeric lifetimeCostUsd (got ${JSON.stringify(zeroMeta?.lifetimeCostUsd)})`);
    assert((zeroMeta?.lifetimeCostUsd ?? -1) === 0, `zero-spend session lifetimeCostUsd === 0 (got ${zeroMeta?.lifetimeCostUsd})`);

    // -----------------------------------------------------------------
    section('Drive the PWA via agent-browser — priced session shows $X.XX');
    // -----------------------------------------------------------------
    await abCmd(['close'], { allowFailure: true });
    await abCmd(['open', `${baseUrl}/`]);
    await abCmd(['wait', '3000']);

    // Open the priced session (response N + has messages). Click by a stable
    // substring of its row. Sessions show "N msgs"; priced has 6 message
    // entries (2 assistant + 2 user prompts + 2 toolResults). Use the
    // firstMessage "prompt 1" if surfaced, else fall back to msgs count.
    const idxSnap = (await abCmd(['snapshot', '-i'])).stdout;
    log('index snapshot excerpt:\n' + idxSnap.slice(0, 1500));

    // Open priced-project session via its row. firstMessage is "priced prompt 1".
    await abCmd(['find', 'role', 'button', 'click', '--name', 'priced prompt 1']);
    await abCmd(['wait', '3000']);

    // The cost figure is a non-interactive <span title="Session cost">, so
    // read it from the DOM rather than the interactive accessibility snapshot.
    const pricedCostText = (
      await abCmd(['eval', `Array.from(document.querySelectorAll('[title="Session cost"]')).map(e => e.textContent.trim()).join('|')`], { allowFailure: true })
    ).stdout.trim().replace(/^"|"$/g, '');
    const showsPricedFigure = pricedCostText.split('|').includes(expectedDisplay);
    assert(showsPricedFigure, `StatusBar [title="Session cost"] shows ${expectedDisplay} for the priced session (got ${JSON.stringify(pricedCostText)})`);
    if (!showsPricedFigure) {
      const pricedStatusSnap = (await abCmd(['snapshot', '-i'])).stdout;
      log('priced session snapshot excerpt:\n' + pricedStatusSnap.slice(0, 4000));
    }
    // Coherence screenshot for the priced session StatusBar.
    await abCmd(['screenshot', join(sandboxHome, 'priced-statusbar.png')], { allowFailure: true });

    // -----------------------------------------------------------------
    section('Zero-spend session hides the cost indicator');
    // -----------------------------------------------------------------
    // Return to the folder list and open the fresh/zero session.
    await abCmd(['open', `${baseUrl}/`]);
    await abCmd(['wait', '3000']);
    await abCmd(['find', 'role', 'button', 'click', '--name', 'fresh prompt 1']);
    await abCmd(['wait', '3000']);
    // Assert on the title="Session cost" span: it must be absent for the zero
    // session (formatSessionCost(0) === null hides the indicator).
    const costSpanCount = Number(
      (await abCmd(['eval', `document.querySelectorAll('[title="Session cost"]').length`], { allowFailure: true })).stdout.trim() || 'NaN',
    );
    assert(costSpanCount === 0, `zero-spend session renders no [title="Session cost"] span (got ${costSpanCount})`);
    await abCmd(['screenshot', join(sandboxHome, 'zero-statusbar.png')], { allowFailure: true });

    await abCmd(['close'], { allowFailure: true });
  } catch (err) {
    console.error('[cost-smoke] FAILED:', err);
    failures++;
    try {
      await abCmd(['close'], { allowFailure: true });
    } catch {}
  } finally {
    await stopPimote(child).catch(() => {});
    log('pimote log path:', logPath);
    if (failures === 0) {
      await rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
    } else {
      log(`sandbox preserved for inspection: ${sandboxHome}`);
    }
  }

  console.log(`\n[cost-smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[cost-smoke] uncaught', err);
  process.exit(1);
});
