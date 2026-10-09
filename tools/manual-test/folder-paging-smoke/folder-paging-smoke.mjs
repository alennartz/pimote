#!/usr/bin/env node
// End-to-end smoke for server-side folder listing (the
// `server-folder-list-paging` topic): pinned order, windowed infinite scroll,
// two-tier server search, folders_changed deltas, virtualized FolderList.
//
// Boots a real pimote in an isolated HOME against one scan root holding
// ~250 fabricated code folders (so the browser walks >= 3 continuation
// windows at the default 100-row window), fabricated pi sessions for
// recency ordering and session-tier search, and one persona folder. Drives
// the wire through WS probes (window continuity, pin contract, search
// semantics, delta targeting) and the real PWA through agent-browser
// (deep-scroll continuity, mid-scroll curation edits, query-match shrink,
// debounced search, refresh/reconnect cache-replace, archive toggle x
// session lists, lazy session loading).
//
// Shared boot/probe/browser helpers live in tools/manual-test/lib/.
//
// Optional environment variables:
//   FP_FOLDERS=245     filler folder count (clamped to >= 30)
//   FP_SHOTS=/tmp/dir  keep coherence screenshots outside the disposable sandbox
//   FP_KEEP=1          keep the sandbox even on a passing run

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeReporter } from '../lib/report.mjs';
import { freePort, gitInit, writePersona, seedSession, startPimote, stopPimote, waitForListening } from '../lib/sandbox.mjs';
import { WsProbe } from '../lib/ws-probe.mjs';
import { makeBrowserHelpers } from '../lib/browser.mjs';

const { assert, soft, section, log, stats, softFailures } = makeReporter('fp-smoke');
const {
  browser,
  evalBrowser,
  fillSelector,
  typeBurst,
  wait,
  revealFolder,
  rowText,
  rowBlockText,
  rowRenderedNow,
  starOnRow,
  clickDialogButton,
  folderScrollTop,
  folderScrollStep,
  installSocketProbe,
  sentLog,
  markSent,
  sentSince,
  loadedSessionPaths,
  pageConsole,
  closeLatestSocket,
} = makeBrowserHelpers({ session: `folder-paging-${process.pid}`, log });

const N_FILLERS = Math.max(30, Number(process.env.FP_FOLDERS ?? 245) || 245);
const SCUBA_COUNT = Math.min(130, N_FILLERS);
const SEARCH_INPUT = 'input[aria-label="Search folders"]';

const pad3 = (n) => String(n).padStart(3, '0');

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

// ------------------------------------------------------------ coverage pass

/**
 * Scroll the virtualized folder list from the current position to the bottom
 * in `frac`-viewport steps, accumulating every rendered folder path.
 * Returns { seen, maxRows, dupes } — `dupes` counts snapshots where one row
 * rendered twice.
 */
async function scrollPass({ frac = 0.7, onStep, maxSteps = 220 } = {}) {
  const seen = new Set();
  let maxRows = 0;
  let dupes = 0;
  let bottomHits = 0;
  for (let i = 0; i < maxSteps; i++) {
    const state = await folderScrollStep(frac);
    if (!state) throw new Error('no dashboard scroller found');
    maxRows = Math.max(maxRows, state.paths.length);
    if (new Set(state.paths).size !== state.paths.length) dupes++;
    for (const path of state.paths) {
      seen.add(path);
      onStep?.(path);
    }
    const atBottom = state.top >= state.height - state.client - 8;
    bottomHits = atBottom ? bottomHits + 1 : 0;
    await wait(300);
    // Also sample the settled DOM at the landed position: rows first-measure
    // while the pass scrolls (estimates shrink to real heights), so a
    // pre-scroll snapshot alone can miss rows whose index drifted across the
    // seam between two samples.
    const settled = await evalBrowser(`(() => Array.from(document.querySelectorAll('[data-folder-path]')).map((r) => r.getAttribute('data-folder-path')))()`);
    for (const path of settled ?? []) {
      seen.add(path);
      onStep?.(path);
    }
    if (bottomHits >= 3) break;
  }
  await wait(800);
  return { seen, maxRows, dupes };
}

/** Scroll partway down (fraction of the scrollable range), collecting renders. */
async function scrollUntil(rangeFraction, { frac = 0.7 } = {}) {
  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    const state = await folderScrollStep(frac);
    if (!state) throw new Error('no dashboard scroller found');
    for (const path of state.paths) seen.add(path);
    const range = Math.max(1, state.height - state.client);
    await wait(300);
    if (state.top / range >= rangeFraction) break;
  }
  return seen;
}

/** The dashboard (folders surface) is mounted and rendering rows. */
async function dashboardReady(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evalBrowser(`(() => ({
      rows: document.querySelectorAll('[data-folder-path]').length,
      home: Boolean(document.querySelector('button[aria-label="New session"]')),
    }))()`);
    if (state?.rows > 0 && state.home === true) return true;
    await wait(500);
  }
  return false;
}

