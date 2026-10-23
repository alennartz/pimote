#!/usr/bin/env node
// PWA-side smoke for per-assistant and complete-session cost accounting.
//
// No live LLM is needed. The fixture is a real pi session JSONL with:
//   - two assistant rows and matching nested tool-result usage;
//   - an unrelated tool result, compaction, branch summary, and usage entry;
//   - category costs whose sum is smaller than Pi's authoritative total.
//
// The smoke checks the persisted metadata and replay boundary, then drives the
// real PWA through accessible cost buttons and popovers. It also dispatches a
// small sequence of protocol events through the browser's live socket to cover
// replacement of partial snapshots and the client-only terminal fallback.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { WsProbe } from '../lib/ws-probe.mjs';
import { makeBrowserHelpers } from '../lib/browser.mjs';
import { seedSessionDir } from '../lib/session-dir.mjs';

const REPO_ROOT = pathResolve(new URL('../../../', import.meta.url).pathname);
const PIMOTE_BIN = join(REPO_ROOT, 'bin', 'pimote.js');

let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}
function section(name) {
  console.log(`\n[cost-smoke] ${name}`);
}
function log(...args) {
  console.log('[cost-smoke]', ...args);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForListening(child, port, logPath) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`pimote exited early with code ${child.exitCode}; see ${logPath}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (response.status < 500) return;
    } catch {
      // Retry until the server accepts HTTP requests.
    }
    await sleep(200);
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
  await Promise.race([once(child, 'exit'), sleep(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function usage(cost, tokens, scale = 1, subsets = {}) {
  const scaledCost = Object.fromEntries(Object.entries(cost).map(([key, value]) => [key, value * scale]));
  return {
    input: tokens.input * scale,
    output: tokens.output * scale,
    cacheRead: tokens.cacheRead * scale,
    cacheWrite: tokens.cacheWrite * scale,
    totalTokens: (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite) * scale,
    ...(subsets.cacheWrite1h === undefined ? {} : { cacheWrite1h: subsets.cacheWrite1h * scale }),
    ...(subsets.reasoning === undefined ? {} : { reasoning: subsets.reasoning * scale }),
    cost: {
      input: scaledCost.input,
      output: scaledCost.output,
      cacheRead: scaledCost.cacheRead,
      cacheWrite: scaledCost.cacheWrite,
      total: scaledCost.total,
    },
  };
}

function addUsageTotals(total, value) {
  total.input += value.cost.input;
  total.output += value.cost.output;
  total.cacheRead += value.cost.cacheRead;
  total.cacheWrite += value.cost.cacheWrite;
  total.total += value.cost.total;
  total.tokens.input += value.input;
  total.tokens.output += value.output;
  total.tokens.cacheRead += value.cacheRead;
  total.tokens.cacheWrite += value.cacheWrite;
}

function summarizeUsages(usages) {
  const total = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  for (const value of usages) addUsageTotals(total, value);
  total.tokens.total = total.tokens.input + total.tokens.output + total.tokens.cacheRead + total.tokens.cacheWrite;
  return total;
}

function makeSessionMessage({ id, parentId, message }) {
  return { type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { ...message, timestamp: Date.now() } };
}

// Build a pi session JSONL chain. Usage-bearing entries on an alternate branch
// remain in getEntries() and Pi's complete-session stats, while the current
// leaf keeps the normal two-turn transcript visible in the PWA.
function fabricateSession({ cwd, promptLabel, scale = 1 }) {
  const sessionId = randomUUID();
  const isoNow = new Date().toISOString();
  const lines = [{ type: 'session', version: 3, id: sessionId, timestamp: isoNow, cwd }];
  const usages = [];
  let previousId = null;
  const nextId = () => randomUUID().slice(0, 8);
  const addEntry = (entry) => {
    lines.push(entry);
    previousId = entry.id;
    return entry.id;
  };
  const addBranchEntry = (entry) => {
    lines.push(entry);
    return entry.id;
  };

  addEntry({ type: 'model_change', id: nextId(), parentId: previousId, timestamp: isoNow, provider: 'fabricated', modelId: 'gpt-5.3-codex' });

  const assistantOneUsage = usage(
    { input: 0.4, output: 0.2, cacheRead: 0.1, cacheWrite: 0.05, total: 0.8 },
    { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
    scale,
    { cacheWrite1h: 50, reasoning: 120 },
  );
  const nestedOneUsage = usage(
    { input: 0.05, output: 0.03, cacheRead: 0.01, cacheWrite: 0.01, total: 0.12 },
    { input: 200, output: 80, cacheRead: 40, cacheWrite: 20 },
    scale,
  );
  const assistantTwoUsage = usage(
    { input: 0.3, output: 0.15, cacheRead: 0.04, cacheWrite: 0.02, total: 0.55 },
    { input: 900, output: 300, cacheRead: 100, cacheWrite: 40 },
    scale,
  );
  const nestedTwoUsage = usage(
    { input: 0.02, output: 0.01, cacheRead: 0.01, cacheWrite: 0.005, total: 0.05 },
    { input: 100, output: 40, cacheRead: 20, cacheWrite: 10 },
    scale,
  );
  const unrelatedToolUsage = usage(
    { input: 0.08, output: 0.04, cacheRead: 0.02, cacheWrite: 0.01, total: 0.1 },
    { input: 50, output: 20, cacheRead: 10, cacheWrite: 5 },
    scale,
  );
  const compactionUsage = usage(
    { input: 0.01, output: 0.005, cacheRead: 0.003, cacheWrite: 0.002, total: 0.021 },
    { input: 30, output: 20, cacheRead: 10, cacheWrite: 5 },
    scale,
  );
  const branchSummaryUsage = usage(
    { input: 0.004, output: 0.002, cacheRead: 0.001, cacheWrite: 0.001, total: 0.009 },
    { input: 20, output: 10, cacheRead: 5, cacheWrite: 2 },
    scale,
  );
  const usageEntryUsage = usage(
    { input: 0.003, output: 0.001, cacheRead: 0.002, cacheWrite: 0.001, total: 0.01 },
    { input: 12, output: 8, cacheRead: 4, cacheWrite: 2 },
    scale,
  );
  usages.push(assistantOneUsage, nestedOneUsage, assistantTwoUsage, nestedTwoUsage, unrelatedToolUsage, compactionUsage, branchSummaryUsage, usageEntryUsage);

  const userOneId = addEntry(
    makeSessionMessage({
      cwd,
      id: nextId(),
      parentId: previousId,
      message: { role: 'user', content: [{ type: 'text', text: `${promptLabel} 1` }] },
    }),
  );
  const assistantOneId = addEntry(
    makeSessionMessage({
      cwd,
      id: nextId(),
      parentId: previousId,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect the project and delegate one nested lookup.' },
          { type: 'toolCall', id: 'nested-lookup-1', name: 'model_lookup', arguments: { query: 'costs' } },
        ],
        api: 'openai-responses',
        provider: 'fabricated',
        model: 'gpt-5.3-codex',
        usage: assistantOneUsage,
        stopReason: 'toolUse',
        responseId: 'resp_assistant_1',
      },
    }),
  );
  addEntry(
    makeSessionMessage({
      cwd,
      id: nextId(),
      parentId: previousId,
      message: {
        role: 'toolResult',
        toolCallId: 'nested-lookup-1',
        toolName: 'model_lookup',
        content: [{ type: 'text', text: 'nested lookup complete' }],
        usage: nestedOneUsage,
        nestedCalls: { calls: [{ id: 'nested-lookup-1', name: 'model_lookup', status: 'ok' }], complete: true },
        isError: false,
      },
    }),
  );

  const userTwoId = addEntry(
    makeSessionMessage({
      cwd,
      id: nextId(),
      parentId: previousId,
      message: { role: 'user', content: [{ type: 'text', text: `${promptLabel} 2` }] },
    }),
  );
  const assistantTwoId = addEntry(
    makeSessionMessage({
      cwd,
      id: nextId(),
      parentId: previousId,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'The second response has an independent nested call.' },
          { type: 'toolCall', id: 'nested-lookup-2', name: 'model_lookup', arguments: { query: 'breakdown' } },
        ],
        api: 'openai-responses',
        provider: 'fabricated',
        model: 'gpt-5.3-codex',
        usage: assistantTwoUsage,
        stopReason: 'toolUse',
        responseId: 'resp_assistant_2',
      },
    }),
  );
  addEntry(
    makeSessionMessage({
      cwd,
      id: nextId(),
      parentId: previousId,
      message: {
        role: 'toolResult',
        toolCallId: 'nested-lookup-2',
        toolName: 'model_lookup',
        content: [{ type: 'text', text: 'second nested lookup complete' }],
        usage: nestedTwoUsage,
        nestedCalls: { calls: [{ id: 'nested-lookup-2', name: 'model_lookup', status: 'ok' }], complete: true },
        isError: false,
      },
    }),
  );

  // This usage-bearing tool result has no matching tool_call in the current
  // assistant rows. It belongs in the complete-session total, not either row.
  addEntry(
    makeSessionMessage({
      cwd,
      id: nextId(),
      parentId: previousId,
      message: {
        role: 'toolResult',
        toolCallId: 'unrelated-tool-call',
        toolName: 'unrelated_lookup',
        content: [{ type: 'text', text: 'unrelated result' }],
        usage: unrelatedToolUsage,
        isError: false,
      },
    }),
  );

  // These entries are on an alternate branch. Pi still includes them in its
  // complete-session totals, while the current leaf remains the transcript
  // above. Their presence catches regressions that only sum assistant rows.
  addBranchEntry({
    type: 'compaction',
    id: nextId(),
    parentId: assistantOneId,
    timestamp: isoNow,
    summary: 'compacted branch summary',
    firstKeptEntryId: userTwoId,
    tokensBefore: 1600,
    usage: compactionUsage,
  });
  addBranchEntry({
    type: 'branch_summary',
    id: nextId(),
    parentId: assistantOneId,
    timestamp: isoNow,
    fromId: assistantOneId,
    summary: 'alternate branch summary',
    usage: branchSummaryUsage,
  });
  addBranchEntry({
    type: 'usage',
    id: nextId(),
    parentId: assistantOneId,
    timestamp: isoNow,
    kind: 'cache_warm',
    provider: 'fabricated',
    model: 'gpt-5.3-codex',
    usage: usageEntryUsage,
    note: 'persisted smoke usage',
  });

  // Make the normal transcript the selected leaf again. Custom entries do not
  // render as messages, but their parent keeps the current branch on tool 2.
  lines.push({
    type: 'custom',
    id: nextId(),
    parentId: previousId,
    timestamp: isoNow,
    customType: 'cost-smoke-anchor',
    data: { currentLeaf: assistantTwoId },
  });

  return { lines, sessionId, expected: summarizeUsages(usages), assistantIds: [assistantOneId, assistantTwoId] };
}

async function seedSession({ sandboxHome, projectDir, lines, sessionId }) {
  const sessionDir = seedSessionDir(join(sandboxHome, '.pi', 'agent', 'sessions'), projectDir);
  await mkdir(sessionDir, { recursive: true });
  const filenameStamp = new Date().toISOString().replace(/:/g, '-');
  const sessionPath = join(sessionDir, `${filenameStamp}_${sessionId}.jsonl`);
  await writeFile(sessionPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return sessionPath;
}

async function openSnapshot({ port, sessionId, folderPath, label }) {
  const probe = new WsProbe(port, `cost-smoke-${label}-${randomUUID().slice(0, 8)}`);
  await probe.open();
  const opened = await probe.send({ type: 'open_session', folderPath, sessionId });
  if (!opened.success) {
    probe.close();
    throw new Error(`open_session ${label} failed: ${opened.error ?? 'unknown error'}`);
  }
  const openedSessionId = opened.data?.sessionId ?? sessionId;
  const fullResync = await probe.waitForEvent(
    'full_resync',
    (event) => event.sessionId === openedSessionId || event.sessionId === sessionId,
    15_000,
  );
  const metaResponse = await probe.send({ type: 'get_session_meta', sessionId: openedSessionId });
  if (!metaResponse.success) {
    probe.close();
    throw new Error(`get_session_meta ${label} failed: ${metaResponse.error ?? 'unknown error'}`);
  }
  return { probe, openedSessionId, fullResync, meta: metaResponse.data?.meta };
}

function visibleCurrencyButtonsExpression() {
  return `Array.from(document.querySelectorAll('button')).map((button) => ({
    text: button.textContent?.trim() ?? '',
    ariaLabel: button.getAttribute('aria-label'),
    expanded: button.getAttribute('aria-expanded'),
  })).filter(({ text }) => /^(?:<)?\\$\\d+(?:\\.\\d{2})$/.test(text))`;
}

function visibleDialogsExpression() {
  return `Array.from(document.querySelectorAll('[data-slot="popover-content"], [role="dialog"]')).filter((dialog, index, all) => {
    if (all.indexOf(dialog) !== index) return false;
    const style = getComputedStyle(dialog);
    return style.display !== 'none' && style.visibility !== 'hidden' && dialog.getAttribute('data-state') !== 'closed';
  }).map((dialog) => dialog.textContent?.trim() ?? '')`;
}

function clickCostExpression(display) {
  return `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(display)} && candidate.hasAttribute('aria-expanded'));
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

