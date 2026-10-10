#!/usr/bin/env node
// Boot/lifecycle smoke for the manager persona root (manager-lifecycle topic).
//
// Exercises the manager's boot-time surfaces against a real pimote server in
// an isolated HOME, driven over the wire (WsProbe) — no browser, no LLM:
//
//   1. Seeding: a fresh boot creates the default manager root
//      (`~/.local/state/pimote/manager`) with a persona-marker AGENTS.md
//      (`kind: persona`, `name: manager`, one-line description) and a
//      memory.md stub.
//   2. Seeding idempotency: a restart reseeds nothing; user-edited
//      AGENTS.md / memory.md survive restarts byte-identical.
//   3. Placement guard: an explicit managerRoot that is or contains the
//      home directory fails boot with the guidance message.
//   4. Nested manager root: a manager root inside a scan root boots; its
//      entry is excluded from list_folders rows while the response carries
//      the canonical managerRoot fact.
//   5. Persisted manager sessions: ordinary pi session records under the
//      manager root list, open folderless, replay their transcript, and stay
//      resumable after a full server restart. A run started before a
//      disconnect keeps processing server-side; the reconnecting client
//      replays from its cursor and sees the completed output.
//
// Parameterized for reuse: none of the fixtures are topic-specific beyond
// the manager root itself; the scan tree, sessions, and config variants are
// all built from the shared sandbox helpers.
//
// Inputs: MLS_KEEP=1 keeps the sandbox on a passing run.
// Outputs: per-check ✓/✗ lines on stdout; non-zero exit on hard failure.
// Prerequisites: workspaces built (`npm run build`). No browser, network,
// or LLM required. Tracks and kills only the child PID it spawns.

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { makeReporter } from '../lib/report.mjs';
import { freePort, gitInit, seedSession, startPimote, stopPimote, waitForListening } from '../lib/sandbox.mjs';
import { WsProbe } from '../lib/ws-probe.mjs';

const { assert, soft, section, log, stats } = makeReporter('ml-smoke');

const USER_AGENTS = [
  '---',
  'kind: persona',
  'name: manager',
  'description: user-owned manager persona',
  '---',
  '',
  '# Manager (user-owned)',
  '',
  'USER-OWNED MARKER. Keep your long-term notes up to date in memory.md.',
  '',
].join('\n');
const USER_MEMORY = '# Memory\n\nUSER MEMORY MARKER.\n';