/** Close a viewed session and return to the dashboard (journey 1 behavior). */
async function closeSessionToDashboard() {
  await evalBrowser(`document.querySelector('button.bg-primary span[title="Close session"]')?.click()`);
  return dashboardReady();
}

/** Socket/page diagnostics for failed assertions. */
async function pageDiag() {
  const sockets = await evalBrowser(`(window.__pmSockets ?? []).map((s) => s.readyState)`);
  const rows = await evalBrowser(`document.querySelectorAll('[data-folder-path]').length`);
  const folderSends = await sentLog('m.type === "list_folders"');
  const sends = folderSends.map((m) => ({ offset: m.offset, query: m.query, repin: m.repin ?? false, arch: m.includeArchived ?? false }));
  return `sockets=${JSON.stringify(sockets)} rows=${rows} list_folders=${JSON.stringify(sends)} console=[${await pageConsole(8)}]`;
}

// -------------------------------------------------------------------- main

async function main() {
  console.log('[fp-smoke] folder paging / search / delta smoke');
  const sandboxHome = await mkdtemp(join(tmpdir(), 'folder-paging-smoke-'));
  const configDir = join(sandboxHome, '.config', 'pimote');
  await mkdir(configDir, { recursive: true });
  const agentDir = join(sandboxHome, 'agent');
  const sessionsRoot = join(agentDir, 'sessions');
  await mkdir(sessionsRoot, { recursive: true });

  const rootA = join(sandboxHome, 'projects');
  const pager = (n) => join(rootA, `pager-${pad3(n)}`);
  const alphaAnchor = join(rootA, 'alpha-anchor');
  const midAnchor = join(rootA, 'mid-anchor');
  const archAnchor = join(rootA, 'arch-anchor');
  const solarPersona = join(rootA, 'solar-persona');
  const pagerNew = join(rootA, 'pager-new');

  // --- Fixture tree: three real anchor repos, one persona, N filler code
  //     folders (a bare .git dir is enough for code classification).
  log('fabricating fixture tree…');
  await gitInit(alphaAnchor, 'main');
  await gitInit(midAnchor, 'main');
  await gitInit(archAnchor, 'main');
  await writePersona(solarPersona, 'Solar Sage', 'Fixture persona for display-name search');
  const fillerNumbers = Array.from({ length: N_FILLERS }, (_, i) => i + 1);
  await inBatches(fillerNumbers, 24, (n) => mkdir(join(pager(n), '.git'), { recursive: true }));

  // --- Fabricated sessions: controlled timestamps pin recency ordering.
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000);
  const archId = await seedSession(sessionsRoot, archAnchor, 'archived drill log', 'answer', { at: at(10) });
  const subId = await seedSession(sessionsRoot, midAnchor, 'submarine repair log', 'answer', { at: at(60) });
  const gardenId = await seedSession(sessionsRoot, midAnchor, 'gardening tips', 'answer', { at: at(240) });
  const zebraId = await seedSession(sessionsRoot, alphaAnchor, 'zebra migration checklist', 'answer', { at: at(120) });
  const routineId = await seedSession(sessionsRoot, alphaAnchor, 'routine standup notes', 'answer', { at: at(180) });
  const scubaIds = new Map();
  await inBatches(fillerNumbers.slice(0, SCUBA_COUNT), 16, async (n) => {
    scubaIds.set(pager(n), await seedSession(sessionsRoot, pager(n), `scuba drill ${pad3(n)}`, 'answer', { at: at(300) }));
  });

  const configPath = join(configDir, 'config.json');
  const port = await freePort();
  await writeFile(configPath, JSON.stringify({ roots: [rootA], port, bufferSize: 100, updateCheck: false }, null, 2));

  const logPath = join(sandboxHome, 'pimote.log');
  const shotsDir = process.env.FP_SHOTS ? join(process.env.FP_SHOTS) : sandboxHome;
  await mkdir(shotsDir, { recursive: true });
  log('sandbox HOME =', sandboxHome);
  log('root         =', rootA);
  log('port         =', port);
  log('fillers      =', N_FILLERS, '/ scuba sessions =', SCUBA_COUNT);

  let child;
  let probeA;
  let probeB;
  // Outbound-message bookkeeping: sentLog() sees every app request after
  // installSocketProbe(); page-side marks delimit counting windows.
  const sinceMark = sentSince;

  try {
    child = startPimote({ port, sandboxHome, agentDir, configPath, logPath });
    await waitForListening(child, port, logPath);
    probeA = new WsProbe(port, `fp-a-${randomUUID().slice(0, 8)}`);
    probeB = new WsProbe(port, `fp-b-${randomUUID().slice(0, 8)}`);
    await probeA.open();
    await probeB.open();

    // ============================================================
    section('W — window continuity over the full set');
    // ============================================================
    const complete = await probeA.listFolders({ limit: 3 });
    const totalRows = complete.data.total;
    assert(totalRows === N_FILLERS + 4, `complete listing carries every row (${totalRows} = fillers + 3 anchors + persona)`);
    assert(complete.data.folders.length === totalRows, 'tiny windows accumulate the complete listing');
    assert(complete.windowPaths.length === totalRows, 'window stream covers every row (no short stream)');
    assert(new Set(complete.windowPaths).size === totalRows, 'no duplicate rows across 3-row windows');
    assert(complete.data.more === false, 'more flips false exactly at the end of the order');
    assert(complete.windowCount >= 80, `deep pagination exercised (${complete.windowCount} windows)`);

    // ============================================================
    section('W — pin contract (adoption, ownership, clamp, repin)');
    // ============================================================
    const win = await probeA.send({ type: 'list_folders', offset: 0, limit: 5, repin: true });
    const tokenA = win.data.orderToken;
    const cont = await probeA.send({ type: 'list_folders', offset: 5, limit: 5, orderToken: tokenA });
    assert(cont.data.orderToken === tokenA, 'adopted token serves continuation windows');
    const omitted = await probeA.send({ type: 'list_folders', offset: 10, limit: 5 });
    assert(omitted.data.orderToken === tokenA, 'omitted token reuses the connection pin');
    const stolen = await probeB.send({ type: 'list_folders', offset: 0, limit: 5, orderToken: tokenA });
    assert(stolen.data.orderToken !== tokenA, 'cross-owner token is not adopted (transparent re-pin)');
    const stolenCont = await probeB.send({ type: 'list_folders', offset: 5, limit: 5, orderToken: stolen.data.orderToken });
    assert(
      JSON.stringify(stolenCont.data.folders.map((r) => r.path)) === JSON.stringify(cont.data.folders.map((r) => r.path)),
      'replacement pin serves the same order rows',
    );
    const clamped = await probeA.send({ type: 'list_folders', offset: 0, limit: 999 });
    assert(clamped.data.folders.length <= 200, `limit clamped to [1, 200] (got ${clamped.data.folders.length})`);
    await probeA.send({ type: 'update_folder', folderPath: pager(N_FILLERS), favorite: true });
    const repinned = await probeA.send({ type: 'list_folders', offset: 0, limit: 5, repin: true });
    assert(repinned.data.orderToken !== tokenA, 'explicit repin returns a fresh token');
    assert(repinned.data.folders[0]?.path === pager(N_FILLERS), 'fresh pin orders favorites first');
    await probeA.send({ type: 'update_folder', folderPath: pager(N_FILLERS), favorite: false });
    assert(repinned.data.folders.length === 5 && repinned.data.more === true, 'windowed repin keeps serving slices of the fresh order');

    // ============================================================
    section('W — curation at query time, pin order unchanged');
    // ============================================================
    const scanA = await probeA.listFolders({ limit: 25 });
    const idxA = scanA.windowPaths.indexOf(pager(7));
    await probeA.send({ type: 'update_folder', folderPath: pager(7), addTags: ['pinned-edit'] });
    const scanB = await probeA.listFolders({ limit: 25 });
    assert(JSON.stringify(scanB.windowPaths) === JSON.stringify(scanA.windowPaths), 'pinned order survives a curation edit (order-only pin)');
    const row7 = scanB.data.folders.find((r) => r.path === pager(7));
    assert(row7?.tags?.includes('pinned-edit') && row7?.userTags?.includes('pinned-edit'), 'edited row data resolves fresh at query time');
    assert(scanB.windowPaths.indexOf(pager(7)) === idxA, 'edited row keeps its pinned position');

    // ============================================================
    section('W — two-tier search semantics (server-authoritative)');
    // ============================================================
    const qSub = await probeA.listFolders({ limit: 3, query: 'submarine' });
    assert(qSub.data.total === 1 && qSub.data.folders[0]?.path === midAnchor, 'session firstMessage tier matches one folder');
    assert(JSON.stringify(qSub.data.folders[0]?.matchedSessionIds) === JSON.stringify([subId]), 'session tier returns exactly the matched session ids');
    const qZebra = await probeA.listFolders({ limit: 3, query: 'zebra' });
    assert(
      qZebra.data.total === 1 && qZebra.data.folders[0]?.path === alphaAnchor && JSON.stringify(qZebra.data.folders[0]?.matchedSessionIds) === JSON.stringify([zebraId]),
      'session name/firstMessage tier narrows to the matched session only',
    );
    const qGarden = await probeA.listFolders({ limit: 3, query: 'gardening tips' });
    assert(
      qGarden.data.total === 1 && qGarden.data.folders[0]?.path === midAnchor && JSON.stringify(qGarden.data.folders[0]?.matchedSessionIds) === JSON.stringify([gardenId]),
      'second session of a folder matches independently',
    );
    const qRoutine = await probeA.listFolders({ limit: 3, query: 'routine standup' });
    assert(
      qRoutine.data.total === 1 && qRoutine.data.folders[0]?.path === alphaAnchor && JSON.stringify(qRoutine.data.folders[0]?.matchedSessionIds) === JSON.stringify([routineId]),
      'sibling session ids are excluded from matchedSessionIds',
    );
    const qName = await probeA.listFolders({ limit: 3, query: 'alpha-anch' });
    assert(qName.data.total === 1 && qName.data.folders[0]?.path === alphaAnchor, 'folder name tier matches');
    assert(qName.data.folders[0]?.matchedSessionIds === undefined, 'folder-tier matches omit matchedSessionIds');
    const qTag = await probeA.listFolders({ limit: 3, query: 'pinned-edit' });
    assert(qTag.data.total === 1 && qTag.data.folders[0]?.path === pager(7), 'tag tier matches');
    const qPersona = await probeA.listFolders({ limit: 3, query: 'Solar Sage' });
    assert(qPersona.data.total === 1 && qPersona.data.folders[0]?.path === solarPersona, 'persona display-name tier matches');
    const qScuba = await probeA.listFolders({ limit: 25, query: 'scuba' });
    assert(qScuba.data.total === SCUBA_COUNT, `session tier matches across the full set (${qScuba.data.total})`);
    const qDeep = await probeA.listFolders({ limit: 3, query: `scuba drill ${pad3(SCUBA_COUNT)}` });
    assert(
      qDeep.data.total === 1 && qDeep.data.folders[0]?.path === pager(SCUBA_COUNT),
      'rows outside every fetched window can match (full-set filtering)',
    );
    assert((qDeep.data.folders[0]?.matchedSessionIds ?? []).length === 1, 'deep match carries its matched session id');

    // ============================================================
    section('W — archive filter × rows and totals');
    // ============================================================
    await probeA.send({ type: 'update_folder', folderPath: archAnchor, archived: true });
    await probeA.send({ type: 'update_folder', folderPath: pager(141), archived: true });
    const activeRows = await probeA.listFolders({ limit: 50 });
    assert(
      !activeRows.data.folders.some((r) => r.path === archAnchor || r.path === pager(141)),
      'archived rows excluded by default',
    );
    assert(activeRows.data.total === totalRows - 2, 'default total counts the unarchived set');
    const withArch = await probeA.listFolders({ limit: 50, includeArchived: true });
    const withArchPaths = new Set(withArch.data.folders.map((r) => r.path));
    assert(withArchPaths.has(archAnchor) && withArchPaths.has(pager(141)), 'explicit includeArchived windows include archived rows');
    assert(withArch.data.total === totalRows, 'includeArchived total counts the full set');
    const qArchOff = await probeA.listFolders({ limit: 3, query: 'archived drill' });
    assert(qArchOff.data.total === 0, 'archived rows match nothing without includeArchived');
    const qArchOn = await probeA.listFolders({ limit: 3, query: 'archived drill', includeArchived: true });
    assert(
      qArchOn.data.total === 1 && qArchOn.data.folders[0]?.path === archAnchor && qArchOn.data.folders[0]?.archived === true,
      'includeArchived restores archived matches',
    );
    assert(JSON.stringify(qArchOn.data.folders[0]?.matchedSessionIds) === JSON.stringify([archId]), 'archived match carries its session id');

    // ============================================================
    section('W — file_put → AGENTS.md delta targeting');
    // ============================================================
    // AGENTS.md edits re-walk discovery before the delta can resolve its row
    // (classification can change), so deltas can take seconds on a large
    // fixture — the waits below are generous.
    await probeA.send({ type: 'file_put', path: join(pager(2), 'AGENTS.md'), content: '# pager-002 notes\n' });
    const d1 = await probeB
      .waitForEvent('folders_changed', (e) => e.changed?.some((r) => r.path === pager(2)), 25_000)
      .catch(() => null);
    assert(Boolean(d1), 'top-level AGENTS.md edit deltas its folder row');
    await probeA.send({ type: 'file_put', path: join(pager(3), 'nested', 'deep', 'AGENTS.md'), content: '# nested notes\n' });
    const d2 = await probeB
      .waitForEvent('folders_changed', (e) => e.changed?.some((r) => r.path === pager(3)), 25_000)
      .catch(() => null);
    assert(Boolean(d2), 'nested AGENTS.md edit deltas the deepest owning row');
    await wait(2_000); // let any late rebuild-driven delta drain before the global probe
    const tGlobal = Date.now();
    await probeA.send({ type: 'file_put', path: join(sandboxHome, '.pi', 'agent', 'AGENTS.md'), content: '# global instructions\n' });
    await wait(5_000);
    assert(probeB.eventsSince(tGlobal, 'folders_changed').length === 0, 'global-instructions edit triggers no folder delta');

    // ============================================================
    section('W — discovery-added folder via folders_changed delta');
    // ============================================================
    await mkdir(join(pagerNew, '.git'), { recursive: true });
    let discovered = null;
    for (let i = 0; i < 16 && !discovered; i++) {
      discovered = await probeB
        .waitForEvent('folders_changed', (e) => e.changed?.some((r) => r.path === pagerNew), 3000)
        .catch(() => null);
      if (!discovered) await probeA.send({ type: 'list_folders', offset: 0, limit: 1 }); // prod the TTL refresh
    }
    soft(Boolean(discovered), 'new on-disk repo surfaces through a folders_changed delta (TTL refresh)', 'discovery refresh did not fire within ~45s');

    // ============================================================
    section('B — dashboard load + socket instrumentation');
    // ============================================================
    await browser(['close'], { allowFailure: true });
    await browser(['set', 'viewport', '1280', '900']);
    await browser(['open', `http://127.0.0.1:${port}/`]);
    await browser(['wait', 3000]);
    await installSocketProbe();
    const snap = (await browser(['snapshot', '-i'])).stdout;
    assert(snap.includes('New session'), 'dashboard renders the folders surface');
    await browser(['screenshot', join(shotsDir, '01-dashboard.png')], { allowFailure: true });

    // ============================================================
    section('B — lazy session loading (rendered rows only)');
    // ============================================================
    await markSent();
    await wait(3000);
    const trickle = await sinceMark('m.type === "list_sessions"');
    assert(trickle.length === 0, `no session-list fan-out trickle after settle (${trickle.length} stray requests)`);
    await markSent();
    const preStep = new Set((await folderScrollStep(0))?.paths ?? []);
    await folderScrollStep(0.7);
    await wait(900);
    const postStep = new Set((await folderScrollStep(0))?.paths ?? []);
    const freshRows = [...postStep].filter((p) => !preStep.has(p));
    const stepReqs = await sinceMark('m.type === "list_sessions"');
    assert(stepReqs.length <= freshRows.length + 4, `session lists follow rendered rows (${stepReqs.length} requests / ${freshRows.length} new rows)`);
    assert(freshRows.length === 0 || stepReqs.length >= 1, 'newly rendered rows request their session lists');

    // ============================================================
    section('B — two-tier search in the UI (authoritative, debounced)');
    // ============================================================
    await fillSelector(SEARCH_INPUT, 'pager-2');
    await wait(1400);
    const deepText = await rowText(pager(N_FILLERS));
    assert(deepText.includes(`pager-${pad3(N_FILLERS)}`), 'search finds a deep row never fetched by any window');
    await fillSelector(SEARCH_INPUT, 'submarine');
    await wait(1400);
    await folderScrollTop();
    const subText = await rowBlockText(midAnchor);
    assert(subText.includes('submarine repair log'), 'session-tier match renders its matched session');
    assert(!subText.includes('gardening tips'), 'session-tier match narrows the session list to matchedSessionIds');
    await fillSelector(SEARCH_INPUT, 'alpha-anch');
    await wait(1400);
    await folderScrollTop();
    const alphaText = await rowBlockText(alphaAnchor);
    assert(
      alphaText.includes('zebra migration checklist') && alphaText.includes('routine standup notes'),
      'folder-tier match keeps all its sessions',
    );
    await fillSelector(SEARCH_INPUT, 'Solar Sage');
    await wait(1400);
    assert((await rowText(solarPersona)).includes('Solar Sage'), 'persona display name is searchable');
    await fillSelector(SEARCH_INPUT, '');
    await wait(800);
    await markSent();
    await typeBurst(SEARCH_INPUT, ['s', 'su', 'sub', 'subm', 'submar', 'submarine'], 40);
    await wait(1400);
    const queryReqs = await sinceMark('m.type === "list_folders" && m.query !== ""');
    assert(queryReqs.length >= 1 && queryReqs.length <= 2, `typing burst coalesces into 1–2 query fetches (saw ${queryReqs.length}: ${JSON.stringify(queryReqs.map((m) => m.query))})`);
    assert((await rowRenderedNow(alphaAnchor)) === false, 'final query of the burst wins the view');
    await browser(['screenshot', join(shotsDir, '02-search.png')], { allowFailure: true });
    await fillSelector(SEARCH_INPUT, '');
    await wait(800);

    // ============================================================
    section('B — archive toggle × session lists (no fan-out)');
    // ============================================================
    await folderScrollTop();
    const everLoaded = new Set(await loadedSessionPaths());
    const coldCandidates = [pager(55), pager(60), pager(65), pager(70), pager(75), pager(80), pager(85), pager(90), pager(95), pager(98)];
    const win1 = await probeA.send({ type: 'list_folders', offset: 0, limit: 100 });
    const coldPath =
      coldCandidates.find((p) => !everLoaded.has(p)) ??
      win1.data.folders
        .map((r) => r.path)
        .find((p) => !everLoaded.has(p) && p !== archAnchor && p !== pager(141) && p !== pagerNew);
    assert(Boolean(coldPath), 'fixture has a cached-but-never-loaded row');
    await markSent();
    await browser(['click', 'button[title="More folder actions"]']);
    await wait(400);
    const toggled = await evalBrowser(`(() => {
      const item = Array.from(document.querySelectorAll('[role="menuitem"], [data-slot="context-menu-item"], [data-slot="dropdown-menu-item"]')).find((i) => i.textContent?.trim().includes('Show archived'));
      if (!item) return false;
      item.click();
      return true;
    })()`);
    await wait(1500);
    assert(toggled === true, 'toolbar exposes Show archived');
    const toggleReqs = await sinceMark('m.type === "list_sessions"');
    const togglePaths = new Set(toggleReqs.map((m) => m.folderPath));
    soft(
      coldPath === undefined || !togglePaths.has(coldPath),
      'archive toggle never fans out to unloaded cached rows',
      'a re-sort can legitimately render (and load) an edge row during the toggle',
    );
    assert(togglePaths.size <= everLoaded.size + 40, `toggle reloads only loaded/rendered lists (${togglePaths.size} reloads vs ${everLoaded.size} previously loaded)`);
    const badgeText = await rowText(archAnchor);
    let retryNote = '';
    if (!badgeText.includes('Archived')) {
      // Recovery probe: a search-clear refetch re-lands the window data and
      // re-measures rows. If the row renders only after that, the row data is
      // present and the virtualizer failed to keep its slot renderable.
      const geom = await evalBrowser(`(() => {
        const row = document.querySelector('[data-folder-path]');
        const scroller = row?.closest('.overflow-y-auto');
        const indices = Array.from(document.querySelectorAll('[data-index]')).map((r) => Number(r.getAttribute('data-index')));
        return { scrollHeight: scroller?.scrollHeight ?? -1, client: scroller?.clientHeight ?? -1, rows: indices.length, maxIndex: indices.length ? Math.max(...indices) : -1, scrollTop: scroller?.scrollTop ?? -1 };
      })()`);
      const reCleared = await fillSelector(SEARCH_INPUT, '');
      await wait(1200);
      const retryText = await rowText(archAnchor);
      retryNote = ` retry-after-clear=${retryText.includes('Archived')}(reClear=${reCleared}) geom=${JSON.stringify(geom)}`;
    }
    assert(badgeText.includes('Archived'), `show-archived reveals the archived row with its badge (row=${JSON.stringify(badgeText.slice(0, 60))};${retryNote} ${await pageDiag()})`);
    await browser(['screenshot', join(shotsDir, '04-archived.png')], { allowFailure: true });
    await browser(['click', 'button[title="More folder actions"]']);
    await wait(400);
    await evalBrowser(`(() => {
      const item = Array.from(document.querySelectorAll('[role="menuitem"], [data-slot="context-menu-item"], [data-slot="dropdown-menu-item"]')).find((i) => i.textContent?.trim().includes('Hide archived'));
      if (!item) return false;
      item.click();
      return true;
    })()`);
    await wait(1000);
    assert((await rowRenderedNow(archAnchor)) === false, 'hide-archived removes the archived row again');

    // ============================================================
    section('B — deep-scroll window continuity (virtualized)');
    // ============================================================
    await fillSelector(SEARCH_INPUT, '');
    await wait(600);
    await folderScrollTop();
    const expected = new Set((await probeA.listFolders({ limit: 100 })).data.folders.map((r) => r.path));
    const pass1 = await scrollPass();
    assert(pass1.dupes === 0, 'no row renders twice within a frame');
    assert(pass1.maxRows <= 60, `virtualization bounds rendered rows (max ${pass1.maxRows})`);
    const missing1 = [...expected].filter((p) => !pass1.seen.has(p));
    assert(missing1.length === 0, `deep scroll renders every listed row (missing ${missing1.length}: ${missing1.slice(0, 4).join(', ')})`);
    const unexpected1 = [...pass1.seen].filter((p) => !expected.has(p));
    assert(unexpected1.length === 0, `no phantom rows while scrolling (unexpected ${unexpected1.length}: ${unexpected1.slice(0, 4).join(', ')})`);
    await browser(['screenshot', join(shotsDir, '03-deep-scroll.png')], { allowFailure: true });

    // ============================================================
    section('B — curation edits mid-scroll keep window continuity');
    // ============================================================
    await folderScrollTop();
    const preEditSeen = await scrollUntil(0.45);
    await probeA.send({ type: 'update_folder', folderPath: pager(30), favorite: true });
    await probeA.send({ type: 'update_folder', folderPath: pager(40), addTags: ['mid-scroll-tag'] });
    await probeA.send({ type: 'update_folder', folderPath: pager(50), archived: true });
    await wait(1200);
    const belowFrontier = [...expected].filter((p) => !preEditSeen.has(p) && p !== pager(50));
    const seenAfterEdit = new Set();
    const pass2 = await scrollPass({ onStep: (p) => seenAfterEdit.add(p) });
    await folderScrollTop();
    const pass3 = await scrollPass({ frac: 0.85 });
    const union = new Set([...preEditSeen, ...pass2.seen, ...pass3.seen]);
    const expected2 = new Set((await probeA.listFolders({ limit: 100 })).data.folders.map((r) => r.path));
    const missing2 = [...expected2].filter((p) => !union.has(p));
    assert(missing2.length === 0, `rows do not silently skip after mid-scroll edits (missing ${missing2.length}: ${missing2.slice(0, 4).join(', ')})`);
    assert(seenAfterEdit.has(pager(N_FILLERS)) || pass3.seen.has(pager(N_FILLERS)), 'tail row still reachable after mid-scroll edits');
    assert(pass2.dupes === 0 && pass3.dupes === 0, 'edits produce no duplicate rendered rows');
    assert(belowFrontier.every((p) => union.has(p)), 'every below-frontier row renders across the continuation');
    const pager50RenderedAfter = seenAfterEdit.has(pager(50)) || pass3.seen.has(pager(50));
    assert(pager50RenderedAfter === false, 'row archived mid-scroll leaves the view');
    await folderScrollTop();
    assert(await starOnRow(pager(30)), 'favorite made mid-scroll appears on the row (delta merge)');
    assert((await rowText(pager(40))).includes('mid-scroll-tag'), 'tag made mid-scroll appears on the row (delta merge)');
    await fillSelector(SEARCH_INPUT, 'mid-scroll-tag');
    await wait(1400);
    assert((await rowRenderedNow(pager(40))) === true, 'search finds the mid-scroll tag edit');
    await fillSelector(SEARCH_INPUT, '');
    await wait(800);

    // ============================================================
    section('B — mid-scroll shrink under an active query');
    // ============================================================
    await fillSelector(SEARCH_INPUT, 'pager-1');
    await wait(1500);
    const qPre = await scrollUntil(0.45);
    await probeA.send({ type: 'update_folder', folderPath: pager(105), archived: true });
    await wait(1200);
    const qSeenAfter = new Set();
    const qCont = await scrollPass({ onStep: (p) => qSeenAfter.add(p) });
    await folderScrollTop();
    const qFull = await scrollPass({ frac: 0.85 });
    const expectedQ = new Set((await probeA.listFolders({ limit: 100, query: 'pager-1' })).data.folders.map((r) => r.path));
    const qUnion = new Set([...qPre, ...qCont.seen, ...qFull.seen]);
    const qMissing = [...expectedQ].filter((p) => !qUnion.has(p));
    assert(qMissing.length === 0, `query windows keep coverage across a mid-scroll shrink (missing ${qMissing.length}: ${qMissing.slice(0, 4).join(', ')})`);
    assert(qCont.seen.has(pager(199)) || qFull.seen.has(pager(199)), 'deep query-match rows remain reachable after the shrink');
    assert(qSeenAfter.has(pager(105)) === false, 'archived query match leaves the filtered view');
    await fillSelector(SEARCH_INPUT, '');
    await wait(800);

    // ============================================================
    section('B — session-delete shrink mid-scan (session-tier query)');
    // ============================================================
    await fillSelector(SEARCH_INPUT, 'scuba');
    await wait(1500);
    await probeA.send({ type: 'delete_session', folderPath: pager(5), sessionId: scubaIds.get(pager(5)) });
    await wait(2500); // client restart + server metadata refresh
    // Server truth: the still-matching rows (archived rows never match).
    const scubaBefore = (await probeA.listFolders({ limit: 100, query: 'scuba' })).data.folders.map((r) => r.path);
    const sSeenAfter = new Set();
    const sPass = await scrollPass({ onStep: (p) => sSeenAfter.add(p) });
    await folderScrollTop();
    const sFull = await scrollPass({ frac: 0.85 });
    const sUnion = new Set([...sPass.seen, ...sFull.seen]);
    const sMissing = scubaBefore.filter((p) => !sUnion.has(p));
    assert(sMissing.length === 0, `deleting a matched session mid-scan skips no rows (missing ${sMissing.length}: ${sMissing.slice(0, 4).join(', ')})`);
    soft(sSeenAfter.has(pager(5)) === false && !sFull.seen.has(pager(5)), 'deleted match leaves the active query view', 'stale server metadata can serve it until the next refresh');
    await fillSelector(SEARCH_INPUT, '');
    await wait(800);

    // ============================================================
    section('B — explicit refresh (repin) via the create-folder flow');
    // ============================================================
    await markSent();
    await evalBrowser(`(() => { const b = document.querySelector('button[aria-label="New session"]'); if (!b) return false; b.click(); return true; })()`);
    await wait(500);
    await evalBrowser(`(() => {
      const item = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.trim() === 'Create new folder');
      if (!item) return false;
      item.click();
      return true;
    })()`);
    await wait(500);
    await evalBrowser(`(() => {
      const btns = Array.from(document.querySelectorAll('[role="dialog"] button')).filter((b) => b.textContent?.trim() === ${JSON.stringify(rootA)});
      if (btns.length) btns[0].click();
      return true;
    })()`);
    await wait(300);
    await fillSelector('[role="dialog"] input[placeholder="Folder name"]', 'epsilon-refresh');
    await wait(200);
    await clickDialogButton('Create');
    // The create round-trip (mkdir + git init + delta) can take seconds on a
    // large fixture; poll for the refresh request the flow fires afterwards.
    let repinSeen = 0;
    for (let i = 0; i < 40 && repinSeen === 0; i++) {
      await wait(500);
      repinSeen = (await sinceMark('m.type === "list_folders" && m.repin === true')).length;
    }
    assert(repinSeen === 1, `explicit refresh sends exactly one repin window request (saw ${repinSeen}; ${await pageDiag()})`);
    const epsilonDir = join(rootA, 'epsilon-refresh');
    const epsilonGit = await stat(join(epsilonDir, '.git')).then(
      () => true,
      () => false,
    );
    assert(epsilonGit, 'created folder exists on disk (mkdir + git init)');
    // The create flow opens the session AFTER the refresh request; wait for
    // the session view before closing it, or the close clicks into nothing.
    for (let i = 0; i < 24; i++) {
      const composer = await evalBrowser(`Boolean(document.querySelector('textarea:not([aria-label="Message the manager"])'))`);
      if (composer === true) break;
      await wait(500);
    }
    const backToDashboard = await closeSessionToDashboard();
    assert(backToDashboard === true, 'closing the session returns to the dashboard');
    assert((await rowText(epsilonDir)).includes('epsilon-refresh'), `refreshed cache shows the created folder (${await pageDiag()})`);
    const dupState = await folderScrollStep(0);
    assert(new Set(dupState?.paths ?? []).size === (dupState?.paths ?? []).length, 'refreshed cache renders no duplicate rows');

    // ============================================================
    section('B — reconnect cache-replace (no phantom rows)');
    // ============================================================
    const hubPath = join(rootA, 'hub-phantom');
    await closeSessionToDashboard(); // in case a restored session reclaimed the view
    await installSocketProbe(); // idempotent; fresh after any page reload
    await probeA.send({ type: 'create_hub', name: 'hub-phantom', root: rootA, memberPaths: [alphaAnchor] });
    await probeB.waitForEvent('folders_changed', (e) => e.changed?.some((r) => r.path === hubPath), 25_000);
    await probeA.send({ type: 'update_folder', folderPath: hubPath, favorite: true });
    await wait(1200);
    await folderScrollTop();
    assert((await revealFolder(hubPath)) === true, `hub row renders before the disconnect (${await pageDiag()})`);
    assert((await starOnRow(hubPath)) === true, 'hub row carries its favorite');
    await markSent();
    const closed = await closeLatestSocket();
    assert(closed === true, 'browser socket closed (deltas now lost to the browser)');
    await wait(300);
    await probeA.send({ type: 'disband_hub', folderPath: hubPath });
    await probeA.send({ type: 'update_folder', folderPath: pager(70), favorite: true });
    let reconnected = false;
    for (let i = 0; i < 30 && !reconnected; i++) {
      await wait(500);
      reconnected = (await sinceMark('m.type === "list_folders"')).length > 0;
    }
    assert(reconnected === true, `client reconnects and refetches its folder window (${await pageDiag()})`);
    await wait(1500);
    await closeSessionToDashboard(); // session restore can reclaim the view on reconnect
    await folderScrollTop();
    assert((await rowRenderedNow(hubPath)) === false, 'disbanded hub does not survive the reconnect (no phantom row)');
    assert((await starOnRow(pager(70))) === true, `a change made while disconnected heals on reconnect (cache-replace) (${await pageDiag()})`);
    await browser(['screenshot', join(shotsDir, '05-reconnect.png')], { allowFailure: true });

    // ============================================================
    section('B — delta-arrived rows appear and are findable');
    // ============================================================
    const newborn = join(rootA, 'newborn-repo');
    await closeSessionToDashboard();
    await probeA.send({ type: 'create_folder', root: rootA, name: 'newborn-repo' });
    await probeB.waitForEvent('folders_changed', (e) => e.changed?.some((r) => r.path === newborn), 25_000);
    await wait(1200);
    assert((await revealFolder(newborn)) === true, 'created folder row appears via delta without a reload');
    await fillSelector(SEARCH_INPUT, 'newborn');
    await wait(1400);
    assert((await rowText(newborn)).includes('newborn-repo'), 'search finds the delta-arrived row');
    await fillSelector(SEARCH_INPUT, 'pager-new');
    await wait(1400);
    assert((await rowText(pagerNew)).includes('pager-new'), 'search finds the discovery-added row');
    await fillSelector(SEARCH_INPUT, '');
    await wait(600);

    await browser(['close'], { allowFailure: true });
  } catch (error) {
    stats.failures++;
    console.error('[fp-smoke] FAILED:', error);
    try {
      const text = await readFile(logPath, 'utf8');
      console.error('[fp-smoke] server log tail:\n' + text.slice(-8000));
    } catch {
      // Ignore missing log.
    }
    await browser(['close'], { allowFailure: true }).catch(() => {});
  } finally {
    probeA?.close();
    probeB?.close();
    await stopPimote(child).catch(() => {});
    log('server log path:', logPath);
    if (stats.failures === 0 && !process.env.FP_KEEP) await rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
    else log('sandbox preserved for inspection:', sandboxHome);
  }

  if (softFailures.length) {
    console.log(`\n[fp-smoke] environment-bounded items: ${softFailures.length}`);
    for (const item of softFailures) console.log(`  ⊝ ${item}`);
  }
  console.log(`\n[fp-smoke] complete: ${stats.failures === 0 ? 'PASS' : `${stats.failures} FAIL`}`);
  process.exit(stats.failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[fp-smoke] uncaught:', error);
  process.exit(1);
});