function dispatchBrowserEventsExpression(events) {
  return `(() => {
    const socket = (window.__pmSockets ?? []).find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) return { ok: false, reason: 'no captured open socket' };
    for (const event of ${JSON.stringify(events)}) {
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
    }
    return { ok: true, count: ${events.length} };
  })()`;
}

async function clickSessionRow(browser, firstMessage) {
  const clicked = await browser.evalBrowser(`(() => {
    const target = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(${JSON.stringify(firstMessage)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked) {
    await browser.browser(['find', 'role', 'button', 'click', '--name', firstMessage]);
  }
  await browser.wait(2_500);
}

async function main() {
  console.log('[cost-smoke] per-assistant-turn-cost PWA-side smoke');

  const sandboxHome = await mkdtemp(join(tmpdir(), 'cost-accumulation-smoke-'));
  const configDir = join(sandboxHome, '.config', 'pimote');
  await mkdir(configDir, { recursive: true });
  const projectsRoot = join(sandboxHome, 'projects');
  const pricedProject = join(projectsRoot, 'priced-project');
  const zeroProject = join(projectsRoot, 'zero-project');
  for (const project of [pricedProject, zeroProject]) {
    await mkdir(join(project, '.git'), { recursive: true });
    await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  }

  const port = await getFreePort();
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ roots: [projectsRoot], port, bufferSize: 100 }, null, 2));
  const logPath = join(sandboxHome, 'pimote.log');
  log('sandbox HOME =', sandboxHome);
  log('port         =', port);

  const priced = fabricateSession({ cwd: pricedProject, promptLabel: 'priced prompt' });
  const zero = fabricateSession({ cwd: zeroProject, promptLabel: 'zero prompt', scale: 0 });
  const pricedPath = await seedSession({ sandboxHome, projectDir: pricedProject, ...priced });
  const zeroPath = await seedSession({ sandboxHome, projectDir: zeroProject, ...zero });
  const expected = priced.expected;
  const expectedSessionDisplay = '$' + expected.total.toFixed(2);
  const expectedRowDisplays = ['$0.92', '$0.60'];
  const expectedKnownCost = expected.input + expected.output + expected.cacheRead + expected.cacheWrite;
  const expectedUnknown = expected.total - expectedKnownCost;

  let child;
  let pricedWire;
  let zeroWire;
  let browser;
  try {
    section('Fabricate persisted usage entries');
    assert(true, `seeded priced session (Pi total ${expectedSessionDisplay}, known categories $${expectedKnownCost.toFixed(3)}, ${pricedPath})`);
    assert(true, `seeded zero-spend session (${zeroPath})`);

    section('Boot pimote and inspect complete-session metadata');
    child = startPimote({ port, sandboxHome, logPath });
    await waitForListening(child, port, logPath);
    pricedWire = await openSnapshot({ port, sessionId: priced.sessionId, folderPath: pricedProject, label: 'priced' });
    zeroWire = await openSnapshot({ port, sessionId: zero.sessionId, folderPath: zeroProject, label: 'zero' });

    const pricedMeta = pricedWire.meta;
    const zeroMeta = zeroWire.meta;
    assert(typeof pricedMeta?.lifetimeCostUsd === 'number', `priced metadata carries Pi lifetimeCostUsd (got ${JSON.stringify(pricedMeta?.lifetimeCostUsd)})`);
    assert(Math.abs((pricedMeta?.lifetimeCostUsd ?? 0) - expected.total) < 1e-9, `priced lifetime total includes every persisted usage entry (${expectedSessionDisplay}, got ${pricedMeta?.lifetimeCostUsd})`);
    assert(pricedMeta?.usageBreakdown?.cost && !Object.hasOwn(pricedMeta.usageBreakdown.cost, 'total'), 'priced metadata exposes category costs without a second scalar total');
    for (const category of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const actual = pricedMeta?.usageBreakdown?.cost?.[category];
      assert(Math.abs((actual ?? 0) - expected[category]) < 1e-9, `priced ${category} cost includes assistant, tool, compaction, branch, and usage entries (got ${actual})`);
    }
    assert(Math.abs((pricedMeta?.usageBreakdown?.cost?.input ?? 0) + (pricedMeta?.usageBreakdown?.cost?.output ?? 0) + (pricedMeta?.usageBreakdown?.cost?.cacheRead ?? 0) + (pricedMeta?.usageBreakdown?.cost?.cacheWrite ?? 0) - expectedKnownCost) < 1e-9, 'priced category rollup retains actual cache-read and cache-write costs');
    assert(expectedUnknown > 0.01, `priced scalar total leaves a positive Unknown remainder ($${expectedUnknown.toFixed(4)})`);
    assert(pricedMeta?.usageBreakdown?.tokens?.total === expected.tokens.total, `priced token total follows Pi session stats (${expected.tokens.total})`);
    assert(zeroMeta?.lifetimeCostUsd === 0, `zero-spend metadata reports lifetimeCostUsd 0 (got ${zeroMeta?.lifetimeCostUsd})`);
    assert(zeroMeta?.usageBreakdown?.cost?.cacheRead === 0 && zeroMeta?.usageBreakdown?.cost?.cacheWrite === 0, 'zero-spend metadata keeps zero actual cache costs');

    const replayMessages = pricedWire.fullResync.messages ?? [];
    const replayAssistants = replayMessages.filter((message) => message.role === 'assistant');
    const replayToolResults = replayMessages.filter((message) => message.role === 'toolResult');
    assert(replayAssistants.length === 2, `full resync replays two separate assistant rows (got ${replayAssistants.length})`);
    assert(replayAssistants.every((message) => message.usage?.cost?.total > 0), 'full resync preserves final assistant usage');
    const hasToolUsage = (messages, toolCallId, total) =>
      messages.some(
        (message) =>
          message.content?.some((block) => block.type === 'tool_result' && block.toolCallId === toolCallId) &&
          message.usage?.cost?.total === total,
      );
    assert(hasToolUsage(replayToolResults, 'nested-lookup-1', 0.12), 'full resync preserves matching nested tool-result usage');
    assert(hasToolUsage(replayToolResults, 'nested-lookup-2', 0.05), 'full resync preserves the second nested tool-result usage');

    section('Drive accessible cost buttons and popovers');
    const baseUrl = `http://127.0.0.1:${port}`;
    browser = makeBrowserHelpers({ session: `cost-smoke-${process.pid}-${randomUUID().slice(0, 8)}`, log });
    await browser.browser(['close'], { allowFailure: true });
    await browser.browser(['open', `${baseUrl}/`]);
    await browser.wait(3_000);
    await browser.installSocketProbe();
    await clickSessionRow(browser, 'priced prompt 1');

    const pricedButtons = await browser.evalBrowser(visibleCurrencyButtonsExpression());
    const pricedButtonTexts = pricedButtons.map((button) => button.text);
    assert(pricedButtons.every((button) => button.expanded === 'false'), 'cost figures render as collapsed accessible buttons');
    assert(pricedButtonTexts.includes(expectedSessionDisplay), `session cost button shows authoritative ${expectedSessionDisplay} (got ${JSON.stringify(pricedButtonTexts)})`);
    for (const rowDisplay of expectedRowDisplays) {
      assert(pricedButtonTexts.includes(rowDisplay), `assistant row cost button shows ${rowDisplay} (got ${JSON.stringify(pricedButtonTexts)})`);
    }
    assert(pricedButtons.every((button) => button.ariaLabel), 'cost buttons expose accessible context labels');

    assert((await browser.evalBrowser(clickCostExpression(expectedSessionDisplay))) === true, 'clicking the session cost button opens its popover');
    await browser.wait(200);
    let dialogs = await browser.evalBrowser(visibleDialogsExpression());
    const sessionDialog = dialogs.at(-1) ?? '';
    assert(/Input/i.test(sessionDialog) && /Output/i.test(sessionDialog) && /Cache read/i.test(sessionDialog) && /Cache write/i.test(sessionDialog), 'session popover shows all four cost categories');
    assert(sessionDialog.includes('Unknown') && sessionDialog.includes(expectedSessionDisplay), 'session popover shows the positive Unknown remainder and authoritative total');
    assert(!/Tools/i.test(sessionDialog), 'session popover has no synthetic Tools category');
    assert(
      sessionDialog.includes(`$${expected.input.toFixed(4)}`) &&
        sessionDialog.includes(`$${expected.output.toFixed(4)}`) &&
        sessionDialog.includes(`$${expected.cacheRead.toFixed(4)}`) &&
        sessionDialog.includes(`$${expected.cacheWrite.toFixed(4)}`),
      'session popover shows four-decimal category costs',
    );

    assert((await browser.evalBrowser(clickCostExpression('$0.92'))) === true, 'opening a row popover closes the session popover');
    await browser.wait(200);
    dialogs = await browser.evalBrowser(visibleDialogsExpression());
    const rowDialog = dialogs[0] ?? '';
    assert(dialogs.length === 1 && rowDialog.includes('Total $0.92'), 'row popover shows the assistant plus matching nested tool total');
    assert(!rowDialog.includes('unrelated'), 'row popover does not include an unrelated tool result');

    await browser.browser(['press', 'Escape']);
    await browser.wait(100);
    assert((await browser.evalBrowser(visibleDialogsExpression())).length === 0, 'Escape closes the active cost popover');
    assert((await browser.evalBrowser(clickCostExpression('$0.60'))) === true, 'second assistant row opens by its accessible cost button');
    await browser.wait(150);
    await browser.browser(['press', 'Escape']);
    assert((await browser.evalBrowser(visibleDialogsExpression())).length === 0, 'row popover closes after keyboard Escape');

    assert((await browser.evalBrowser(clickCostExpression(expectedSessionDisplay))) === true, 'session popover reopens for outside-click testing');
    await browser.wait(100);
    await browser.evalBrowser(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 2, clientY: 2 }))`);
    await browser.wait(150);
    assert((await browser.evalBrowser(visibleDialogsExpression())).length === 0, 'outside click closes the cost popover');
    await browser.browser(['screenshot', join(sandboxHome, 'priced-costs.png')], { allowFailure: true });

    section('Live snapshots, terminal partial fallback, resync, and reload');
    const partialOne = usage(
      { input: 0.05, output: 0.02, cacheRead: 0.01, cacheWrite: 0.005, total: 0.11 },
      { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 },
    );
    const partialTwo = usage(
      { input: 0.1, output: 0.08, cacheRead: 0.04, cacheWrite: 0.03, total: 0.25 },
      { input: 200, output: 50, cacheRead: 20, cacheWrite: 10 },
    );
    const syntheticSessionId = pricedWire.openedSessionId;
    const partialStart = { type: 'message_start', sessionId: syntheticSessionId, role: 'assistant', usage: partialOne };
    const partialUpdate = {
      type: 'message_update',
      sessionId: syntheticSessionId,
      contentIndex: 0,
      subtype: 'start',
      content: { type: 'text', text: '' },
      usage: partialTwo,
    };
    const injected = await browser.evalBrowser(dispatchBrowserEventsExpression([partialStart, partialUpdate]));
    assert(injected?.ok === true, `captured the live PWA socket for partial snapshot injection (got ${JSON.stringify(injected)})`);
    await browser.wait(300);
    const streamingButtons = await browser.evalBrowser(visibleCurrencyButtonsExpression());
    assert(streamingButtons.some((button) => button.text === '$0.25'), 'a newer partial usage snapshot replaces, rather than adds to, the previous snapshot');

    const terminal = {
      type: 'message_end',
      sessionId: syntheticSessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'aborted response' }], aborted: true },
    };
    await browser.evalBrowser(dispatchBrowserEventsExpression([terminal]));
    await browser.wait(300);
    const fallbackButtons = await browser.evalBrowser(visibleCurrencyButtonsExpression());
    assert(fallbackButtons.some((button) => button.text === '$0.25'), 'terminal partial-only usage remains visible as the active-view fallback');

    const inFlightResync = {
      ...pricedWire.fullResync,
      sessionId: syntheticSessionId,
      state: { ...pricedWire.fullResync.state, isStreaming: true },
      streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'in-flight response' }], usage: partialTwo },
    };
    await browser.evalBrowser(dispatchBrowserEventsExpression([inFlightResync]));
    await browser.wait(300);
    const inFlightButtons = await browser.evalBrowser(visibleCurrencyButtonsExpression());
    assert(inFlightButtons.some((button) => button.text === '$0.25'), 'in-flight full resync restores the latest streaming usage snapshot');

    const resyncEvent = { ...pricedWire.fullResync, sessionId: syntheticSessionId, streamingMessage: null };
    await browser.evalBrowser(dispatchBrowserEventsExpression([resyncEvent]));
    await browser.wait(300);
    const resyncedButtons = await browser.evalBrowser(visibleCurrencyButtonsExpression());
    assert(!resyncedButtons.some((button) => button.text === '$0.25'), 'settled full resync drops the transient terminal fallback');
    assert(resyncedButtons.some((button) => button.text === '$0.92') && resyncedButtons.some((button) => button.text === '$0.60'), 'full resync keeps persisted final row usage');

    await browser.browser(['open', `${baseUrl}/`]);
    await browser.wait(2_000);
    await clickSessionRow(browser, 'priced prompt 1');
    const reloadedButtons = await browser.evalBrowser(visibleCurrencyButtonsExpression());
    assert(reloadedButtons.some((button) => button.text === expectedSessionDisplay), 'reload preserves Pi complete-session total');
    assert(reloadedButtons.some((button) => button.text === '$0.92') && reloadedButtons.some((button) => button.text === '$0.60'), 'reload preserves persisted assistant-row usage');
    assert(!reloadedButtons.some((button) => button.text === '$0.25'), 'reload does not restore the client-only partial fallback');
    await browser.browser(['screenshot', join(sandboxHome, 'reloaded-costs.png')], { allowFailure: true });

    section('Zero-spend session hides cost disclosure');
    await browser.browser(['open', `${baseUrl}/`]);
    await browser.wait(2_000);
    await clickSessionRow(browser, 'zero prompt 1');
    const zeroButtons = await browser.evalBrowser(visibleCurrencyButtonsExpression());
    assert(zeroButtons.length === 0, 'zero-spend session renders no cost button');
    await browser.browser(['screenshot', join(sandboxHome, 'zero-costs.png')], { allowFailure: true });
  } catch (error) {
    console.error('[cost-smoke] FAILED:', error);
    failures++;
    try {
      await browser?.browser(['close'], { allowFailure: true });
    } catch {
      // Preserve the original failure and sandbox for diagnosis.
    }
  } finally {
    pricedWire?.probe.close();
    zeroWire?.probe.close();
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

main().catch((error) => {
  console.error('[cost-smoke] uncaught', error);
  process.exit(1);
});
