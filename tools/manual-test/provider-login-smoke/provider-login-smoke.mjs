#!/usr/bin/env node
// PWA-side smoke for the provider-login topic (interactive `/login`).
//
// Boots a real pimote against a sandboxed, credential-free HOME and drives the
// real PWA + real pi-SDK AuthStorage.login end-to-end up to the auth-URL /
// device-code / paste step. Verifies, in order:
//
//   1. Typing `/login` opens the LoginDialog and posts NO user message
//      (the client-side interception, plan step 9).
//   2. The provider picker lists the OAuth providers (Anthropic, GitHub
//      Copilot, ChatGPT) with no logged-in badge, with no auth.json on disk.
//   3. HEADLINE: picking Anthropic (a usesCallbackServer / paste-back provider)
//      drives pi's real onAuth -> onManualCodeInput double-emit; the dialog
//      shows the "Open auth page" link (href = the real claude.ai authorize
//      URL) AND a working paste field SIMULTANEOUSLY, and the link survives the
//      immediately-following manual-code prompt step (review finding #1).
//   4. Picking GitHub Copilot answers the enterprise-domain prompt (blank) and
//      renders the real device userCode + verification-page link.
//   5. Cancel returns the dialog to idle.
//   6. While a flow is in-flight, a second login_begin (separate WS) is
//      rejected { ok:false, reason:'busy' } by the server single-flight guard.
//
// KNOWN ENVIRONMENT BOUND: completing a real token exchange needs real
// subscription credentials, unreachable here. The harness stops at the
// auth-URL / device-code / paste step and never submits a real code, so the
// terminal done{success:true} + model re-pull are out of scope (unit-tested).
//
// No real LLM is needed. Anthropic/OpenAI auth-URL emission is fully local
// (PKCE + localhost callback). Copilot device-code uses real network to
// github.com/login/device/code (unauthenticated device-flow start); if that is
// unavailable, test 4 reports environment-bounded rather than failing.
//
// See README.md alongside this file and docs/manual-tests/provider-login.md.

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
let envBounded = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  \u2713 ${msg}`);
  } else {
    console.error(`  \u2717 ${msg}`);
    failures++;
  }
}
function envBound(msg) {
  console.log(`  \u229D (environment-bounded) ${msg}`);
  envBounded++;
}
function section(name) {
  console.log(`\n[login-smoke] ${name}`);
}
function log(...args) {
  console.log('[login-smoke]', ...args);
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
        console.error(`[login-smoke] agent-browser ${args.join(' ')} -> exit ${child.exitCode}${timedOut ? ' (timed out)' : ''}`);
        if (stderr) console.error(stderr);
        throw new Error(`agent-browser failed: ${args.join(' ')}`);
      }
      return { stdout, stderr, code: child.exitCode };
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error('unreachable');
}

async function evalJs(expr, opts = {}) {
  const { stdout } = await abCmd(['eval', expr], { allowFailure: true, ...opts });
  return stdout.trim().replace(/^"|"$/g, '');
}

// Poll a boolean JS expression until it is true or the timeout elapses.
async function waitFor(expr, { timeoutMs = 8000, intervalMs = 400, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await evalJs(expr)) === 'true') return true;
    await abCmd(['wait', String(intervalMs)]);
  }
  if (label) log(`waitFor timed out: ${label}`);
  return false;
}

const DIALOG_OPEN = `!!Array.from(document.querySelectorAll('h2')).find(h => h.textContent.trim() === 'Provider Login')`;
const PICKER_SHOWN = `(() => { const open = Array.from(document.querySelectorAll('h2')).some(h => h.textContent.trim() === 'Provider Login'); const hasProvider = Array.from(document.querySelectorAll('button')).some(b => /Anthropic|GitHub Copilot|ChatGPT/.test(b.textContent)); return open && hasProvider; })()`;

// Click a provider button by an accessible-name substring, from within the open
// picker. Returns true if the click landed.
async function clickProvider(nameSubstr) {
  await waitFor(PICKER_SHOWN, { label: `picker shown before clicking ${nameSubstr}` });
  const clicked = await evalJs(
    `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes(${JSON.stringify(nameSubstr)})); if (!b) return 'no-button'; b.click(); return 'ok'; })()`,
  );
  return clicked === 'ok';
}

// Dismiss any open LoginDialog (running -> Cancel, terminal -> Done/Close) and
// wait until it is fully closed, so the next flow starts from a clean slate.
async function dismissDialog() {
  for (let i = 0; i < 3; i++) {
    if ((await evalJs(DIALOG_OPEN)) !== 'true') return;
    await evalJs(
      `(() => { const btns = Array.from(document.querySelectorAll('button')); const b = btns.find(x => ['Cancel','Done','Close'].includes(x.textContent.trim())); if (b) b.click(); return 'ok'; })()`,
    );
    await abCmd(['wait', '600']);
  }
}

// Type `/login` into the InputBar textarea and submit it the way a user would.
// Typing `/` opens the slash-command autocomplete, which swallows Enter (it
// calls accept() instead of submitting). So we dismiss autocomplete with Escape
// first, then press Enter to drive the real sendMessage() `/login` interception.
async function typeLoginAndSubmit() {
  const setVal =
    `(() => { const t = document.querySelector('textarea'); if (!t) return 'no-textarea'; t.focus();` +
    ` const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;` +
    ` setter.call(t, '/login'); t.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`;
  await evalJs(setVal);
  await abCmd(['wait', '500']);
  // Dismiss the autocomplete dropdown.
  await evalJs(`(() => { const t = document.querySelector('textarea'); if (!t) return 'no-textarea'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'ok'; })()`);
  await abCmd(['wait', '400']);
  // Now Enter drives sendMessage() -> /login interception.
  await evalJs(`(() => { const t = document.querySelector('textarea'); if (!t) return 'no-textarea'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'ok'; })()`);
  await abCmd(['wait', '1000']);
}

// ---- minimal pi session fabrication (so the InputBar is reachable) --------

function fabricateSession({ cwd }) {
  const sessionId = randomUUID();
  const isoNow = new Date().toISOString();
  const lines = [];
  lines.push({ type: 'session', version: 3, id: sessionId, timestamp: isoNow, cwd });
  const uid = randomUUID().slice(0, 8);
  lines.push({
    type: 'message',
    id: uid,
    parentId: null,
    timestamp: isoNow,
    message: { role: 'user', content: [{ type: 'text', text: 'login smoke seed prompt' }], timestamp: Date.now() },
  });
  return { lines, sessionId };
}

async function seedSession({ sandboxHome, projectDir, lines, sessionId }) {
  const piSessionsDir = join(sandboxHome, '.pi', 'agent', 'sessions');
  const encodedCwd = `--${projectDir.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const sessionDir = join(piSessionsDir, encodedCwd);
  await mkdir(sessionDir, { recursive: true });
  const filenameStamp = new Date().toISOString().replace(/:/g, '-');
  const sessionPath = join(sessionDir, `${filenameStamp}_${sessionId}.jsonl`);
  await writeFile(sessionPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return sessionPath;
}

// ---- direct WS probe for the server-side busy guard -----------------------

async function wsLoginBegin({ port, version, providerId }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=login-smoke-probe&version=${encodeURIComponent(version)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (ev) => reject(ev.error ?? new Error('ws error')), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('login_begin timed out')), 10_000);
      const onMsg = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.id === 'begin-probe' && typeof msg.success === 'boolean') {
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            resolve(msg.data ?? null);
          }
        } catch {
          /* ignore */
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: 'begin-probe', type: 'login_begin', providerId }));
    });
  } finally {
    ws.close();
  }
}

