#!/usr/bin/env node
// End-to-end smoke for the session-ownership redesign.
//
// Boots a real pimote server with a fabricated session and a tiny global pi
// extension. Two WsProbe clients cover observer fan-out, archive/reopen,
// dialog dismissal, live bash output, voice-holder transfer, and conflict
// detection. Two agent-browser sessions cover the real PWA open/send surface
// and stale localStorage restore handling.
//
// Optional environment variables:
//   SO_SHOTS=/tmp/dir  keep browser screenshots outside the disposable sandbox

import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';

import { makeReporter } from '../lib/report.mjs';
import { freePort, gitInit, seedSession, startPimote, stopPimote, waitForListening } from '../lib/sandbox.mjs';
import { WsProbe } from '../lib/ws-probe.mjs';
import { makeBrowserHelpers } from '../lib/browser.mjs';

const REAL_AGENT_DIR = join(process.env.HOME ?? '', '.pi', 'agent');
const { assert, soft, section, log, stats, softFailures } = makeReporter('session-observers');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fact, timeoutMs = 8_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fact()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function allEvents(probe, type) {
  return probe.events.filter((entry) => !type || entry.event.type === type).map((entry) => entry.event);
}

function flattenedEventText(probe) {
  return JSON.stringify(probe.events.map((entry) => entry.event));
}

function pendingUiRequest(probe, sessionId) {
  return allEvents(probe, 'extension_ui_request').find((event) => event.sessionId === sessionId && event.method === 'confirm');
}

function bufferedEventList(probe) {
  return allEvents(probe, 'buffered_events').flatMap((event) => event.events ?? []);
}

function makeDialogExtension() {
  // pi discovers global .js extensions beneath PI_CODING_AGENT_DIR/extensions.
  // A user_bash hook keeps this test deterministic and does not involve an LLM.
  return `export default function (pi) {
  pi.on('user_bash', async (event, ctx) => {
    if (event.command !== '__session_ownership_dialog__') return undefined;
    const confirmed = await ctx.ui.confirm('Observer dialog', 'Answer this prompt from one observer');
    return { result: { output: confirmed ? 'confirmed' : 'cancelled', exitCode: 0, cancelled: false, truncated: false } };
  });
}
`;
}

async function openSession(probe, sessionId, folderPath) {
  return probe.send({ type: 'open_session', sessionId, folderPath });
}

async function snapshotBrowserRefs(browser) {
  const result = await browser(['snapshot', '-i']);
  return result.stdout ?? '';
}

function firstRefFor(snapshot, pattern) {
  const line = snapshot.split('\n').find((row) => pattern.test(row));
  const ref = line?.match(/\[ref=(e\d+)\]/i)?.[1];
  return ref ? `@${ref}` : null;
}

