#!/usr/bin/env node
/**
 * PWA smoke for the file-downloads topic.
 *
 * Boots a real sandboxed pimote server and drives the real PWA with
 * agent-browser. A tiny sandbox-only pi extension emits one deterministic
 * `download_update` offer for a pair of persisted registrations; this stands
 * in for the live LLM calling `pimote_send_file` while the HTTP route,
 * WebSocket state, PWA toast/inbox, and persistence are all real.
 *
 * Covered:
 *   - offered toast chooses the exact offered item from a multi-item snapshot
 *   - dismissing the toast leaves a session-local fallback inbox
 *   - one-click native browser download streams bytes and consumes once
 *   - source preservation, 404 on a second redemption, and silent restore
 *     after a server restart/reopen
 *   - another session has no access to the first session's pending inbox
 *
 * OS-level Web Push delivery is environment-bounded in headless Chromium; the
 * client push planner and notification-intent contracts are exercised by the
 * repository's focused unit tests listed in the manual-test artifact.
 */

import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

const REPO_ROOT = pathResolve(new URL('../../../', import.meta.url).pathname);
const PIMOTE_BIN = join(REPO_ROOT, 'bin', 'pimote.js');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}
function section(name) {
  console.log(`\n[file-downloads-smoke] ${name}`);
}
function log(...args) {
  console.log('[file-downloads-smoke]', ...args);
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForListening(child, port, logPath) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`pimote exited early (${child.exitCode}); see ${logPath}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (response.status < 500) return;
    } catch {
      // Keep polling while the child boots.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`pimote did not start on :${port}; see ${logPath}`);
}

function startPimote({ port, sandboxHome, logPath, emitOffer }) {
  const env = {
    ...process.env,
    HOME: sandboxHome,
    XDG_CONFIG_HOME: join(sandboxHome, '.config'),
    XDG_STATE_HOME: join(sandboxHome, '.local', 'state'),
    XDG_DATA_HOME: join(sandboxHome, '.local', 'share'),
    XDG_CACHE_HOME: join(sandboxHome, '.cache'),
    PIMOTE_PORT: String(port),
    PIMOTE_MANUAL_EMIT: emitOffer ? '1' : '0',
    NODE_ENV: 'production',
  };
  const child = spawn(process.execPath, [PIMOTE_BIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tee = (chunk) => appendFile(logPath, chunk).catch(() => {});
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

async function abCmd(args, { allowFailure = false, retries = 2, timeoutMs = 25_000 } = {}) {
  log('agent-browser', args.join(' '));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const child = spawn('agent-browser', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const combined = stdout + stderr;
    const transient = /Resource temporarily unavailable|daemon may be busy/i.test(combined);
    const success = child.exitCode === 0 && !timedOut;
    if (success || allowFailure || (!transient && !timedOut) || attempt === retries) {
      if (!success && !allowFailure) {
        console.error(`[file-downloads-smoke] agent-browser failed: ${args.join(' ')}`);
        if (stderr) console.error(stderr);
        throw new Error(`agent-browser failed: ${args.join(' ')}`);
      }
      return { stdout, stderr, code: child.exitCode };
    }
    await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
  }
  throw new Error('unreachable');
}

function sessionDirectory(projectDir, sandboxHome) {
  const encoded = `--${projectDir.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(sandboxHome, '.pi', 'agent', 'sessions', encoded);
}

async function seedSession({ sandboxHome, projectDir, sessionId, firstMessage }) {
  const directory = sessionDirectory(projectDir, sandboxHome);
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString();
  const stamp = timestamp.replace(/:/g, '-');
  const sessionPath = join(directory, `${stamp}_${sessionId}.jsonl`);
  const userId = randomUUID().slice(0, 8);
  const assistantId = randomUUID().slice(0, 8);
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp, cwd: projectDir },
    {
      type: 'message',
      id: userId,
      parentId: null,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: firstMessage }], timestamp: Date.now() },
    },
    {
      type: 'message',
      id: assistantId,
      parentId: userId,
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'fixture ready' }],
        api: 'openai-responses',
        provider: 'fabricated',
        model: 'gpt-5.3-codex',
        stopReason: 'stop',
        timestamp: Date.now(),
        responseId: `resp_${assistantId}`,
      },
    },
  ];
  await writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return sessionPath;
}