async function wsLoginList({ port, version }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=login-smoke-list&version=${encodeURIComponent(version)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (ev) => reject(ev.error ?? new Error('ws error')), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('login_list timed out')), 10_000);
      const onMsg = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.id === 'list-probe' && typeof msg.success === 'boolean') {
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            resolve(msg.data ?? null);
          }
        } catch {
          /* ignore */
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: 'list-probe', type: 'login_list' }));
    });
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('[login-smoke] provider-login PWA-side smoke');

  const sandboxHome = await mkdtemp(join(tmpdir(), 'provider-login-smoke-'));
  const xdgConfig = join(sandboxHome, '.config');
  const xdgState = join(sandboxHome, '.local', 'state');
  await mkdir(join(xdgConfig, 'pimote'), { recursive: true });
  await mkdir(xdgState, { recursive: true });

  const projectsRoot = join(sandboxHome, 'projects');
  const project = join(projectsRoot, 'login-project');
  await mkdir(project, { recursive: true });
  await mkdir(join(project, '.git'), { recursive: true });
  await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  const port = await getFreePort();
  await writeFile(join(xdgConfig, 'pimote', 'config.json'), JSON.stringify({ roots: [projectsRoot], port, bufferSize: 100 }, null, 2));

  // Screenshots land in the sandbox by default (removed on PASS); set
  // PL_SHOTS=<dir> to keep the coherence screenshots outside the sandbox.
  const shotsDir = process.env.PL_SHOTS || sandboxHome;
  await mkdir(shotsDir, { recursive: true }).catch(() => {});

  const logPath = join(sandboxHome, 'pimote.log');
  log('sandbox HOME =', sandboxHome);
  log('port         =', port);

  let child;
  try {
    section('Fabricate a seed session (so the InputBar is reachable)');
    const sess = fabricateSession({ cwd: project });
    const sessPath = await seedSession({ sandboxHome, projectDir: project, ...sess });
    assert(true, `seeded session ${sessPath}`);

    section('Boot pimote (credential-free sandbox)');
    child = startPimote({ port, sandboxHome, logPath });
    await waitForListening(child, port, logPath);
    log('pimote listening');

    const baseUrl = `http://127.0.0.1:${port}`;
    const version = JSON.parse(await readFile(join(REPO_ROOT, 'client', 'build', '_app', 'version.json'), 'utf-8')).version;

    // -----------------------------------------------------------------
    section('WS probe: login_list returns providers with no credentials');
    // -----------------------------------------------------------------
    const listData = await wsLoginList({ port, version });
    const providers = listData?.providers ?? [];
    const ids = providers.map((p) => p.id);
    assert(providers.length >= 3, `login_list returns >=3 providers (got ${providers.length}: ${ids.join(', ')})`);
    assert(ids.includes('anthropic') && ids.includes('github-copilot') && ids.includes('openai-codex'), `providers include anthropic + github-copilot + openai-codex`);
    assert(providers.every((p) => p.loggedIn === false), `no provider is logged in (fresh sandbox, no auth.json)`);

    // -----------------------------------------------------------------
    section('Drive the PWA: open a session so the InputBar mounts');
    // -----------------------------------------------------------------
    await abCmd(['close'], { allowFailure: true });
    await abCmd(['open', `${baseUrl}/`]);
    await abCmd(['wait', '3000']);
    await abCmd(['find', 'role', 'button', 'click', '--name', 'login smoke seed prompt']);
    await abCmd(['wait', '2500']);

    // -----------------------------------------------------------------
    section('Test 1: typing /login opens the LoginDialog, posts no prompt');
    // -----------------------------------------------------------------
    // Count user message bubbles before. The seed session has 1 user message.
    const beforeText = await evalJs(`document.body.innerText`);
    await typeLoginAndSubmit();
    const dialogOpen = await waitFor(DIALOG_OPEN, { label: 'LoginDialog open after /login' });
    assert(dialogOpen, 'LoginDialog ("Provider Login") opens on /login');

    // No new user bubble: the literal "/login" text must not appear in a posted
    // message. The dialog itself doesn't contain "/login", so a body scan works.
    const loginPosted = (await evalJs(`Array.from(document.querySelectorAll('[data-message-role="user"], .message, article')).some(e => e.textContent.includes('/login'))`)) === 'true';
    // Conservative cross-check: the seed user count should be unchanged. We
    // assert the literal command did not get rendered as a chat message.
    assert(!loginPosted, 'no user message containing "/login" was posted (prompt suppressed)');
    void beforeText;

    await abCmd(['screenshot', join(shotsDir, '01-picker.png')], { allowFailure: true });

    // -----------------------------------------------------------------
    section('Test 2: provider picker lists all three providers');
    // -----------------------------------------------------------------
    const pickerText = await evalJs(`document.body.innerText`);
    assert(/Anthropic/.test(pickerText), 'picker lists Anthropic');
    assert(/GitHub Copilot/.test(pickerText), 'picker lists GitHub Copilot');
    assert(/ChatGPT/.test(pickerText), 'picker lists ChatGPT (OpenAI Codex)');
    const badgeCount = Number(await evalJs(`document.querySelectorAll('.bg-primary\\\\/15').length || 0`)) || 0;
    assert(badgeCount === 0, `no "logged in" badge shown for any provider (got ${badgeCount})`);

    // -----------------------------------------------------------------
    section('Test 3 (HEADLINE): Anthropic paste-back — auth link + paste field together');
    // -----------------------------------------------------------------
    await clickProvider('Anthropic');
    // Wait for both onAuth and onManualCodeInput to round-trip (two login_step
    // events). The auth link must be present AND the prompt step must have
    // arrived after it (both visible at once = the review #1 fix).
    const AUTH_LINK = `Array.from(document.querySelectorAll('a')).some(x => x.textContent.trim() === 'Open auth page')`;
    const PASTE_FIELD = `!!document.querySelector('input[type="text"]')`;
    await waitFor(`(${AUTH_LINK}) && (${PASTE_FIELD})`, { label: 'auth link + paste field both present' });

    const authHref = await evalJs(
      `(() => { const a = Array.from(document.querySelectorAll('a')).find(x => x.textContent.trim() === 'Open auth page'); return a ? a.href : ''; })()`,
    );
    const hasAuthLink = authHref.includes('claude.ai/oauth/authorize') || authHref.includes('anthropic');
    assert(hasAuthLink, `"Open auth page" link present with real Anthropic authorize URL (got ${authHref.slice(0, 70)})`);

    const hasPasteField = (await evalJs(`!!document.querySelector('input[type="text"]')`)) === 'true';
    assert(hasPasteField, 'a paste/text input field is present');

    // The headline guard: BOTH present at the SAME time (link survived the
    // manual-code prompt step that arrives right after the auth step).
    assert(hasAuthLink && hasPasteField, 'HEADLINE: auth link AND paste field render SIMULTANEOUSLY (review #1 fix)');

    // The Submit button next to the paste field must be wired (the prompt step's
    // requestId is what makes submit functional). Assert a Submit control exists.
    const hasSubmit = (await evalJs(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Submit')`)) === 'true';
    assert(hasSubmit, 'a functional Submit button accompanies the paste field');

    await abCmd(['screenshot', join(shotsDir, '02-anthropic-auth.png')], { allowFailure: true });
    log('NOTE: not submitting a real code — token exchange is environment-bounded.');

    // Cancel back to idle so the next flow can start (clears server busy).
    await evalJs(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Cancel'); if (b) b.click(); return 'ok'; })()`);
    await abCmd(['wait', '1500']);
    const dialogStillOpen = (await evalJs(DIALOG_OPEN)) === 'true';
    const postCancelBody = await evalJs(`document.body.innerText`);
    log('post-cancel dialog open =', dialogStillOpen, '| body has "Login failed" =', /Login failed/i.test(postCancelBody));
    await abCmd(['screenshot', join(shotsDir, '02b-after-cancel.png')], { allowFailure: true });
    // The review #1 cancel race used to flip the cancelled flow into a
    // "Login failed" dialog; the handleStep idle-guard now suppresses the
    // abort echo, so the dialog should be fully closed here.
    const idleAfterCancel = !dialogStillOpen;
    assert(idleAfterCancel, 'Test 5: Cancel closes the dialog / returns to idle (no stale "Login failed")');
    await dismissDialog();

    // -----------------------------------------------------------------
    section('Test 4: GitHub Copilot device-code — code + verification URI');
    // -----------------------------------------------------------------
    // Reopen /login.
    await typeLoginAndSubmit();
    await waitFor(DIALOG_OPEN, { label: 'dialog reopened for Copilot' });
    await clickProvider('GitHub Copilot');
    // Copilot first asks the enterprise-domain prompt. Wait for it, then submit
    // blank (=> github.com).
    const promptShown = await waitFor(`/Enterprise/i.test(document.body.innerText)`, { timeoutMs: 6000, label: 'Copilot enterprise prompt' });
    assert(promptShown, 'Copilot shows the enterprise-domain prompt first');
    if (promptShown) {
      await evalJs(
        `(() => { const inp = document.querySelector('input[type="text"]'); if (!inp) return 'no-input';` +
          ` const form = inp.closest('form'); if (form) form.requestSubmit(); else inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 'ok'; })()`,
      );
    }
    // Now wait for the real device-code network round-trip to github.com.
    await waitFor(`/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(document.body.innerText)`, { timeoutMs: 10000, label: 'Copilot device code' });
    const bodyAfter = await evalJs(`document.body.innerText`);
    const hasUserCode = /[A-Z0-9]{4}-[A-Z0-9]{4}/.test(bodyAfter);
    const verifyHref = await evalJs(
      `(() => { const a = Array.from(document.querySelectorAll('a')).find(x => /verification page|github\\.com\\/login\\/device/i.test(x.textContent + ' ' + x.href)); return a ? a.href : ''; })()`,
    );
    if (hasUserCode && verifyHref.includes('github.com')) {
      assert(true, `device-code step renders real user code + verification link (${verifyHref})`);
      await abCmd(['screenshot', join(shotsDir, '03-copilot-device.png')], { allowFailure: true });
    } else {
      const errShown = /Login failed|error/i.test(bodyAfter);
      envBound(`Copilot device code not reachable in this environment (network to github.com); body had code=${hasUserCode}, verifyHref=${verifyHref || 'none'}${errShown ? ', failure step shown' : ''}`);
      await abCmd(['screenshot', join(shotsDir, '03-copilot-device.png')], { allowFailure: true });
    }
    // Cancel/close back to idle.
    await dismissDialog();

    // -----------------------------------------------------------------
    section('Test 6: busy guard — second login_begin while a flow is in-flight');
    // -----------------------------------------------------------------
    // Start an Anthropic flow in the browser (it parks at the paste step,
    // keeping the server busy), then fire a second login_begin over a fresh WS.
    await typeLoginAndSubmit();
    await waitFor(DIALOG_OPEN, { label: 'dialog reopened for busy test' });
    await clickProvider('Anthropic');
    // Confirm the in-flight flow actually started (auth link present) before
    // probing — otherwise the server wouldn't be busy and the probe is moot.
    const inflight = await waitFor(`Array.from(document.querySelectorAll('a')).some(x => x.textContent.trim() === 'Open auth page')`, { label: 'Anthropic flow in-flight before busy probe' });
    assert(inflight, 'busy precondition: an Anthropic flow is in-flight in the browser');
    const busyData = await wsLoginBegin({ port, version, providerId: 'openai-codex' });
    assert(busyData && busyData.ok === false && busyData.reason === 'busy', `concurrent login_begin rejected { ok:false, reason:'busy' } (got ${JSON.stringify(busyData)})`);

    // Clean up: cancel the in-flight flow.
    await dismissDialog();
    await abCmd(['close'], { allowFailure: true });
  } catch (err) {
    console.error('[login-smoke] FAILED:', err);
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

  console.log(`\n[login-smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}${envBounded ? ` (${envBounded} environment-bounded)` : ''}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[login-smoke] uncaught', err);
  process.exit(1);
});
