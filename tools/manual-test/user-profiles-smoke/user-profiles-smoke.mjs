#!/usr/bin/env node
// End-to-end smoke for per-user server-side open-session state.
//
// Boots a real pimote server with fabricated sessions and drives both the
// wire (user-aware WsProbes) and the real PWA (four agent-browser sessions)
// through the topic's journeys: one shared open-session set per user across
// devices, cross-user isolation, user-level detach, the settings User pane
// (adopt chip, rename to a fresh user, mobile header Save), migration
// adopt-once and stale-browser reconcile-down, restart survival, boot GC of
// dead entries, the /new surface (session-view control, composer command,
// server guard for forwarded prompts), and the shared rekey relink (every
// holder follows a rekey, watcher or not).
//
// Optional environment variables:
//   UP_SHOTS=/tmp/dir  keep browser screenshots outside the disposable sandbox
//   UP_KEEP=1          preserve the sandbox on a passing run

import { copyFile, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';

import { makeReporter } from '../lib/report.mjs';
import { freePort, gitInit, seedSession, startPimote, stopPimote, waitForListening } from '../lib/sandbox.mjs';
import { seedSessionDir } from '../lib/session-dir.mjs';
import { WsProbe } from '../lib/ws-probe.mjs';
import { makeBrowserHelpers } from '../lib/browser.mjs';

const REAL_AGENT_DIR = join(process.env.HOME ?? '', '.pi', 'agent');
const { assert, section, log, stats, softFailures } = makeReporter('user-profiles');

const PROJECT_NAME = 'pilot';
const T_SHARED = 'Shared sync seed';
const T_ADOPT = 'Adopt me seed';
const T_STALE = 'Stale extra seed';
const T_GC = 'Gc fodder seed';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** user_sessions_changed events received after `since` (ms epoch). */
function burstsSince(probe, since) {
  return probe.events.filter((entry) => entry.at > since && entry.event.type === 'user_sessions_changed');
}

async function waitFor(fact, timeoutMs = 10_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fact()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function summaries(probe) {
  const response = await probe.send({ type: 'list_users' });
  if (!response.success) throw new Error(`list_users failed: ${JSON.stringify(response)}`);
  return response.data?.users ?? [];
}

async function summaryFor(probe, name) {
  return (await summaries(probe)).find((entry) => entry.name === name) ?? null;
}

async function snapshotRefs(browser) {
  return (await browser(['snapshot', '-i'])).stdout ?? '';
}

/** Expand the project row and return whether the named session entry shows
 *  the active dot (size-2 variant — the row count chip is size-1.5). Session
 *  entries render in the block below the row trigger, so the search is by
 *  unique entry text across the page's buttons (single-fixture dashboard). */
function sessionDotExpr(title) {
  return `(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(${JSON.stringify(title)}));
    if (!btn) return 'NO_ENTRY';
    return Boolean(btn.querySelector('.bg-status-connected.size-2'));
  })()`;
}

/** Count session entries carrying the active dot. */
function dottedEntryCountExpr() {
  return `(() => {
    return Array.from(document.querySelectorAll('button')).filter((b) => b.querySelector('.bg-status-connected.size-2')).length;
  })()`;
}

function clickEntryExpr(title) {
  return `(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(${JSON.stringify(title)}));
    if (!btn) return 'NO_ENTRY';
    btn.click();
    return 'clicked';
  })()`;
}

async function revealAndExpand(browser, projectPath) {
  const reveal = `(() => {
    const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(projectPath)} + '"]');
    if (!s) return false;
    s.scrollIntoView({ block: 'center' });
    return true;
  })()`;
  for (let i = 0; i < 12; i++) {
    if ((await browser.evalBrowser(reveal)) === true) break;
    await browser.evalBrowser(`(() => { const sc = document.querySelector('[data-folder-path]')?.closest('.overflow-y-auto'); if (sc) sc.scrollTop += sc.clientHeight * 0.6; return true; })()`);
    await sleep(300);
  }
  await browser.evalBrowser(
    `(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(projectPath)} + '"]'); s?.closest('button')?.click(); return true; })()`,
  );
  await sleep(700);
}

/** Seed a device identity (and optionally a migration seed) and reload. */
async function claimUser(browser, baseUrl, userName, seedSessions) {
  await browser.browser(['open', baseUrl]);
  await browser.wait(1_200);
  await browser.evalBrowser(`(() => {
    localStorage.setItem('pimote:user', ${JSON.stringify(userName)});
    localStorage.setItem('pimote:activeSessions', ${JSON.stringify(JSON.stringify(seedSessions ?? []))});
    return true;
  })()`);
  await browser.browser(['open', baseUrl]);
  await browser.wait(2_000);
}

async function openSettings(browser) {
  const snap = await snapshotRefs(browser.browser);
  const ref = firstRefFor(snap, /Open Settings/);
  if (ref) {
    await browser.browser(['click', ref]);
  } else {
    await browser.evalBrowser(`(() => { const b = document.querySelector('button[aria-label="Open Settings"]'); b?.click(); return Boolean(b); })()`);
  }
  await browser.wait(1_000);
  await browser.evalBrowser(
    `(() => { const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((t) => (t.textContent ?? '').trim().startsWith('User')); tab?.click(); return true; })()`,
  );
  await browser.wait(800);
}

function firstRefFor(snapshot, pattern) {
  const line = snapshot.split('\n').find((row) => pattern.test(row));
  const ref = line?.match(/\[ref=(e\d+)\]/i)?.[1];
  return ref ? `@${ref}` : null;
}

async function main() {
  console.log('[user-profiles] per-user open-session state smoke');
  const sandboxHome = await mkdtemp(join(tmpdir(), 'user-profiles-smoke-'));
  const configDir = join(sandboxHome, '.config', 'pimote');
  const agentDir = join(sandboxHome, 'agent');
  const projectDir = join(sandboxHome, PROJECT_NAME);
  await mkdir(configDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await gitInit(projectDir, 'main');

  try {
    const { readFile } = await import('node:fs/promises');
    const models = JSON.parse(await readFile(join(REAL_AGENT_DIR, 'models.json'), 'utf8'));
    if (models.providers?.jetson?.models?.length) await copyFile(join(REAL_AGENT_DIR, 'models.json'), join(agentDir, 'models.json'));
  } catch {
    // No host model catalog; sessions fall back to pi's built-in defaults.
  }

  const sessionsRoot = join(agentDir, 'sessions');
  const sessionDir = seedSessionDir(sessionsRoot, projectDir);
  const sharedId = await seedSession(sessionsRoot, projectDir, T_SHARED, `${T_SHARED} answer`);
  const adoptId = await seedSession(sessionsRoot, projectDir, T_ADOPT, `${T_ADOPT} answer`);
  const staleId = await seedSession(sessionsRoot, projectDir, T_STALE, `${T_STALE} answer`);
  const gcId = await seedSession(sessionsRoot, projectDir, T_GC, `${T_GC} answer`);

  const port = await freePort();
  const configPath = join(configDir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify(
      { roots: [projectDir], port, bufferSize: 100, updateCheck: false },
      null,
      2,
    ),
  );
  const logPath = join(sandboxHome, 'pimote.log');
  const shotsDir = process.env.UP_SHOTS ? pathResolve(process.env.UP_SHOTS) : sandboxHome;
  await mkdir(shotsDir, { recursive: true });

  log('sandbox HOME =', sandboxHome);
  log('project      =', projectDir);
  log('sessions     =', { sharedId, adoptId, staleId, gcId });
  log('port         =', port);

  let child;
  let probes = [];
  const track = (probe) => {
    probes.push(probe);
    return probe;
  };
  const browserToken = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const browserA = makeBrowserHelpers({ session: `up-a-${browserToken}`, log });
  const browserB = makeBrowserHelpers({ session: `up-b-${browserToken}`, log });
  const browserM = makeBrowserHelpers({ session: `up-m-${browserToken}`, log });
  const browserN = makeBrowserHelpers({ session: `up-n-${browserToken}`, log });
  const baseUrl = `http://127.0.0.1:${port}`;

  const stop = async () => {
    if (child && child.exitCode === null) await stopPimote(child);
  };
  const start = async () => {
    child = startPimote({ port, sandboxHome, agentDir, configPath, logPath });
    await waitForListening(child, port, logPath);
  };

  try {
    await start();
    const defaultProbe = track(new WsProbe(port, `up-default-${Math.random().toString(36).slice(2, 8)}`));
    await defaultProbe.open();

    // ============================================================
    section('W — wire contract: burst, no-echo broadcast, user-level detach');
    // ============================================================
    const probeA1 = track(new WsProbe(port, `up-alice-burst-${Math.random().toString(36).slice(2, 8)}`, 'alice'));
    await probeA1.open();
    const aliceBurst = await probeA1.waitForEvent('user_sessions_changed', () => true, 8_000);
    assert(aliceBurst.fresh === true && Array.isArray(aliceBurst.sessions) && aliceBurst.sessions.length === 0, 'fresh user connect burst: fresh=true with an empty set');
    const defaultBurst = await defaultProbe.waitForEvent('user_sessions_changed', () => true, 8_000);
    assert(defaultBurst.fresh === true, 'unnamed connect rides the untouched default profile (fresh=true)');

    const probeA2 = track(new WsProbe(port, `up-alice-open-${Math.random().toString(36).slice(2, 8)}`, 'alice'));
    await probeA2.open();
    await probeA2.waitForEvent('user_sessions_changed', () => true, 8_000);
    const beforeOpen = Date.now();
    const openShared = await probeA2.send({ type: 'open_session', sessionId: sharedId, folderPath: projectDir });
    assert(openShared.success === true, 'alice opens the shared session');
    const linked = await probeA1.waitForEvent('user_sessions_changed', (e) => e.sessions.some((s) => s.sessionId === sharedId), 8_000);
    assert(linked && linked.fresh === false, `the open links the profile and reaches alice's other connection`);
    assert(burstsSince(probeA2, beforeOpen).length === 0, 'the acting connection receives no echo');

    const probeB1 = track(new WsProbe(port, `up-bob-${Math.random().toString(36).slice(2, 8)}`, 'bob'));
    await probeB1.open();
    await probeB1.waitForEvent('user_sessions_changed', () => true, 8_000);
    const openSharedBob = await probeB1.send({ type: 'open_session', sessionId: sharedId, folderPath: projectDir });
    assert(openSharedBob.success === true, 'bob opens the same session');
    let users = await summaries(defaultProbe);
    assert(users.find((u) => u.name === 'alice')?.sessionCount === 1, 'list_users: alice holds 1 session');
    assert(users.find((u) => u.name === 'bob')?.sessionCount === 1, 'list_users: bob holds 1 session');
    assert(!users.some((u) => u.name === 'default'), 'connecting alone never creates the default key');

    const beforeDetach = Date.now();
    const detach = await probeA2.send({ type: 'detach_session', sessionId: sharedId });
    assert(detach.success === true, 'detach_session answers success');
    const emptied = await probeA1.waitForEvent('user_sessions_changed', (e) => e.fresh === false && e.sessions.length === 0, 8_000);
    assert(emptied, `detach drops the session from the user's other live connection`);
    assert(burstsSince(probeB1, beforeDetach).length === 0, `another user's connection receives no detach broadcast`);
    users = await summaries(defaultProbe);
    assert(users.find((u) => u.name === 'alice')?.sessionCount === 0, `alice's link is gone (empty key kept)`);
    assert(users.find((u) => u.name === 'bob')?.sessionCount === 1, `bob's link to the same session survives the detach`);
    const bobMeta = await probeB1.send({ type: 'get_session_meta', sessionId: sharedId });
    assert(bobMeta.success === true, 'bob still holds the live session after alice detached');

    // Socket death never mutates the profile (sticky membership).
    const bobCountBeforeClose = (await summaryFor(defaultProbe, 'bob'))?.sessionCount;
    probeB1.close();
    await sleep(400);
    assert((await summaryFor(defaultProbe, 'bob'))?.sessionCount === bobCountBeforeClose, 'socket death leaves profile entries untouched');

    // ============================================================
    section('B — two browsers on one user share one set');
    // ============================================================
    await claimUser(browserA, baseUrl, 'alice');
    await claimUser(browserB, baseUrl, 'alice');
    const mirrorA = await browserA.evalBrowser(`localStorage.getItem('pimote:activeSessions')`);
    const mirrorB = await browserB.evalBrowser(`localStorage.getItem('pimote:activeSessions')`);
    assert(mirrorA === null && mirrorB === null, 'both devices clear the local mirror after the first burst');

    await revealAndExpand(browserA, projectDir);
    const entryClicked = await browserA.evalBrowser(clickEntryExpr(T_SHARED));
    if (entryClicked !== 'clicked') {
      log('entry click result:', entryClicked);
      log('row block text:', String(await browserA.evalBrowser(`(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(projectDir)} + '"]'); return s?.closest('.group')?.innerText?.slice(0, 600) ?? 'NO_BLOCK'; })()`)));
      log('browser A console:', await browserA.pageConsole(8));
    }
    assert(entryClicked === 'clicked', `alice's first device opens the shared session from the dashboard`);
    const composerA = await waitFor(() => browserA.evalBrowser(`Boolean(document.querySelector('textarea[aria-label="Message"]'))`), 15_000, 300);
    assert(composerA === true, 'the session view mounts on the first device');

    const dotOnB = await waitFor(async () => (await browserB.evalBrowser(sessionDotExpr(T_SHARED))) === true, 12_000, 400);
    if (!dotOnB) {
      log('browser B row state:', await browserB.evalBrowser(sessionDotExpr(T_SHARED)));
      log('browser B row block text:', String(await browserB.evalBrowser(`(() => { const s = document.querySelector('[data-folder-path="' + ${JSON.stringify(projectDir)} + '"]'); return s?.closest('.group')?.innerText?.slice(0, 600) ?? 'NO_BLOCK'; })()`)));
    }
    assert(dotOnB === true, `the second device's dashboard lights the session the first device opened`);
    const midBurst = await probeA1.waitForEvent('user_sessions_changed', (e) => e.fresh === false && e.sessions.length === 1 && e.sessions[0].sessionId === sharedId, 8_000);
    assert(midBurst.sessions[0].sessionId === sharedId, 'the browser open reached the profile store (probe sees the new set)');

    // ============================================================
    section('D — detach from one device drops it from the others, not from other users');
    // ============================================================
    await revealAndExpand(browserB, projectDir);
    const bEntryClicked = await browserB.evalBrowser(clickEntryExpr(T_SHARED));
    assert(bEntryClicked === 'clicked', 'the second device navigates into the shared session');
    const composerB = await waitFor(() => browserB.evalBrowser(`Boolean(document.querySelector('textarea[aria-label="Message"]'))`), 15_000, 300);
    assert(composerB === true, 'the second device reaches the session surface');

    // bob re-attaches so the slot stays live across alice's detach.
    const probeB2 = track(new WsProbe(port, `up-bob-attach-${Math.random().toString(36).slice(2, 8)}`, 'bob'));
    await probeB2.open();
    await probeB2.waitForEvent('user_sessions_changed', () => true, 8_000);
    await probeB2.send({ type: 'open_session', sessionId: sharedId, folderPath: projectDir });

    const closeClicked = await browserB.evalBrowser(
      `(() => { const x = document.querySelector('button.bg-primary span[title="Close session"]'); if (!x) return false; x.click(); return true; })()`,
    );
    assert(closeClicked === true, 'the viewed-session chip exposes Close session');
    const beforeBrowserDetach = Date.now();
    const backOnDashboard = await waitFor(() => browserB.evalBrowser(`document.body.innerText.includes('New session')`), 10_000, 300);
    assert(backOnDashboard === true, 'closing returns the second device to the dashboard');
    const dotGoneOnB = await waitFor(async () => (await browserB.evalBrowser(sessionDotExpr(T_SHARED))) === false, 10_000, 300);
    assert(dotGoneOnB === true, 'the closing device drops the session from its own set');
    // The first device was viewing the session; the user-level detach exits
    // its view and drops the entry with no local action.
    const aLanded = await waitFor(() => browserA.evalBrowser(`document.body.innerText.includes('New session')`), 10_000, 300);
    assert(aLanded === true, `the user's other device exits the detached session view on its own`);
    const dotGoneOnA = await waitFor(async () => (await browserA.evalBrowser(sessionDotExpr(T_SHARED))) === false, 10_000, 300);
    if (!dotGoneOnA) log('browser A row state:', await browserA.evalBrowser(sessionDotExpr(T_SHARED)));
    assert(dotGoneOnA === true, `the user's other device drops the session without any local action`);
    users = await summaries(defaultProbe);
    assert(users.find((u) => u.name === 'alice')?.sessionCount === 0, `alice's profile is empty after the browser detach`);
    assert(users.find((u) => u.name === 'bob')?.sessionCount === 1, `bob's profile still holds the session`);
    assert(burstsSince(probeB2, beforeBrowserDetach).length === 0, `bob's live connection received nothing during alice's detach`);

    // ============================================================
    section('S — settings User pane: adopt a profile chip (desktop)');
    // ============================================================
    await openSettings(browserA);
    const paneText = String(await browserA.evalBrowser(`document.querySelector('[role="dialog"]')?.innerText ?? document.body.innerText`));
    assert(paneText.includes('User name'), 'the pane shows the User name field');
    assert(paneText.toLowerCase().includes('profiles on this server'), 'the pane lists profiles on this server');
    assert(paneText.includes('alice') && paneText.includes('bob'), 'the chips include alice and bob');
    const countsOk = await browserA.evalBrowser(`(() => {
      const chips = Array.from(document.querySelectorAll('[role="dialog"] button'));
      const a = chips.find((c) => (c.textContent ?? '').trim().startsWith('alice'));
      const b = chips.find((c) => (c.textContent ?? '').trim().startsWith('bob'));
      return Boolean(a && (a.textContent ?? '').includes('0 sessions') && b && (b.textContent ?? '').includes('1 session'));
    })()`);
    assert(countsOk === true, 'chips carry per-profile session counts (alice 0, bob 1)');
    const currentMarked = await browserA.evalBrowser(`(() => {
      const chips = Array.from(document.querySelectorAll('[role="dialog"] button'));
      const a = chips.find((c) => (c.textContent ?? '').trim().startsWith('alice'));
      return Boolean(a && a.className.includes('border-ring'));
    })()`);
    assert(currentMarked === true, 'the current user\'s chip is marked current');

    const adoptClicked = await browserA.evalBrowser(`(() => {
      const chips = Array.from(document.querySelectorAll('[role="dialog"] button')).filter((b) => (b.textContent ?? '').trim().startsWith('bob'));
      if (!chips.length) return false;
      chips[0].click();
      return true;
    })()`);
    assert(adoptClicked === true, 'clicking the bob chip adopts it into the input');
    const inputValue = await browserA.evalBrowser(`document.querySelector('input[aria-label="User name"]')?.value ?? ''`);
    assert(inputValue === 'bob', 'the input carries the adopted name');
    const dirtyShown = await waitFor(() => browserA.evalBrowser(`document.body.innerText.includes('Unsaved changes')`), 5_000, 300);
    assert(dirtyShown === true, 'the dirty marker appears (Unsaved changes hint)');
    const knownConsequence = await browserA.evalBrowser(`document.body.innerText.includes('replaces the current one')`);
    assert(knownConsequence === true, 'known-profile consequence copy matches the mock');
    const saveDisabled = await browserA.evalBrowser(`(() => {
      const f = document.querySelector('footer');
      const btn = f ? Array.from(f.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Save')) : null;
      return btn ? btn.disabled : 'NO_SAVE';
    })()`);
    assert(saveDisabled === false, 'footer Save enables once the name changes');

    await browserA.evalBrowser(`(() => {
      const f = document.querySelector('footer');
      const btn = Array.from(f.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Save'));
      btn?.click();
      return true;
    })()`);
    const switchedToBob = await waitFor(async () => (await browserA.evalBrowser(`localStorage.getItem('pimote:user')`)) === 'bob', 10_000, 300);
    assert(switchedToBob, 'save persists the adopted user and reconnects');
    const dotAfterSwitch = await waitFor(async () => (await browserA.evalBrowser(sessionDotExpr(T_SHARED))) === true, 12_000, 400);
    assert(dotAfterSwitch === true, `the reconnect loads the adopted profile's set (bob's session appears)`);
    const bobChipCurrent = await waitFor(async () => {
      return (
        (await browserA.evalBrowser(`(() => {
          const chips = Array.from(document.querySelectorAll('[role="dialog"] button'));
          const b = chips.find((c) => (c.textContent ?? '').trim().startsWith('bob'));
          return Boolean(b && b.className.includes('border-ring'));
        })()`)) === true
      );
    }, 8_000, 400);
    assert(bobChipCurrent === true, 'the chips refresh and mark the adopted profile current');

    // ============================================================
    section('S — rename to a brand-new user starts empty');
    // ============================================================
    await browserA.evalBrowser(
      `(() => { const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((t) => (t.textContent ?? '').trim().startsWith('User')); tab?.click(); return true; })()`,
    );
    await browserA.wait(400);
    const filled = await browserA.fillSelector('input[aria-label="User name"]', 'carol');
    assert(filled === true, 'the name field accepts a brand-new user name');
    const freshConsequence = await waitFor(() => browserA.evalBrowser(`document.body.innerText.includes('starts empty')`), 5_000, 300);
    assert(freshConsequence === true, 'unknown-profile consequence copy says the device list starts empty');
    await browserA.evalBrowser(`(() => {
      const f = document.querySelector('footer');
      const btn = Array.from(f.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Save'));
      btn?.click();
      return true;
    })()`);
    const carolConnected = await waitFor(async () => (await browserA.evalBrowser(`localStorage.getItem('pimote:user')`)) === 'carol', 10_000, 300);
    assert(carolConnected === true, 'the deliberate switch reconnects as the new user');
    const emptyList = await waitFor(async () => (await browserA.evalBrowser(dottedEntryCountExpr())) === 0, 12_000, 400);
    assert(emptyList === true, `the fresh profile starts empty — bob's session did not follow the device`);
    users = await summaries(defaultProbe);
    assert(!users.some((u) => u.name === 'carol'), 'a switched-to profile with no opens creates no server key');

    // ============================================================
    section('S — mobile header Save switches profiles below the mobile breakpoint');
    // ============================================================
    await browserM.browser(['set', 'viewport', '390', '760']);
    await claimUser(browserM, baseUrl, 'alice');
    await openSettings(browserM);
    await browserM.fillSelector('input[aria-label="User name"]', 'bob');
    const headerSave = await browserM.evalBrowser(`(() => {
      const btn = document.querySelector('header button[type="submit"]');
      if (!btn) return 'NO_HEADER_SAVE';
      return btn.disabled ? 'DISABLED' : 'ENABLED';
    })()`);
    assert(headerSave === 'ENABLED', 'the mobile header carries an enabled Save');
    const footerGone = await browserM.evalBrowser(`!document.querySelector('footer button[type="submit"]')`);
    assert(footerGone === true, 'the desktop footer Save is absent on mobile');
    await browserM.evalBrowser(`document.querySelector('header button[type="submit"]')?.click()`);
    const mSwitched = await waitFor(async () => (await browserM.evalBrowser(`localStorage.getItem('pimote:user')`)) === 'bob', 10_000, 300);
    assert(mSwitched === true, 'saving from the header persists the user');
    const mDotted = await waitFor(async () => {
      const count = await browserM.evalBrowser(dottedEntryCountExpr());
      return typeof count === 'number' && count >= 1;
    }, 12_000, 400);
    assert(mDotted === true, `the reconnect loads bob's set on the mobile device`);
    await browserM.browser(['screenshot', join(shotsDir, 'mobile-user-pane.png')], { allowFailure: true }).catch(() => {});

    // ============================================================
    section('M — migration: a fresh profile adopts the device\'s local set');
    // ============================================================
    await claimUser(browserB, baseUrl, 'dave', [{ sessionId: adoptId, folderPath: projectDir }]);
    const adoptDot = await waitFor(async () => (await browserB.evalBrowser(sessionDotExpr(T_ADOPT))) === true, 12_000, 400);
    if (!adoptDot) log('browser B row state:', await browserB.evalBrowser(sessionDotExpr(T_ADOPT)));
    assert(adoptDot === true, 'the pre-existing local session is opened into the fresh profile');
    assert((await summaryFor(defaultProbe, 'dave'))?.sessionCount === 1, `list_users: the adopted session landed in dave's profile`);
    const adoptMirror = await browserB.evalBrowser(`localStorage.getItem('pimote:activeSessions')`);
    assert(adoptMirror === null, 'the local mirror clears after adoption');

    // ============================================================
    section('M — a stale second browser drops extras instead of resurrecting');
    // ============================================================
    // dave opens then detaches the stale-extra session server-side, so the
    // profile truth is [adoptId] while the second device still seeds both.
    const probeD1 = track(new WsProbe(port, `up-dave-cycle-${Math.random().toString(36).slice(2, 8)}`, 'dave'));
    await probeD1.open();
    await probeD1.send({ type: 'open_session', sessionId: staleId, folderPath: projectDir });
    await probeD1.send({ type: 'detach_session', sessionId: staleId });
    assert((await summaryFor(defaultProbe, 'dave'))?.sessionCount === 1, `dave's profile is [adoptId] before the stale browser connects`);

    await browserB.evalBrowser(`(() => {
      localStorage.setItem('pimote:activeSessions', JSON.stringify([{ sessionId: ${JSON.stringify(adoptId)}, folderPath: ${JSON.stringify(projectDir)} }, { sessionId: ${JSON.stringify(staleId)}, folderPath: ${JSON.stringify(projectDir)} }]));
      return true;
    })()`);
    await browserB.browser(['open', baseUrl]);
    await browserB.wait(2_500);
    const staleOpened = await waitFor(async () => (await browserB.evalBrowser(sessionDotExpr(T_STALE))) === true, 6_000, 300);
    assert(staleOpened === false, 'the stale extra is never opened');
    assert((await summaryFor(defaultProbe, 'dave'))?.sessionCount === 1, 'the closed session did not resurrect into the profile');
    const staleMirror = await browserB.evalBrowser(`localStorage.getItem('pimote:activeSessions')`);
    assert(staleMirror === null, 'the stale mirror still clears');

    // ============================================================
    section('N — session-view New session control moves the set everywhere');
    // ============================================================
    // nia views the shared session; her second connection watches the
    // profile; bob holds the same session live as another user.
    await claimUser(browserN, baseUrl, 'nia');
    const probeNia = track(new WsProbe(port, `up-nia-burst-${Math.random().toString(36).slice(2, 8)}`, 'nia'));
    await probeNia.open();
    await probeNia.waitForEvent('user_sessions_changed', () => true, 8_000);
    const probeBob3 = track(new WsProbe(port, `up-bob-hold-${Math.random().toString(36).slice(2, 8)}`, 'bob'));
    await probeBob3.open();
    await probeBob3.waitForEvent('user_sessions_changed', () => true, 8_000);
    await probeBob3.send({ type: 'open_session', sessionId: sharedId, folderPath: projectDir });

    await revealAndExpand(browserN, projectDir);
    const niaEntryClicked = await browserN.evalBrowser(clickEntryExpr(T_SHARED));
    assert(niaEntryClicked === 'clicked', 'nia opens the shared session from the dashboard');
    const niaComposer = await waitFor(() => browserN.evalBrowser(`Boolean(document.querySelector('textarea[aria-label="Message"]'))`), 15_000, 300);
    assert(niaComposer === true, 'nia reaches the session surface');

    const beforeControl = Date.now();
    const controlClicked = await browserN.evalBrowser(
      `(() => { const c = document.querySelector('button[title^="Starts a fresh session"]'); if (!c) return 'NO_CONTROL'; c.click(); return 'clicked'; })()`,
    );
    assert(controlClicked === 'clicked', 'the session-view pill bar exposes the New session control');
    let freshPath = null;
    const freshLanded = await waitFor(async () => {
      const path = await browserN.evalBrowser(`location.pathname`);
      freshPath = typeof path === 'string' && path.startsWith('/sessions/') && !path.includes(sharedId) ? path : null;
      return Boolean(freshPath);
    }, 15_000, 300);
    assert(freshLanded === true, `the control lands nia in a fresh session (got ${JSON.stringify(freshPath ?? 'timeout')})`);
    const freshId = String(freshPath ?? '').split('/').pop() ?? '';
    assert(freshId !== sharedId && freshId.length > 0, 'the fresh session has its own id');
    const blankBody = await browserN.evalBrowser(`!document.body.innerText.includes(${JSON.stringify(T_SHARED)})`);
    assert(blankBody === true, 'the fresh session renders blank (no seed transcript)');

    const niaMove = await probeNia.waitForEvent(
      'user_sessions_changed',
      (e) => e.sessions.length === 1 && e.sessions[0].sessionId === freshId,
      10_000,
    );
    assert(Boolean(niaMove), `nia's other device moved to the fresh session and dropped the old id`);
    const oldPillGone = await waitFor(async () => {
      // nia's browser is on the session view: the old session's PILL must be
      // gone from the pill bar (her own set); the dashboard row stays behind.
      const gone = await browserN.evalBrowser(
        `(() => { const bar = document.querySelector('.session-pill-bar-root'); if (!bar) return 'NO_BAR'; return !Array.from(bar.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes(${JSON.stringify(T_SHARED)})); })()`,
      );
      return gone === true;
    }, 10_000, 300);
    assert(oldPillGone === true, `the old session dropped from nia's own list`);
    assert((await summaryFor(defaultProbe, 'nia'))?.sessionCount === 1, 'list_users: nia holds exactly the fresh session');
    const bobCount = (await summaryFor(defaultProbe, 'bob'))?.sessionCount ?? null;
    assert(bobCount === 1, `bob's link to the old session is untouched (count ${JSON.stringify(bobCount)})`);
    const bobMeta2 = await probeBob3.send({ type: 'get_session_meta', sessionId: sharedId });
    assert(bobMeta2.success === true, 'the old conversation stays live for its other holder');
    const bobBroadcasts = burstsSince(probeBob3, beforeControl).map((entry) => entry.event);
    assert(bobBroadcasts.length === 0, `bob received no nia broadcast (got ${JSON.stringify(bobBroadcasts)})`);

    // ============================================================
    section('N — composer /new is intercepted locally and never dispatches');
    // ============================================================
    await browserN.evalBrowser(
      `(() => { const ta = document.querySelector('textarea[aria-label="Message"]'); ta?.focus(); return Boolean(ta); })()`,
    );
    await browserN.fillSelector('textarea[aria-label="Message"]', '/');
    await browserN.wait(500);
    const slashItems = await browserN.evalBrowser(`(() => {
      const pop = document.querySelector('.bg-popover');
      if (!pop) return JSON.stringify([]);
      return JSON.stringify(Array.from(pop.querySelectorAll('button span.font-medium')).map((s) => s.textContent.trim()));
    })()`);
    const slashList = JSON.parse(String(slashItems ?? '[]'));
    assert(!slashList.includes('new'), `pi's /new is gone from the composer slash menu (got ${JSON.stringify(slashList)})`);

    const sinceSlash = probeNia.events.length;
    await browserN.fillSelector('textarea[aria-label="Message"]', '/new');
    await browserN.evalBrowser(`(() => { const ta = document.querySelector('textarea[aria-label="Message"]'); ta?.focus(); return Boolean(ta); })()`);
    await browserN.browser(['press', 'Enter']);
    let composer2Path = null;
    const composer2Landed = await waitFor(async () => {
      const path = await browserN.evalBrowser(`location.pathname`);
      composer2Path = typeof path === 'string' && path.startsWith('/sessions/') && !path.includes(freshId) ? path : null;
      return Boolean(composer2Path);
    }, 15_000, 300);
    const freshId2 = String(composer2Path ?? '').split('/').pop() ?? '';
    assert(composer2Landed === true, `typing /new starts another fresh session (got ${JSON.stringify(composer2Path ?? 'timeout')})`);
    const composer2Text = String(await browserN.evalBrowser(`document.querySelector('textarea[aria-label="Message"]')?.value ?? ''`));
    assert(composer2Text === '', 'the composer clears after the interception');
    const noForwardEcho = await browserN.evalBrowser(`!document.body.innerText.includes('/new')`);
    assert(noForwardEcho === true, 'no /new prompt text renders anywhere (nothing was dispatched)');
    const niaEventsSince = probeNia.events.slice(sinceSlash).map((entry) => entry.event);
    assert(!niaEventsSince.some((e) => e.type === 'message_start' || e.type === 'agent_start'), 'no agent run started on the intercepted session');
    const niaMove2 = await probeNia.waitForEvent(
      'user_sessions_changed',
      (e) => e.sessions.length === 1 && e.sessions[0].sessionId === freshId2,
      10_000,
    );
    assert(Boolean(niaMove2), `nia's profile follows the composer flow to the second fresh session`);
    assert((await summaryFor(defaultProbe, 'nia'))?.sessionCount === 1, 'list_users: nia holds exactly the second fresh session');

    // ============================================================
    section('N — a forwarded /new prompt hits the server guard, not pi');
    // ============================================================
    const probeFrank = track(new WsProbe(port, `up-frank-${Math.random().toString(36).slice(2, 8)}`, 'frank'));
    await probeFrank.open();
    await probeFrank.waitForEvent('user_sessions_changed', () => true, 8_000);
    await probeFrank.send({ type: 'open_session', sessionId: sharedId, folderPath: projectDir });
    const bobEventsBefore = probeBob3.events.length;
    const guarded = await probeFrank.send({ type: 'prompt', sessionId: sharedId, message: '/new' });
    assert(guarded.success === true, 'a forwarded /new prompt answers success');
    const guardNewId = guarded.data?.sessionId ?? '';
    assert(guardNewId !== '' && guardNewId !== sharedId, `the response carries the fresh session pointer (got ${JSON.stringify(guardNewId)})`);
    const guardMove = await probeFrank.waitForEvent(
      'user_sessions_changed',
      (e) => e.sessions.length === 1 && e.sessions[0].sessionId === guardNewId,
      10_000,
    );
    assert(Boolean(guardMove), 'the acting raw client is told its new set (guard sequence converges it live)');
    assert((await summaryFor(defaultProbe, 'frank'))?.sessionCount === 1, 'list_users: frank holds exactly the guarded fresh session');
    await new Promise((r) => setTimeout(r, 500));
    const bobNewEvents = probeBob3.events.slice(bobEventsBefore).map((entry) => entry.event);
    assert(!bobNewEvents.some((e) => e.type === 'session_replaced' || e.type === 'agent_start' || e.type === 'message_start'), `pi saw nothing: bob's live old session neither rekeyed nor ran`);
    const bobMeta3 = await probeBob3.send({ type: 'get_session_meta', sessionId: sharedId });
    assert(bobMeta3.success === true, 'the old conversation stays live for its other holder after the guard');

    // ============================================================
    section('R — restart survival and boot GC of dead entries');
    // ============================================================
    const probeGc = track(new WsProbe(port, `up-gc-${Math.random().toString(36).slice(2, 8)}`, 'alice'));
    await probeGc.open();
    const gcOpen = await probeGc.send({ type: 'open_session', sessionId: gcId, folderPath: projectDir });
    assert(gcOpen.success === true, 'alice links the GC-fodder session');
    const gcFiles = await readdir(sessionDir);
    const gcFile = gcFiles.find((f) => f.includes(gcId));
    assert(Boolean(gcFile), 'the GC fixture file exists on disk');
    await unlink(join(sessionDir, gcFile));

    await stop();
    for (const probe of probes) probe.close();
    probes = [];
    await start();
    const postRestartDefault = track(new WsProbe(port, `up-default-post-${Math.random().toString(36).slice(2, 8)}`));
    await postRestartDefault.open();

    const probeAlicePost = track(new WsProbe(port, `up-alice-post-${Math.random().toString(36).slice(2, 8)}`, 'alice'));
    await probeAlicePost.open();
    const postBurst = await probeAlicePost.waitForEvent('user_sessions_changed', () => true, 8_000);
    assert(postBurst.fresh === false && postBurst.sessions.length === 0, 'boot GC pruned the dead entry; the empty key stays and is non-fresh');
    const probeDavePost = track(new WsProbe(port, `up-dave-post-${Math.random().toString(36).slice(2, 8)}`, 'dave'));
    await probeDavePost.open();
    const daveBurst = await probeDavePost.waitForEvent('user_sessions_changed', () => true, 8_000);
    assert(daveBurst.fresh === false && daveBurst.sessions.some((s) => s.sessionId === adoptId), `dave's profile survives the restart intact`);
    users = await summaries(postRestartDefault);
    assert(users.find((u) => u.name === 'bob')?.sessionCount === 1, `bob's profile survives the restart`);
    assert(!users.some((u) => u.name === 'default'), 'the default key still does not exist after restart');
    assert(!users.some((u) => u.name === 'carol'), 'carol still has no key after restart');

    // ============================================================
    section('E — shared rekey relink: every holder follows, watcher or not');
    // ============================================================
    // erin holds a profile link to the shared session and disconnects; a
    // bob connection then rekeys the slot (new_session — pi's /new runtime
    // path). The rekey is shared: holders with no live observer follow to
    // the new id instead of restoring the abandoned transcript.
    const probeBobE = track(new WsProbe(port, `up-bob-rekey-${Math.random().toString(36).slice(2, 8)}`, 'bob'));
    await probeBobE.open();
    await probeBobE.waitForEvent('user_sessions_changed', () => true, 8_000);
    await probeBobE.send({ type: 'open_session', sessionId: sharedId, folderPath: projectDir });
    const probeErin = track(new WsProbe(port, `up-erin-${Math.random().toString(36).slice(2, 8)}`, 'erin'));
    await probeErin.open();
    await probeErin.waitForEvent('user_sessions_changed', () => true, 8_000);
    await probeErin.send({ type: 'open_session', sessionId: sharedId, folderPath: projectDir });
    assert((await summaryFor(postRestartDefault, 'erin'))?.sessionCount === 1, `erin's profile links the shared session`);
    probeErin.close();
    await sleep(300);

    const beforeRekeyTs = Date.now();
    const rekey = await probeBobE.send({ type: 'new_session', sessionId: sharedId });
    assert(rekey.success === true, `bob's live connection rekeys the session (pi /new runtime path)`);
    // The observing connection applied the swap locally via session_replaced;
    // the profile broadcast skips it (no echo).
    const replaced = await probeBobE.waitForEvent('session_replaced', (e) => e.oldSessionId === sharedId, 8_000);
    assert(Boolean(replaced), `bob's observing connection receives session_replaced`);
    assert(burstsSince(probeBobE, beforeRekeyTs).length === 0, `the observing connection receives no profile echo`);

    // The observerless holder follows: erin's profile now names the new id.
    let erinHoldsOne = false;
    await waitFor(async () => {
      const users = await summaries(postRestartDefault);
      erinHoldsOne = users.find((u) => u.name === 'erin')?.sessionCount === 1;
      return erinHoldsOne;
    }, 8_000, 300);
    assert(erinHoldsOne === true, `erin's profile follows the rekey (1 session)`);

    // The rekeyed id: read it off a fresh erin connection's burst.
    const probeErin2 = track(new WsProbe(port, `up-erin-return-${Math.random().toString(36).slice(2, 8)}`, 'erin'));
    await probeErin2.open();
    const erinBurst = await probeErin2.waitForEvent('user_sessions_changed', () => true, 8_000);
    const followed = erinBurst.fresh === false && erinBurst.sessions.length === 1 && erinBurst.sessions[0].sessionId !== sharedId;
    if (!followed) log('erin burst after rekey:', JSON.stringify(erinBurst));
    assert(followed === true, `the observerless holder's burst names the rekeyed session, not the stale one`);
    const newId = erinBurst.sessions[0].sessionId;
    const reopen = await probeErin2.send({ type: 'open_session', sessionId: newId, folderPath: erinBurst.sessions[0].folderPath });
    assert(reopen.success === true, `erin's device opens the rekeyed session she was moved to`);

    // bob's profile likewise names the new id.
    const probeBob4 = track(new WsProbe(port, `up-bob-after-${Math.random().toString(36).slice(2, 8)}`, 'bob'));
    await probeBob4.open();
    const bobBurst = await probeBob4.waitForEvent('user_sessions_changed', () => true, 8_000);
    assert(bobBurst.fresh === false && bobBurst.sessions.length === 1 && bobBurst.sessions[0].sessionId === newId, `bob's profile names the rekeyed session too`);

    await browserA.browser(['screenshot', join(shotsDir, 'user-profiles.png')], { allowFailure: true }).catch(() => {});
    console.log(`[user-profiles] screenshot: ${join(shotsDir, 'user-profiles.png')}`);
  } finally {
    await browserA?.browser(['close'], { allowFailure: true }).catch(() => {});
    await browserB?.browser(['close'], { allowFailure: true }).catch(() => {});
    await browserM?.browser(['close'], { allowFailure: true }).catch(() => {});
    for (const probe of probes) probe.close();
    await stop();
    if (stats.failures > 0) {
      log('FAILURES — sandbox preserved at', sandboxHome);
    } else if (process.env.UP_KEEP === '1') {
      log('UP_KEEP=1 — sandbox preserved at', sandboxHome);
    } else {
      await rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(
    `[user-profiles] ${stats.failures === 0 ? 'all hard assertions passed' : `${stats.failures} hard assertion(s) failed`}; ${softFailures.length} environment-bounded`,
  );
  process.exitCode = stats.failures > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('[user-profiles] unexpected failure:', error);
  process.exitCode = 1;
});