async function fileOrNull(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Boot one server instance against a config; resolves once it listens. */
async function boot({ port, sandboxHome, agentDir, configPath, logPath }) {
  const child = startPimote({ port, sandboxHome, agentDir, configPath, logPath });
  await waitForListening(child, port, logPath);
  return child;
}

/** Expect a boot to fail with the placement-guard guidance in its log. */
async function expectBootFailure({ port, sandboxHome, agentDir, configPath, logPath }, label) {
  const child = startPimote({ port, sandboxHome, agentDir, configPath, logPath });
  let exited = null;
  await Promise.race([
    new Promise((resolve) => child.once('exit', (code) => {
      exited = code;
      resolve();
    })),
    new Promise((resolve) => setTimeout(resolve, 15_000)),
  ]);
  if (exited === null) {
    await stopPimote(child);
    assert(false, `${label}: boot fails (still running after 15s)`);
    return;
  }
  assert(exited !== 0, `${label}: boot fails with a non-zero exit (${exited})`);
  const logText = (await fileOrNull(logPath)) ?? '';
  assert(
    logText.includes('must not be or contain the home directory'),
    `${label}: failure names the home-containment rule`,
  );
  assert(
    logText.includes('Set managerRoot to a dedicated directory'),
    `${label}: failure carries the fix guidance`,
  );
}

async function main() {
  console.log('[ml-smoke] manager persona-root boot/lifecycle smoke');
  const sandboxHome = await mkdtemp(join(tmpdir(), 'manager-lifecycle-smoke-'));
  const configDir = join(sandboxHome, '.config', 'pimote');
  const agentDir = join(sandboxHome, 'agent');
  await mkdir(configDir, { recursive: true });
  await mkdir(join(agentDir, 'sessions'), { recursive: true });

  const managerRoot = join(sandboxHome, '.local', 'state', 'pimote', 'manager');
  const scanRoot = join(sandboxHome, 'scan');
  await gitInit(scanRoot);

  // The server resolves its config at <XDG_CONFIG_HOME>/pimote/config.json
  // (paths.ts); each boot swaps the variant into that one slot.
  const configPath = join(configDir, 'config.json');
  const writeConfig = (config) => writeFile(configPath, JSON.stringify(config, null, 2));
  await writeConfig({ roots: [scanRoot] });

  const port = await freePort();
  let child = null;
  let bootCount = 0;
  const nextLog = () => join(sandboxHome, `pimote-${++bootCount}.log`);
  const base = { port, sandboxHome, agentDir };
  log('sandbox HOME =', sandboxHome);

  try {
    // ============================================================
    section('1 — fresh boot seeds the default manager root');
    // ============================================================
    child = await boot({ ...base, configPath, logPath: nextLog() });
    const agentsSeeded = await fileOrNull(join(managerRoot, 'AGENTS.md'));
    const memorySeeded = await fileOrNull(join(managerRoot, 'memory.md'));
    assert(agentsSeeded !== null, 'default manager root AGENTS.md is created on first boot');
    assert(memorySeeded !== null, 'default manager root memory.md is created on first boot');
    assert(
      agentsSeeded?.includes('kind: persona') && /^name: manager$/m.test(agentsSeeded ?? ''),
      'seed AGENTS.md is a persona marker named "manager"',
    );
    const descriptionLine = (agentsSeeded ?? '').split('\n').find((line) => line.startsWith('description: '));
    assert(
      Boolean(descriptionLine && descriptionLine.slice('description: '.length).trim().length > 0),
      'seed AGENTS.md carries a nonempty one-line description',
    );
    assert((agentsSeeded ?? '').includes('memory.md'), 'seed AGENTS.md carries the maintain-memory.md indication');
    assert(!/pimote_/.test(agentsSeeded ?? ''), 'seed AGENTS.md lists no pimote tools (tools are injected)');
    assert((memorySeeded ?? '').trim().length > 0, 'memory.md stub is nonempty');

    // ============================================================
    section('2 — restart reseeds nothing');
    // ============================================================
    await stopPimote(child);
    child = await boot({ ...base, configPath, logPath: nextLog() });
    assert((await fileOrNull(join(managerRoot, 'AGENTS.md'))) === agentsSeeded, 'AGENTS.md byte-identical after restart');
    assert((await fileOrNull(join(managerRoot, 'memory.md'))) === memorySeeded, 'memory.md byte-identical after restart');

    // ============================================================
    section('3 — user files are never touched across restarts');
    // ============================================================
    await writeFile(join(managerRoot, 'AGENTS.md'), USER_AGENTS, 'utf8');
    await writeFile(join(managerRoot, 'memory.md'), USER_MEMORY, 'utf8');
    await stopPimote(child);
    child = await boot({ ...base, configPath, logPath: nextLog() });
    assert((await fileOrNull(join(managerRoot, 'AGENTS.md'))) === USER_AGENTS, 'user AGENTS.md survives restart byte-identical (no merge, no overwrite)');
    assert((await fileOrNull(join(managerRoot, 'memory.md'))) === USER_MEMORY, 'user memory.md survives restart byte-identical');

    // ============================================================
    section('4 — persisted manager sessions: list, folderless open, replay');
    // ============================================================
    const sessionsRoot = join(agentDir, 'sessions');
    const seededId = await seedSession(sessionsRoot, managerRoot, 'Seeded question for the manager', 'Seeded manager answer.');
    const probeA = new WsProbe(port, 'ml-probe-a');
    await probeA.open();

    const listing = await probeA.listFolders({ repin: true });
    const managerRootC = await realpath(managerRoot);
    assert(listing.data.managerRoot === managerRootC, 'list_folders reports the canonical managerRoot fact');
    assert(!listing.data.roots.includes(managerRootC), 'managerRoot is not a scan root');
    assert(!listing.data.folders.some((row) => row.path === managerRootC), 'manager root entry is not a folder row');

    const sessions = await probeA.send({ type: 'list_sessions', folderPath: managerRootC });
    assert(
      sessions.success === true && sessions.data.sessions.some((s) => s.id === seededId),
      'list_sessions lists the manager-root session record (source of the old-sessions click)',
    );

    // --- the open-new path behind the dashboard submission: a new session
    // --- at the manager root classifies the folder as the manager persona ---
    const created = await probeA.send({ type: 'open_session', folderPath: managerRootC });
    assert(created.success === true && Boolean(created.data?.sessionId), 'open_session at the manager root creates a session (submission path)');
    const createdOpened = await probeA.waitForEvent('session_opened', (e) => e.sessionId === created.data?.sessionId);
    assert(
      createdOpened?.folder?.nature === 'persona' && createdOpened?.folder?.persona?.name === 'manager',
      'manager root classifies as persona "manager" on the wire',
    );
    assert(
      createdOpened?.folder?.persona?.description === 'user-owned manager persona',
      'classification reflects the user-owned AGENTS.md, not the shipped seed',
    );
    await probeA.send({ type: 'close_session', sessionId: created.data.sessionId }).catch(() => undefined);

    const open = await probeA.send({ type: 'open_session', sessionId: seededId });
    assert(open.success === true && open.data?.sessionId === seededId, 'folderless open_session resolves the manager-root record');
    assert(open.data?.restoreMode === 'disk_full_resync', `disk record replays as disk_full_resync (got ${open.data?.restoreMode})`);
    const resync = await probeA.waitForEvent('full_resync', (e) => e.sessionId === seededId);
    const transcript = JSON.stringify(resync?.messages ?? []);
    assert(transcript.includes('Seeded manager answer.'), 'full resync replays the persisted transcript');

    // --- live session work generates replayable events (native bash) ---
    await probeA.send({ type: 'view_session', sessionId: seededId });
    const bash = await probeA.send({ type: 'bash', sessionId: seededId, command: 'echo MLS-BASH-MARKER' });
    assert(
      bash.success === true && String(bash.data?.result?.output ?? '').includes('MLS-BASH-MARKER'),
      `native bash runs in the manager session (got ${JSON.stringify(bash.data?.result ?? bash)})`,
    );

    // ============================================================
    section('5 — disconnect mid-run: processing continues; reconnect replays from the cursor');
    // ============================================================
    // Start a slow run, then drop the viewer while it is in flight.
    const inFlight = probeA.send({ type: 'bash', sessionId: seededId, command: 'sleep 4; echo MLS-CONTINUED-MARKER' }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const cursors = probeA.events.map((e) => e.event.cursor).filter((c) => typeof c === 'number');
    const lastCursor = cursors.length > 0 ? Math.max(...cursors) : null;
    soft(lastCursor !== null, 'session events carry cursors for reconnect replay', 'no cursor-tagged events observed');
    probeA.close(); // viewer gone, run still in flight
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const probeB = new WsProbe(port, 'ml-probe-b');
    await probeB.open();
    const reattach = await probeB.send({ type: 'open_session', sessionId: seededId, ...(lastCursor !== null ? { lastCursor } : {}) });
    assert(reattach.success === true, 'reconnecting client reattaches through the ordinary open_session flow');
    if (lastCursor !== null) {
      assert(
        reattach.data?.restoreMode === 'incremental_replay',
        `reconnect replays from the client's cursor (got ${reattach.data?.restoreMode})`,
      );
      await probeB.waitForEvent('session_restore', (e) => e.mode === 'incremental_replay' && e.status === 'completed');
      const buffered = probeB.events.find((e) => e.event.type === 'buffered_events' && e.event.sessionId === seededId);
      assert(Boolean(buffered), 'reconnect delivers the buffered events since the cursor');
      assert(
        (buffered?.event.events ?? []).every((ev) => ev.cursor > lastCursor),
        'replayed events are exactly the ones after the client cursor',
      );
    }
    // The in-flight run keeps processing server-side while no viewer is
    // attached; its output reaches the reconnected client (live or replayed).
    let continued = false;
    for (let i = 0; i < 25 && !continued; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continued = probeB.events.some(
        (e) =>
          (e.event.type === 'bash_execution_update' && String(e.event.delta ?? '').includes('MLS-CONTINUED-MARKER')) ||
          (e.event.type === 'buffered_events' && (e.event.events ?? []).some((ev) => String(ev.delta ?? '').includes('MLS-CONTINUED-MARKER'))),
      );
    }
    assert(continued, 'run keeps processing while the viewer is gone; the reconnected client sees its output');
    await inFlight;
    const bash2 = await probeB.send({ type: 'bash', sessionId: seededId, command: 'echo MLS-BASH-AFTER-RECONNECT' });
    assert(
      bash2.success === true && String(bash2.data?.result?.output ?? '').includes('MLS-BASH-AFTER-RECONNECT'),
      'session is fully usable after the viewer change (server-owned, never torn down)',
    );
    probeB.close();

    // ============================================================
    section('6 — full server restart: manager sessions stay resumable');
    // ============================================================
    await stopPimote(child);
    child = await boot({ ...base, configPath, logPath: nextLog() });
    const probeC = new WsProbe(port, 'ml-probe-c');
    await probeC.open();
    const sessionsAfter = await probeC.send({ type: 'list_sessions', folderPath: managerRootC });
    assert(
      sessionsAfter.success === true && sessionsAfter.data.sessions.some((s) => s.id === seededId),
      'manager session record survives a full server restart',
    );
    const reopen = await probeC.send({ type: 'open_session', sessionId: seededId });
    assert(reopen.success === true && reopen.data?.sessionId === seededId, 'old manager session reopens after restart (behind-the-click journey)');
    const resync2 = await probeC.waitForEvent('full_resync', (e) => e.sessionId === seededId);
    assert(
      JSON.stringify(resync2?.messages ?? []).includes('Seeded manager answer.'),
      'reopened session replays its persisted transcript',
    );
    probeC.close();
    await stopPimote(child);
    child = null;

    // ============================================================
    section('7 — placement guard: home manager roots fail boot');
    // ============================================================
    await writeConfig({ roots: [scanRoot], managerRoot: '~' });
    await expectBootFailure({ ...base, configPath, logPath: nextLog() }, 'managerRoot "~"');
    await writeConfig({ roots: [scanRoot], managerRoot: dirname(sandboxHome) });
    await expectBootFailure({ ...base, configPath, logPath: nextLog() }, 'managerRoot containing home');

    // ============================================================
    section('8 — nested manager root boots and is excluded from listings');
    // ============================================================
    const nestedScan = join(sandboxHome, 'nested-scan');
    const nestedKeep = join(nestedScan, 'keep');
    const nestedMgr = join(nestedScan, 'mgr');
    await gitInit(nestedKeep);
    await writeConfig({ roots: [nestedScan], managerRoot: nestedMgr });
    child = await boot({ ...base, configPath, logPath: nextLog() });
    const nestedSeeded = await fileOrNull(join(nestedMgr, 'AGENTS.md'));
    assert((nestedSeeded ?? '').includes('name: manager'), 'nested manager root seeds its persona marker');
    const probeD = new WsProbe(port, 'ml-probe-d');
    await probeD.open();
    const nestedListing = await probeD.listFolders({ repin: true });
    const nestedMgrC = await realpath(nestedMgr);
    const nestedKeepC = await realpath(nestedKeep);
    assert(nestedListing.data.managerRoot === nestedMgrC, 'nested config boots and reports its managerRoot fact');
    assert(
      !nestedListing.data.folders.some((row) => row.path === nestedMgrC),
      'manager-root entry is excluded from folder listing rows',
    );
    assert(
      nestedListing.data.folders.some((row) => row.path === nestedKeepC),
      'sibling folder inside the same scan root still lists',
    );
    probeD.close();
    log('note: sparse-tree exclusion of the manager entry is pinned by server unit tests (index.test.ts)');
    log('note: no wire surface exposes the folder tree outside the manager toolset');
  } finally {
    if (child) await stopPimote(child);
  }

  const keep = process.env.MLS_KEEP === '1';
  if (stats.failures === 0 && !keep) await rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
  else log('sandbox preserved at', sandboxHome);
  if (keep) {
    const logs = (await readdir(sandboxHome).catch(() => [])).filter((name) => name.startsWith('pimote-'));
    log('boot logs:', logs.join(', '));
  }
  console.log(`\n[ml-smoke] complete: ${stats.failures === 0 ? 'PASS' : `${stats.failures} FAIL`}`);
  process.exit(stats.failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[ml-smoke] uncaught:', error);
  process.exit(1);
});