async function readStore(storePath) {
  try {
    return JSON.parse(await readFile(storePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseEvalString(output) {
  const value = output.trim();
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string') {
      try {
        return JSON.parse(parsed);
      } catch {
        return parsed;
      }
    }
    return parsed;
  } catch {
    return value.replace(/^"|"$/g, '').replace(/\\"/g, '"');
  }
}

async function pageEval(expression) {
  const result = await abCmd(['eval', expression]);
  return parseEvalString(result.stdout);
}

async function main() {
  console.log('[file-downloads-smoke] file-downloads PWA smoke');

  const sandboxHome = await mkdtemp(join(tmpdir(), 'file-downloads-smoke-'));
  const projectsRoot = join(sandboxHome, 'projects');
  const projectDir = join(projectsRoot, 'download-project');
  const otherProjectDir = join(projectsRoot, 'other-project');
  const stateDir = join(sandboxHome, '.local', 'state', 'pimote');
  const downloadStoreDir = join(stateDir, 'file-downloads');
  const configDir = join(sandboxHome, '.config', 'pimote');
  await mkdir(join(projectDir, '.git'), { recursive: true });
  await mkdir(join(otherProjectDir, '.git'), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(otherProjectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const offerBody = 'native download payload\n';
  const pendingBody = 'second pending payload\n';
  await writeFile(join(projectDir, 'offer.txt'), offerBody);
  await writeFile(join(projectDir, 'pending.txt'), pendingBody);

  const port = await getFreePort();
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ roots: [projectsRoot], port, bufferSize: 100 }, null, 2));

  const ownerSessionId = randomUUID();
  const otherSessionId = randomUUID();
  const ownerMessage = 'hello from download smoke';
  const otherMessage = 'hello from other session';
  const ownerSessionPath = await seedSession({ sandboxHome, projectDir, sessionId: ownerSessionId, firstMessage: ownerMessage });
  const otherSessionPath = await seedSession({ sandboxHome, projectDir: otherProjectDir, sessionId: otherSessionId, firstMessage: otherMessage });
  const offerId = 'manual-download-offer-001';
  const pendingId = 'manual-download-pending-002';
  await mkdir(downloadStoreDir, { recursive: true });
  const storePath = join(downloadStoreDir, `${ownerSessionId}.json`);
  await writeFile(
    storePath,
    JSON.stringify(
      {
        version: 1,
        downloads: [
          { id: offerId, sourcePath: 'offer.txt', workspaceRoot: projectDir, filename: 'offer.txt', sizeBytes: Buffer.byteLength(offerBody) },
          { id: pendingId, sourcePath: 'pending.txt', workspaceRoot: projectDir, filename: 'pending.txt', sizeBytes: Buffer.byteLength(pendingBody) },
        ],
      },
      null,
      2,
    ),
  );

  // Global pi extension used only by this harness. It emits the same typed
  // event the real file-download extension would publish after its tool
  // registration, while the manager/route still consume the persisted entry.
  const extensionDir = join(sandboxHome, '.pi', 'agent', 'extensions');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, 'manual-file-download-offer.js'),
    `export default function(pi) {
  pi.on('session_start', (_event, ctx) => {
    if (process.env.PIMOTE_MANUAL_EMIT !== '1' || ctx.sessionManager.getSessionId() !== ${JSON.stringify(ownerSessionId)}) return;
    pi.events.emit('pimote:downloads', {
      type: 'download_update',
      sessionId: ${JSON.stringify(ownerSessionId)},
      cause: 'offered',
      offeredDownloadId: ${JSON.stringify(offerId)},
      downloads: [
        { id: ${JSON.stringify(offerId)}, filename: 'offer.txt', sizeBytes: ${Buffer.byteLength(offerBody)}, href: '/d/${offerId}' },
        { id: ${JSON.stringify(pendingId)}, filename: 'pending.txt', sizeBytes: ${Buffer.byteLength(pendingBody)}, href: '/d/${pendingId}' }
      ]
    });
  });
}
`,
  );

  const logPath = join(sandboxHome, 'pimote.log');
  let child;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    section('Connect and open the owner session');
    child = startPimote({ port, sandboxHome, logPath, emitOffer: true });
    await waitForListening(child, port, logPath);
    assert(true, `sandbox server listening on ${baseUrl}`);
    await abCmd(['close'], { allowFailure: true });
    await abCmd(['open', `${baseUrl}/`]);
    await abCmd(['wait', '3000']);
    const landing = (await abCmd(['snapshot', '-i'])).stdout;
    assert(landing.includes(ownerMessage), 'landing snapshot exposes the seeded owner session');
    await abCmd(['find', 'role', 'button', 'click', '--name', ownerMessage]);
    await abCmd(['wait', '3000']);

    section('Offered toast and fallback inbox');
    const offeredSnapshot = (await abCmd(['snapshot', '-i'])).stdout;
    const toastText = String(await pageEval(`document.querySelector('[aria-live="polite"]')?.textContent || ''`));
    assert(toastText.includes('File ready to download'), 'new offered registration shows an actionable toast');
    assert(toastText.includes('offer.txt'), 'toast names the exact offered item, not merely the oldest snapshot item');
    const toastState = await pageEval(`JSON.stringify({
      live: document.querySelectorAll('[aria-live="polite"]').length,
      offerHref: document.querySelector('a[href="/d/${offerId}"]')?.getAttribute('href') || null
    })`);
    assert(toastState?.live > 0 && toastState?.offerHref === `/d/${offerId}`, 'toast primary action is a same-origin one-shot href');
    assert(offeredSnapshot.includes('link "Download"'), 'interactive snapshot exposes the native Download action');

    await abCmd(['find', 'role', 'button', 'click', '--name', 'Dismiss download notification']);
    await abCmd(['wait', '400']);
    const dismissed = await pageEval(`document.querySelectorAll('[aria-live="polite"]').length`);
    assert(Number(dismissed) === 0, 'dismissing the toast leaves no duplicate actionable prompt');

    let inboxButton = await abCmd(['find', 'title', 'Open 2 pending downloads', 'click'], { allowFailure: true });
    // Desktop and mobile presenters are mounted together. The semantic title
    // therefore resolves twice; choose the presenter that is actually visible
    // rather than accidentally opening the CSS-hidden mobile trigger.
    const clickedByEval = await pageEval(`(() => {
      const buttons = Array.from(document.querySelectorAll('button[title="Open 2 pending downloads"]'));
      const button = buttons.find((candidate) => getComputedStyle(candidate).display !== 'none' && candidate.getBoundingClientRect().width > 0);
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (clickedByEval === true) inboxButton = { ...inboxButton, code: 0 };
    assert(inboxButton.code === 0, 'viewed owner session exposes a two-item Downloads inbox affordance');
    await abCmd(['wait', '300']);
    const inboxSnapshot = (await abCmd(['snapshot', '-i'])).stdout;
    const inboxState = await pageEval(`JSON.stringify({
      heading: document.body.innerText.includes('Downloads (2)'),
      offerHref: document.querySelector('a[href="/d/${offerId}"]')?.getAttribute('href') || null,
      pendingHref: document.querySelector('a[href="/d/${pendingId}"]')?.getAttribute('href') || null,
      offerText: Array.from(document.querySelectorAll('a[href="/d/${offerId}"]')).some((link) => link.textContent?.includes('offer.txt')),
      pendingText: Array.from(document.querySelectorAll('a[href="/d/${pendingId}"]')).some((link) => link.textContent?.includes('pending.txt'))
    })`);
    assert(inboxState?.heading || inboxSnapshot.includes('Downloads 2'), 'fallback inbox opens for the viewed owner session');
    assert(inboxState?.offerHref === `/d/${offerId}` && inboxState?.pendingHref === `/d/${pendingId}`, 'inbox preserves native links for both pending registrations');
    if (!(inboxState?.offerText && inboxState?.pendingText))
      console.log('[file-downloads-smoke] inbox state:', JSON.stringify(inboxState), 'snapshot:', inboxSnapshot.slice(0, 4000));
    assert(inboxState?.offerText && inboxState?.pendingText, 'inbox lists both pending filenames');

    section('One-click native download and one-shot consumption');
    const downloadedPath = join(sandboxHome, 'offer-downloaded.txt');
    await abCmd(['download', `a[href="/d/${offerId}"]:visible`, downloadedPath]);
    await abCmd(['wait', '1200']);
    const downloadedBytes = await readFile(downloadedPath, 'utf8').catch(() => '');
    assert(downloadedBytes === offerBody, 'native browser download contains the live source bytes');
    assert((await readFile(join(projectDir, 'offer.txt'), 'utf8')) === offerBody, 'consumption preserves the source file on the server');
    const afterConsumeStore = await readStore(storePath);
    assert(
      afterConsumeStore?.downloads?.length === 1 && afterConsumeStore.downloads[0]?.id === pendingId,
      'consumed registration is removed durably while the sibling remains pending',
    );
    const staleResponse = await fetch(`${baseUrl}/d/${offerId}`);
    assert(staleResponse.status === 404, 'a second request for the one-shot id returns 404');
    const afterConsumeSnapshot = (await abCmd(['snapshot', '-i'])).stdout;
    const afterConsumeButtons = Number(await pageEval(`document.querySelectorAll('button[title*="pending download"]').length`));
    assert(afterConsumeButtons > 0 && afterConsumeSnapshot.includes('Downloads 1'), 'consumed update removes the item from the live inbox and leaves one pending');
    assert(!afterConsumeSnapshot.includes('Downloads 2'), 'consumed update does not leave a stale two-item affordance');

    section('Session-local isolation');
    await abCmd(['find', 'role', 'button', 'click', '--name', otherMessage]);
    await abCmd(['wait', '1800']);
    const otherSnapshot = (await abCmd(['snapshot', '-i'])).stdout;
    const otherDownloadButtons = Number(await pageEval(`document.querySelectorAll('button[title*="pending download"]').length`));
    assert(otherDownloadButtons === 0 && !/Downloads \d+/.test(otherSnapshot), 'another viewed session has no owner-session download inbox');
    await abCmd(['find', 'role', 'button', 'click', '--name', ownerMessage]);
    await abCmd(['wait', '1500']);
    const ownerAgain = (await abCmd(['snapshot', '-i'])).stdout;
    assert(ownerAgain.includes('Downloads 1'), 'switching back restores only the owner session pending count');

    section('Reconnect/reopen and silent restore');
    await abCmd(['close'], { allowFailure: true });
    await stopPimote(child);
    child = undefined;
    child = startPimote({ port, sandboxHome, logPath, emitOffer: false });
    await waitForListening(child, port, logPath);
    await abCmd(['open', `${baseUrl}/`]);
    await abCmd(['wait', '3000']);
    const reopenedLanding = (await abCmd(['snapshot', '-i'])).stdout;
    assert(reopenedLanding.includes(ownerMessage), 'reopen discovers the persisted owner session');
    await abCmd(['find', 'role', 'button', 'click', '--name', ownerMessage]);
    await abCmd(['wait', '2200']);
    const reopened = (await abCmd(['snapshot', '-i'])).stdout;
    const reopenedToastCount = Number(await pageEval(`document.querySelectorAll('[aria-live="polite"]').length`));
    assert(reopened.includes('Downloads 1'), 'reconnect/reopen restores the surviving pending registration');
    assert(reopenedToastCount === 0, 'restored snapshot is silent and does not duplicate the consumed/old offer toast');

    const restoredStore = await readStore(storePath);
    assert(restoredStore?.downloads?.length === 1 && restoredStore.downloads[0]?.id === pendingId, 'server restart retains the pending registration document');
    const staleAfterRestart = await fetch(`${baseUrl}/d/${offerId}`);
    assert(staleAfterRestart.status === 404, 'consumed id remains unavailable after restart');

    section('Background notification seam');
    console.log('  ⊝ OS Web Push notification click delivery is environment-bounded in this headless run; focused/background planner and inbox-intent unit tests run separately.');

    const shotPath = process.env.FD_SHOT ? pathResolve(process.env.FD_SHOT) : join(sandboxHome, 'file-downloads.png');
    await abCmd(['screenshot', shotPath], { allowFailure: true });
    await abCmd(['close'], { allowFailure: true });
  } catch (error) {
    console.error('[file-downloads-smoke] FAILED:', error);
    failures++;
    await abCmd(['close'], { allowFailure: true }).catch(() => {});
  } finally {
    await stopPimote(child).catch(() => {});
    log('owner session file:', ownerSessionPath);
    log('other session file:', otherSessionPath);
    log('server log:', logPath);
    if (failures === 0) await rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
    else log(`sandbox preserved for inspection: ${sandboxHome}`);
  }

  console.log(`\n[file-downloads-smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[file-downloads-smoke] uncaught:', error);
  process.exit(1);
});
