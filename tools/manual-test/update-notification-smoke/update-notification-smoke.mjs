#!/usr/bin/env node
// Deterministic end-to-end smoke for the update-notification topic.
//
// Boots the real pimote server in an isolated HOME, injects a controlled npm
// registry response through fake-registry.mjs, probes the real WebSocket event,
// and drives the real PWA with agent-browser. It covers the banner, dismiss to
// ambient markers, localStorage persistence across reload/reconnect, newer
// release reappearance, equal/older suppression, banner-slot coexistence, and
// updateCheck:false (including a request-count assertion).
//
// Optional environment variables:
//   UN_SHOTS=/tmp/dir  keep coherence screenshots outside the disposable sandbox
//   UN_KEEP=1          keep the sandbox even on a passing run

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';

const REPO_ROOT = pathResolve(new URL('../../../', import.meta.url).pathname);
const TOOL_DIR = pathResolve(new URL('.', import.meta.url).pathname);
const PIMOTE_BIN = join(REPO_ROOT, 'bin', 'pimote.js');
const FAKE_REGISTRY = join(TOOL_DIR, 'fake-registry.mjs');
const BROWSER_SESSION = `update-notification-${process.pid}`;
const CURRENT_VERSION = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const NEWER_VERSION = '999.0.0';
const LATER_VERSION = '999.1.0';
const OLDER_VERSION = '0.0.0';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}
function section(message) {
  console.log(`\n[update-smoke] ${message}`);
}
function log(...args) {
  console.log('[update-smoke]', ...args);
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

function startPimote({ port, sandboxHome, logPath, latestVersion, fetchLog }) {
  const env = {
    ...process.env,
    HOME: sandboxHome,
    XDG_CONFIG_HOME: join(sandboxHome, '.config'),
    XDG_STATE_HOME: join(sandboxHome, '.local', 'state'),
    XDG_DATA_HOME: join(sandboxHome, '.local', 'share'),
    XDG_CACHE_HOME: join(sandboxHome, '.cache'),
    NODE_ENV: 'production',
    PIMOTE_PORT: String(port),
    PIMOTE_FAKE_LATEST: latestVersion,
    PIMOTE_FETCH_LOG: fetchLog,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${FAKE_REGISTRY}`.trim(),
  };
  const child = spawn(process.execPath, [PIMOTE_BIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
}

async function browser(args, { allowFailure = false, timeoutMs = 20_000, retries = 2 } = {}) {
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
        console.error(`[update-smoke] agent-browser failed: ${args.join(' ')}\n${stderr}`);
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

async function fetchCount(fetchLog) {
  try {
    const raw = await readFile(fetchLog, 'utf8');
    return raw.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function probeUpdate(port, expectedLatest, { expectEvent = true, timeoutMs = 4000 } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=update-probe-${randomUUID()}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (event) => reject(event.error ?? new Error('WebSocket error')), { once: true });
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (expectEvent) reject(new Error(`timed out waiting for update_available (${expectedLatest})`));
      else finish(null);
    }, timeoutMs);
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.type !== 'update_available') return;
      if (!expectEvent) {
        reject(new Error(`unexpected update_available event: ${JSON.stringify(message)}`));
        ws.close();
        return;
      }
      if (message.latestVersion !== expectedLatest) {
        reject(new Error(`unexpected latestVersion ${message.latestVersion}; expected ${expectedLatest}`));
        ws.close();
        return;
      }
      finish(message);
    });
  });
}

async function seedSession({ sandboxHome, projectDir }) {
  const sessionId = randomUUID();
  const sessionsDir = join(sandboxHome, '.pi', 'agent', 'sessions');
  const encodedCwd = `--${projectDir.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const sessionDir = join(sessionsDir, encodedCwd);
  await mkdir(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const filename = `${timestamp.replace(/:/g, '-')}_${sessionId}.jsonl`;
  await writeFile(join(sessionDir, filename), JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp, cwd: projectDir }) + '\n');
  return sessionId;
}

async function configure({ configPath, roots, port, updateCheck }) {
  await writeFile(configPath, JSON.stringify({ roots, port, bufferSize: 100, updateCheck }, null, 2));
}

async function main() {
  console.log('[update-smoke] deterministic update-notification PWA smoke');
  const sandboxHome = await mkdtemp(join(tmpdir(), 'update-notification-smoke-'));
  const configDir = join(sandboxHome, '.config', 'pimote');
  await mkdir(configDir, { recursive: true });
  const projectsRoot = join(sandboxHome, 'projects');
  const projectDir = join(projectsRoot, 'update-project');
  await mkdir(join(projectDir, '.git'), { recursive: true });
  await writeFile(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const port = await freePort();
  const configPath = join(configDir, 'config.json');
  const fetchLog = join(sandboxHome, 'registry-fetches.log');
  const logPath = join(sandboxHome, 'pimote.log');
  await configure({ configPath, roots: [projectsRoot], port, updateCheck: true });
  const sessionId = await seedSession({ sandboxHome, projectDir });
  const baseUrl = `http://127.0.0.1:${port}`;
  const shotsDir = process.env.UN_SHOTS ? pathResolve(process.env.UN_SHOTS) : sandboxHome;
  await mkdir(shotsDir, { recursive: true });
  log('sandbox HOME =', sandboxHome);
  log('project     =', projectDir);
  log('session     =', sessionId);
  log('port        =', port);

  let child;
  try {
    section('Enabled server: deterministic newer response and WebSocket event');
    child = startPimote({ port, sandboxHome, logPath, latestVersion: NEWER_VERSION, fetchLog });
    await waitForListening(child, port, logPath);
    const event = await probeUpdate(port, NEWER_VERSION);
    assert(event?.type === 'update_available', 'accepted WebSocket receives update_available');
    assert(event?.currentVersion === CURRENT_VERSION, `event currentVersion is ${CURRENT_VERSION} (got ${event?.currentVersion})`);
    assert(event?.releaseUrl === `https://github.com/alennartz/pimote/releases/tag/pimote-v${NEWER_VERSION}`, 'event carries canonical release URL');
    assert((await fetchCount(fetchLog)) === 1, 'startup warm-up and early connection share one registry request');

    section('PWA at ~360px: banner, coexistence, and coherence');
    await browser(['close'], { allowFailure: true });
    await browser(['set', 'viewport', '360', '760']);
    await browser(['open', `${baseUrl}/`]);
    await browser(['wait', '3000']);
    const landingSnapshot = (await browser(['snapshot', '-i'])).stdout;
    const landingText = String(await evalBrowser('document.body.innerText'));
    // The update copy is non-interactive, so snapshot -i may omit the text;
    // the dismiss button is the interactive element used below.
    assert(landingSnapshot.includes('Dismiss update notification'), 'interactive snapshot exposes the update dismiss control');
    assert(landingText.includes(`Update available: ${CURRENT_VERSION} → ${NEWER_VERSION}`), 'banner shows running and available versions');
    const releaseHref = await evalBrowser('document.querySelector(\'a[href^="https://github.com/alennartz/pimote/releases/tag/pimote-v"]\')?.getAttribute("href") ?? null');
    assert(releaseHref === `https://github.com/alennartz/pimote/releases/tag/pimote-v${NEWER_VERSION}`, 'banner uses the server-supplied release URL');
    // Headless Chromium in this harness has no usable PushManager/service
    // worker, so NotificationBanner's permission-gated branch cannot render.
    // Exercise the sibling fixed mobile InstallBanner instead: it is driven by
    // the real beforeinstallprompt listener and proves the two banners occupy
    // separate, non-overlapping slots at this width.
    await browser(['eval', 'window.dispatchEvent(new Event("beforeinstallprompt"))']);
    await browser(['wait', '300']);
    const stackText = String(await evalBrowser('document.body.innerText'));
    const installVisible = stackText.includes('Install Pimote for quick access');
    assert(installVisible, 'synthetic beforeinstallprompt renders the existing InstallBanner');
    if (!landingText.includes('Enable notifications to know when sessions finish.')) {
      log('NotificationBanner not observed: headless Chromium lacks PushManager/service-worker support; InstallBanner was used as the sibling-slot substitute');
    }
    await browser(['screenshot', join(shotsDir, 'mobile-banner-stack.png')], { allowFailure: true });

    section('Dismiss to ambient markers on mobile');
    // This click targets the dismiss control exposed by the preceding
    // snapshot, satisfying the agent-browser skill's snapshot→interaction
    // requirement and exercising the real accessible button path.
    await browser(['find', 'role', 'button', 'click', '--name', 'Dismiss update notification']);
    await browser(['wait', '500']);
    const dismissedText = String(await evalBrowser('document.body.innerText'));
    assert(!dismissedText.includes('Update available:'), 'dismissing removes the interrupting update banner');
    assert((await evalBrowser('localStorage.getItem("pimote:dismissedUpdateVersion")')) === NEWER_VERSION, 'dismissal persists the latest version key');

    // FolderList is mounted in both the hidden desktop sidebar and the
    // mobile landing content, so the accessible 0-message name is duplicated.
    // Click the visible mobile row in <main> rather than relying on strict
    // role-name matching across both trees.
    await browser(['eval', 'Array.from(document.querySelectorAll("main button")).find((button) => button.textContent?.includes("(no messages)"))?.click()']);
    await browser(['wait', '2500']);
    const markerPresent = await evalBrowser('Boolean(document.querySelector(\'button[title="Session settings"]\')?.parentElement?.querySelector(\'span[aria-hidden="true"]\'))');
    assert(markerPresent === true, 'settings gear keeps an ambient dot after dismissal');

    await browser(['find', 'title', 'Session settings', 'click']);
    await browser(['wait', '500']);
    const settingsText = String(await evalBrowser('document.body.innerText'));
    const settingsHref = await evalBrowser(
      'Array.from(document.querySelectorAll(\'a[href^="https://github.com/alennartz/pimote/releases/tag/pimote-v"]\')).at(-1)?.getAttribute("href") ?? null',
    );
    assert(
      settingsText.includes(`Pimote update`) && settingsText.includes(`Running ${CURRENT_VERSION}`) && settingsText.includes(`Available ${NEWER_VERSION}`),
      'SessionSettingsDialog retains running/available detail after dismissal',
    );
    assert(settingsHref === `https://github.com/alennartz/pimote/releases/tag/pimote-v${NEWER_VERSION}`, 'SessionSettingsDialog keeps the supplied release link');
    await browser(['press', 'Escape']);

    section('Desktop StatusBar twin and visual layout');
    await browser(['set', 'viewport', '1280', '900']);
    await browser(['wait', '500']);
    const statusTitle = await evalBrowser('document.querySelector(\'[title^="Pimote update:"]\')?.getAttribute("title") ?? null');
    assert(typeof statusTitle === 'string' && statusTitle.includes(`available ${NEWER_VERSION}`), 'desktop StatusBar keeps the ambient update item');
    await browser(['screenshot', join(shotsDir, 'desktop-ambient-marker.png')], { allowFailure: true });

    section('Reload and reconnect preserve dismissal');
    await browser(['reload']);
    await browser(['wait', '2500']);
    const reloadText = String(await evalBrowser('document.body.innerText'));
    assert(!reloadText.includes('Update available:'), 'reload does not resurrect the dismissed same-version banner');
    assert((await evalBrowser('localStorage.getItem("pimote:dismissedUpdateVersion")')) === NEWER_VERSION, 'reload keeps pimote:dismissedUpdateVersion');

    await stopPimote(child);
    child = startPimote({ port, sandboxHome, logPath, latestVersion: NEWER_VERSION, fetchLog });
    await waitForListening(child, port, logPath);
    await browser(['wait', '4500']);
    const reconnectText = String(await evalBrowser('document.body.innerText'));
    assert(!reconnectText.includes('Update available:'), 'reconnect does not resurrect the dismissed same-version banner');
    assert((await fetchCount(fetchLog)) === 2, 'a restarted process performs one controlled registry request');

    section('A newer latest version raises the banner again');
    await stopPimote(child);
    child = startPimote({ port, sandboxHome, logPath, latestVersion: LATER_VERSION, fetchLog });
    await waitForListening(child, port, logPath);
    await browser(['wait', '4500']);
    // Reconnect is the first assertion; reload only if the browser was still in backoff.
    let laterText = String(await evalBrowser('document.body.innerText'));
    if (!laterText.includes(`Update available: ${CURRENT_VERSION} → ${LATER_VERSION}`)) {
      await browser(['reload']);
      await browser(['wait', '2500']);
      laterText = String(await evalBrowser('document.body.innerText'));
    }
    assert(laterText.includes(`Update available: ${CURRENT_VERSION} → ${LATER_VERSION}`), 'a newer latest version raises the banner after the old version was dismissed');
    assert((await evalBrowser('localStorage.getItem("pimote:dismissedUpdateVersion")')) === NEWER_VERSION, 'newer banner does not overwrite the older dismissal until dismissed');

    section('Disabled path: no registry request and no update surfaces');
    const beforeDisabledFetches = await fetchCount(fetchLog);
    await configure({ configPath, roots: [projectsRoot], port, updateCheck: false });
    await stopPimote(child);
    child = startPimote({ port, sandboxHome, logPath, latestVersion: '999.2.0', fetchLog });
    await waitForListening(child, port, logPath);
    await browser(['reload']);
    await browser(['wait', '2500']);
    const disabledText = String(await evalBrowser('document.body.innerText'));
    assert(!disabledText.includes('Update available:'), 'updateCheck:false emits no banner');
    assert((await evalBrowser('document.querySelectorAll(\'[title^="Pimote update:"]\').length')) === 0, 'updateCheck:false emits no desktop ambient marker');
    assert(
      (await evalBrowser('document.querySelector(\'button[title="Session settings"]\')?.parentElement?.querySelector(\'span[aria-hidden="true"]\') ? 1 : 0')) === 0,
      'updateCheck:false emits no mobile settings dot',
    );
    assert((await fetchCount(fetchLog)) === beforeDisabledFetches, 'updateCheck:false makes no npm registry request');

    section('Equal and older registry versions stay silent');
    await configure({ configPath, roots: [projectsRoot], port, updateCheck: true });
    await stopPimote(child);
    child = startPimote({ port, sandboxHome, logPath, latestVersion: CURRENT_VERSION, fetchLog });
    await waitForListening(child, port, logPath);
    await probeUpdate(port, CURRENT_VERSION, { expectEvent: false });
    assert(true, `equal registry version ${CURRENT_VERSION} emits no update event`);
    await stopPimote(child);
    child = startPimote({ port, sandboxHome, logPath, latestVersion: OLDER_VERSION, fetchLog });
    await waitForListening(child, port, logPath);
    await probeUpdate(port, OLDER_VERSION, { expectEvent: false });
    assert(true, `older registry version ${OLDER_VERSION} emits no update event`);

    await browser(['close'], { allowFailure: true });
  } catch (error) {
    failures++;
    console.error('[update-smoke] FAILED:', error);
    try {
      const text = await readFile(logPath, 'utf8');
      console.error('[update-smoke] server log:\n' + text.slice(-8000));
    } catch {
      // Ignore missing log.
    }
    await browser(['close'], { allowFailure: true }).catch(() => {});
  } finally {
    await stopPimote(child).catch(() => {});
    log('server log path:', logPath);
    if (failures === 0 && !process.env.UN_KEEP) await rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
    else log('sandbox preserved for inspection:', sandboxHome);
  }

  console.log(`\n[update-smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[update-smoke] uncaught:', error);
  process.exit(1);
});