async function main() {
  console.log('[session-observers] session-ownership manual smoke');
  const sandboxHome = await mkdtemp(join(tmpdir(), 'session-observers-smoke-'));
  const configDir = join(sandboxHome, '.config', 'pimote');
  const agentDir = join(sandboxHome, 'agent');
  const projectDir = join(sandboxHome, 'project');
  await mkdir(configDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await gitInit(projectDir, 'main');

  // Copy the host's local model catalog when present. The session is seeded,
  // so no LLM call is required, but voice extension loading needs a model ref.
  let modelAvailable = false;
  try {
    const modelsPath = join(REAL_AGENT_DIR, 'models.json');
    const models = JSON.parse(await readFile(modelsPath, 'utf8'));
    modelAvailable = Boolean(models.providers?.jetson?.models?.length);
    if (modelAvailable) await copyFile(modelsPath, join(agentDir, 'models.json'));
  } catch {
    modelAvailable = false;
  }

  const extensionDir = join(agentDir, 'extensions');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(extensionDir, 'session-ownership-dialog.js'), makeDialogExtension());

  const sessionId = await seedSession(join(agentDir, 'sessions'), projectDir, 'Seed observer prompt', 'Seed observer answer');
  const port = await freePort();
  const speechmuxPort = await freePort();
  let speechmuxServer;
  const configPath = join(configDir, 'config.json');
  const config = {
    roots: [projectDir],
    port,
    bufferSize: 100,
    updateCheck: false,
    ...(modelAvailable ? { defaultProvider: 'jetson', defaultModel: 'qwen3.8-27b' } : {}),
    ...(modelAvailable
      ? { voice: { speechmuxSignalUrl: `ws://127.0.0.1:${speechmuxPort}/signal`, speechmuxLlmWsUrl: `ws://127.0.0.1:${speechmuxPort}/llm` } }
      : {}),
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const logPath = join(sandboxHome, 'pimote.log');
  const shotsDir = process.env.SO_SHOTS ? pathResolve(process.env.SO_SHOTS) : sandboxHome;
  await mkdir(shotsDir, { recursive: true });

  log('sandbox HOME =', sandboxHome);
  log('project      =', projectDir);
  log('session      =', sessionId);
  log('port         =', port);
  log('voice        =', modelAvailable ? 'configured' : 'environment-bounded (no local model catalog)');

  let child;
  let external;
  let first;
  let second;
  let late;
  const browserToken = randomUUID().slice(0, 8);
  const browserA = makeBrowserHelpers({ session: `session-ownership-a-${process.pid}-${browserToken}`, log });
  const browserB = makeBrowserHelpers({ session: `session-ownership-b-${process.pid}-${browserToken}`, log });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    if (modelAvailable) {
      speechmuxServer = new WebSocketServer({ host: '127.0.0.1', port: speechmuxPort });
      speechmuxServer.on('connection', (socket) => socket.on('message', () => {}));
      await new Promise((resolve, reject) => {
        speechmuxServer.once('listening', resolve);
        speechmuxServer.once('error', reject);
      });
    }
    child = startPimote({ port, sandboxHome, agentDir, configPath, logPath });
    await waitForListening(child, port, logPath);

    first = new WsProbe(port, `ownership-first-${randomUUID().slice(0, 8)}`);
    second = new WsProbe(port, `ownership-second-${randomUUID().slice(0, 8)}`);
    await first.open();
    await second.open();

    section('Shared observers: open, replay, sends, and disconnect');
    const firstOpen = await openSession(first, sessionId, projectDir);
    const secondOpen = await openSession(second, sessionId, projectDir);
    assert(firstOpen.success === true && secondOpen.success === true, 'two observers open the same live session');
    assert(
      flattenedEventText(first).includes('Seed observer answer') && flattenedEventText(second).includes('Seed observer answer'),
      'both observers receive the seeded transcript replay',
    );

    const sendA = await first.send({ type: 'steer', sessionId, message: 'observer A queued send' });
    const sendB = await second.send({ type: 'steer', sessionId, message: 'observer B queued send' });
    assert(sendA.success === true && sendB.success === true, 'either observer can submit a send');
    await sleep(200);
    const queueSnapshots = [...allEvents(first, 'queue_update'), ...allEvents(second, 'queue_update')];
    const latestQueue = queueSnapshots.at(-1);
    const queueOrderOk = Boolean(
      latestQueue?.steering?.includes('observer A queued send') && latestQueue?.steering?.includes('observer B queued send') &&
        latestQueue.steering.indexOf('observer A queued send') < latestQueue.steering.indexOf('observer B queued send'),
    );
    if (!queueOrderOk) log('queue snapshots:', JSON.stringify(queueSnapshots));
    assert(queueOrderOk, 'observer sends enter one queue in arrival order');

    second.close();
    const remainingSend = await first.send({ type: 'steer', sessionId, message: 'observer A after B disconnects' });
    assert(remainingSend.success === true, 'disconnecting one observer leaves the other attached');

    section('Live bash output and late observer replay');
    const beforeBash = first.events.length;
    const bashPromise = first.send({ type: 'bash', sessionId, command: "printf 'observer-live-output\\n'; sleep 0.5" });
    await sleep(180);
    const bashResponse = await bashPromise;
    assert(bashResponse.success === true, 'native bash command completes successfully');
    const liveUpdates = first.events.slice(beforeBash).map((entry) => entry.event).filter((event) => event.type === 'bash_execution_update');
    assert(liveUpdates.length > 0, 'the connected observer receives live bash deltas');
    assert(liveUpdates.every((event) => !('cursor' in event)), 'live bash deltas omit replay cursors');
    late = new WsProbe(port, `ownership-late-${randomUUID().slice(0, 8)}`);
    await late.open();
    const lateOpen = await openSession(late, sessionId, projectDir);
    assert(lateOpen.success === true, 'a late observer opens after bash completion');
    const lateUpdates = allEvents(late, 'bash_execution_update');
    assert(lateUpdates.length === 0, 'late observer does not receive pre-join live bash deltas');
    if (!flattenedEventText(late).includes('observer-live-output')) log('late observer events after bash:', JSON.stringify(late.events.slice(-12).map((entry) => entry.event)));
    assert(flattenedEventText(late).includes('observer-live-output'), 'late observer receives the final bash result through replay');

    section('Extension dialog: broadcast and first answer wins');
    const dialogPromise = first.send({ type: 'bash', sessionId, command: '__session_ownership_dialog__' });
    const dialogReady = await waitFor(() => Boolean(pendingUiRequest(first, sessionId) && pendingUiRequest(late, sessionId)), 10_000);
    assert(dialogReady, 'the extension dialog request reaches both observers');
    const request = pendingUiRequest(first, sessionId) ?? pendingUiRequest(late, sessionId);
    if (request) {
      const firstResponse = await first.send({ type: 'extension_ui_response', sessionId, requestId: request.requestId, confirmed: true });
      const resolved = await waitFor(() => allEvents(late, 'extension_ui_resolved').some((event) => event.requestId === request.requestId), 5_000);
      assert(firstResponse.success === true, 'first observer answer is accepted');
      assert(resolved, 'other observers receive matching extension_ui_resolved dismissal');
      assert(!allEvents(first, 'extension_ui_resolved').some((event) => event.requestId === request.requestId), 'answering observer does not receive its own dismissal');
      const beforeLateResolution = allEvents(late, 'extension_ui_resolved').filter((event) => event.requestId === request.requestId).length;
      const secondResponse = await late.send({ type: 'extension_ui_response', sessionId, requestId: request.requestId, confirmed: false });
      await sleep(300);
      const afterLateResolution = allEvents(late, 'extension_ui_resolved').filter((event) => event.requestId === request.requestId).length;
      assert(secondResponse.success === true && afterLateResolution === beforeLateResolution, 'a later answer is ignored without a second dismissal');
    }
    const dialogResult = await dialogPromise;
    assert(dialogResult.success === true, 'the extension bash request settles after the first dialog answer');

    section('Archive fan-out, unarchive, and explicit soft open');
    const archiveResponse = await first.send({ type: 'archive_session', sessionIds: [sessionId], folderPath: projectDir, archived: true });
    const archivedClosed = await waitFor(
      () =>
        [first, late].every((probe) => allEvents(probe, 'session_closed').some((event) => event.sessionId === sessionId && event.reason === 'archived')),
      8_000,
    );
    assert(archiveResponse.success === true, 'archive succeeds for the shared session');
    assert(archivedClosed, 'archive closes every connected observer with reason archived');
    await sleep(400);
    const archiveNotices = [first, late].map((probe) => allEvents(probe, 'session_archived').filter((event) => event.sessionId === sessionId));
    if (!archiveNotices.every((events) => events.some((event) => event.archived === true))) {
      log('archive notices:', JSON.stringify(archiveNotices));
      log('late observer tail at archive:', JSON.stringify(late.events.slice(-10).map((entry) => entry.event)));
    }
    assert(
      archiveNotices.every((events) => events.some((event) => event.archived === true)),
      'archive notification reaches every observer',
    );

    const unarchiveResponse = await first.send({ type: 'archive_session', sessionIds: [sessionId], folderPath: projectDir, archived: false });
    assert(unarchiveResponse.success === true, 'unarchive clears the archived flag');
    const beforeSoftOpen = first.events.length;
    await sleep(300);
    assert(
      !first.events.slice(beforeSoftOpen).some((entry) => ['session_restore', 'session_opened'].includes(entry.event.type)),
      'unarchive does not reopen the session automatically',
    );
    const softOpen = await openSession(first, sessionId, projectDir);
    assert(softOpen.success === true, 'an explicit soft open reattaches after unarchive');

    section('Archived restore rejection and stale localStorage boot');
    // Archive again, then issue an open from a fresh probe. This is the wire
    // path used by a stale browser restore set.
    await first.send({ type: 'archive_session', sessionIds: [sessionId], folderPath: projectDir, archived: true });
    const stale = new WsProbe(port, `ownership-stale-${randomUUID().slice(0, 8)}`);
    await stale.open();
    const staleOpen = await openSession(stale, sessionId, projectDir);
    assert(staleOpen.success === false && staleOpen.error === 'session_archived', 'an archived open rejects with session_archived');
    stale.close();

    // Bring the browser to the session while it is live. The deep link goes
    // through the real route. The next archive broadcast then leaves a stale
    // restore entry to exercise the boot rejection path.
    await first.send({ type: 'archive_session', sessionIds: [sessionId], folderPath: projectDir, archived: false });
    await browserA.browser(['open', baseUrl]);
    await browserA.wait(2_500);
    await browserA.installSocketProbe();
    await browserA.evalBrowser(`(() => { const path = ${JSON.stringify(projectDir)}; const row = document.querySelector('[data-folder-path="' + path + '"]'); row?.closest('button')?.click(); return Boolean(row); })()`);
    await browserA.wait(1_000);
    const dashboardSnapA = await snapshotBrowserRefs(browserA.browser);
    log('browser A dashboard snapshot:', dashboardSnapA.slice(0, 1800));
    const sessionRefA = firstRefFor(dashboardSnapA, /Seed observer prompt/);
    if (sessionRefA) await browserA.browser(['click', sessionRefA]);
    let browserAReady = await waitFor(() => browserA.evalBrowser(`Boolean(document.querySelector('textarea[aria-label="Message"]'))`), 10_000, 250);
    log('browser A open sends:', JSON.stringify(await browserA.sentLog("m.type === 'open_session'")));
    if (!browserAReady) {
      log('browser A page errors:', (await browserA.browser(['errors'], { allowFailure: true })).stdout.trim());
      log('browser A console:', await browserA.pageConsole(8));
    }
    log('browser A URL:', (await browserA.browser(['get', 'url'])).stdout.trim());
    await browserA.wait(300);
    const snapA = await snapshotBrowserRefs(browserA.browser);
    log('browser A snapshot:', snapA.slice(0, 1800));
    if (!browserAReady) log('browser A body:', String(await browserA.evalBrowser('document.body.innerText')).slice(0, 1200));
    const composerRef = firstRefFor(snapA, /Message/);
    assert(Boolean(composerRef), 'agent-browser snapshot exposes the session composer');
    if (composerRef) {
      await browserA.browser(['fill', composerRef, 'browser observer prompt']);
      const afterFill = await browserA.evalBrowser(`document.querySelector('textarea[aria-label="Message"]')?.value ?? ''`);
      assert(afterFill === 'browser observer prompt', 'browser observer can fill the shared composer');
    }
    const noOwnershipUi = await browserA.evalBrowser(`!document.body.innerText.match(/Take Over|session owned|remote owner/i)`);
    assert(noOwnershipUi === true, 'PWA has no ownership or takeover UI');

    // Re-open through the protocol so a browser tab can observe the next
    // archive, then force a stale restore entry and reload.
    await sleep(200);
    await browserB.browser(['open', baseUrl]);
    await browserB.wait(2_500);
    await browserB.installSocketProbe();
    await browserB.evalBrowser(`(() => { const path = ${JSON.stringify(projectDir)}; const row = document.querySelector('[data-folder-path="' + path + '"]'); row?.closest('button')?.click(); return Boolean(row); })()`);
    await browserB.wait(1_000);
    const dashboardSnapB = await snapshotBrowserRefs(browserB.browser);
    log('browser B dashboard snapshot:', dashboardSnapB.slice(0, 1800));
    const sessionRefB = firstRefFor(dashboardSnapB, /Seed observer prompt/);
    if (sessionRefB) await browserB.browser(['click', sessionRefB]);
    let browserBReady = await waitFor(() => browserB.evalBrowser(`Boolean(document.querySelector('textarea[aria-label="Message"]'))`), 10_000, 250);
    log('browser B open sends:', JSON.stringify(await browserB.sentLog("m.type === 'open_session'")));
    if (!browserBReady) {
      log('browser B page errors:', (await browserB.browser(['errors'], { allowFailure: true })).stdout.trim());
      log('browser B console:', await browserB.pageConsole(8));
    }
    log('browser B URL:', (await browserB.browser(['get', 'url'])).stdout.trim());
    await browserB.wait(300);
    const snapB = await snapshotBrowserRefs(browserB.browser);
    log('browser B snapshot:', snapB.slice(0, 1800));
    if (!browserBReady) log('browser B body:', String(await browserB.evalBrowser('document.body.innerText')).slice(0, 1200));
    const browserBComposer = firstRefFor(snapB, /Message/);
    assert(Boolean(browserBComposer), 'second browser observer reaches the session surface');
    if (browserBComposer) {
      await browserB.browser(['fill', browserBComposer, 'browser B prompt']);
      await browserB.browser(['press', 'Enter']);
    }
    await sleep(500);
    await first.send({ type: 'archive_session', sessionIds: [sessionId], folderPath: projectDir, archived: true });
    await browserA.evalBrowser(`localStorage.setItem('pimote:activeSessions', JSON.stringify([{sessionId:${JSON.stringify(sessionId)}, folderPath:${JSON.stringify(projectDir)}}])); true`);
    await browserA.browser(['open', baseUrl]);
    await sleep(1_500);
    const restoreEntry = await browserA.evalBrowser(`localStorage.getItem('pimote:activeSessions')`);
    assert(!String(restoreEntry ?? '').includes(sessionId), 'stale archived session is removed from localStorage after boot rejection');

    section('Voice call holder and forced transfer');
    if (!modelAvailable) {
      soft(false, 'voice holder checks environment-bounded because the sandbox has no local model catalog');
    } else {
      // Unarchive and open one observer for the voice seam.
      await first.send({ type: 'archive_session', sessionIds: [sessionId], folderPath: projectDir, archived: false });
      const voiceOpen = await openSession(first, sessionId, projectDir);
      assert(voiceOpen.success === true, 'voice holder session reopens after explicit unarchive');
      const bindA = await first.send({ type: 'call_bind', sessionId, force: false });
      const bindB = await late.send({ type: 'call_bind', sessionId, force: false });
      assert(bindA.success === true, 'first caller becomes the session call holder');
      assert(bindB.success === false && bindB.error === 'call_bind_failed_owned', 'second caller is rejected while the call is active');
      const firstClosedBeforeTransfer = allEvents(first, 'session_closed').filter((event) => event.sessionId === sessionId).length;
      const forced = await late.send({ type: 'call_bind', sessionId, force: true });
      const displaced = await waitFor(() => allEvents(first, 'call_ended').some((event) => event.sessionId === sessionId && event.reason === 'displaced'), 5_000);
      assert(forced.success === true && displaced, 'forced transfer moves the holder and notifies only the old caller');
      const firstClosedAfterTransfer = allEvents(first, 'session_closed').filter((event) => event.sessionId === sessionId).length;
      assert(firstClosedBeforeTransfer === firstClosedAfterTransfer, 'voice transfer does not close the session');
      await late.send({ type: 'call_end', sessionId });
    }

    section('External pi conflict and ownership vocabulary removal');
    // The detector keys off cwd + a pi-coding-agent token. This child is not a
    // descendant of the pimote server, so it models an external process.
    external = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', 'pi-coding-agent'], { cwd: projectDir, stdio: 'ignore' });
    await sleep(250);
    await first.send({ type: 'close_session', sessionId });
    await first.send({ type: 'archive_session', sessionIds: [sessionId], folderPath: projectDir, archived: false });
    const conflictOpen = await openSession(first, sessionId, projectDir);
    const conflict = await waitFor(() => allEvents(first, 'session_conflict').some((event) => event.sessionId === sessionId), 5_000);
    assert(conflictOpen.success === true && conflict, 'an external pi process produces session_conflict on open');
    const conflictEvent = allEvents(first, 'session_conflict').find((event) => event.sessionId === sessionId);
    assert(conflictEvent && !('remoteSessions' in conflictEvent), 'session_conflict has no remote-session ownership records');

    await browserA.browser(['screenshot', join(shotsDir, 'session-ownership.png')]).catch(() => {});
    console.log(`[session-observers] screenshot: ${join(shotsDir, 'session-ownership.png')}`);
  } finally {
    try {
      external?.kill('SIGTERM');
    } catch {
      // already gone
    }
    first?.close();
    second?.close();
    late?.close();
    await browserA.browser(['close'], { allowFailure: true }).catch(() => {});
    await browserB.browser(['close'], { allowFailure: true }).catch(() => {});
    await stopPimote(child);
    if (speechmuxServer) await new Promise((resolve) => speechmuxServer.close(() => resolve()));
  }

  console.log(`[session-observers] ${stats.failures === 0 ? 'all hard assertions passed' : `${stats.failures} hard assertion(s) failed`}; ${softFailuresCount()} environment-bounded`);
  process.exitCode = stats.failures > 0 ? 1 : 0;
}

function softFailuresCount() {
  return softFailures.length;
}

main().catch((error) => {
  console.error('[session-observers] unexpected failure:', error);
  process.exitCode = 1;
});
