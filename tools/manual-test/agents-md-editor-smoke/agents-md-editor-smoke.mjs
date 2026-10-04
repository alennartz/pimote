#!/usr/bin/env node
// Smoke for the agents-md-editor topic: the home-page "Agent instructions"
// entry → config-file editor dialog on `~/.pi/agent/AGENTS.md`.
//
// One phase, against a real pimote booted on a sandboxed HOME (own XDG dirs,
// a seeded AGENTS.md, `tagSnippets` in the pimote config, and a one-repo
// project tree for a plausible dashboard). Driven via agent-browser (real
// Chromium):
//
//   1. Entry — snapshot exposes the "Agent instructions" button in the
//      Projects header; clicking its ref opens the dialog.
//   2. Open  — header shows the title and the resolved absolute sandbox path
//      to `~/.pi/agent/AGENTS.md`; the editor loads the file's content; the
//      Tag toolbar button and the `tagSnippets` palette (note, todo) render.
//   3. Edit + save round-trip — text typed through the real input path,
//      Save closes the dialog, the file on disk holds exactly the edited
//      text; reopening shows the saved content (load path + clean baseline).
//   4. Tag-wrap freeform — a selection is wrapped inline as `<mytag>…</mytag>`
//      via the Tag button + input + Enter, with the selection restored on the
//      inner range.
//   5. Tag-wrap snippet — the one-tap `note` button block-inserts
//      `<note>\n\n</note>` at the (collapsed) cursor.
//   6. Cancel / discard-confirm — Cancel with unsaved edits opens the discard
//      confirmation; "Keep editing" restores the editor with edits intact;
//      Esc is vetoed into the same confirmation; "Discard" closes without
//      touching disk.
//
// No live LLM or network required. Tracks and kills only the child PID it
// spawns — no pattern-based `pkill`. See README.md alongside this file and
// docs/manual-tests/agents-md-editor.md.

import { spawn, execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile, appendFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve, basename } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const REPO_ROOT = pathResolve(new URL('../../../', import.meta.url).pathname);
const PIMOTE_BIN = join(REPO_ROOT, 'bin', 'pimote.js');
const BROWSER_SESSION = `am-smoke-${process.pid}`;

const SEED_CONTENT = '# Agent instructions\n\noriginal line\n';

let failures = 0;
let typingFallbackUsed = false;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}
function section(name) {
  console.log(`\n[am-smoke] ${name}`);
}
function log(...args) {
  console.log('[am-smoke]', ...args);
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await wait(intervalMs);
  }
  return false;
}

// ------------------------------------------------------------------ server

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function startPimote({ port, sandboxHome, logPath }) {
  const env = {
    ...process.env,
    HOME: sandboxHome,
    XDG_CONFIG_HOME: join(sandboxHome, '.config'),
    XDG_STATE_HOME: join(sandboxHome, '.local', 'state'),
    XDG_DATA_HOME: join(sandboxHome, '.local', 'share'),
    XDG_CACHE_HOME: join(sandboxHome, '.cache'),
    NODE_ENV: 'production',
  };
  const child = spawn(process.execPath, [PIMOTE_BIN, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tee = (chunk) => void appendFile(logPath, chunk).catch(() => {});
  child.stdout.on('data', tee);
  child.stderr.on('data', tee);
  return child;
}

async function stopPimote(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), wait(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await wait(300);
}

async function waitForListening(child, port, logPath) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`pimote exited early (${child.exitCode}); see ${logPath}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // retry while boot completes
    }
    await wait(200);
  }
  throw new Error(`pimote did not listen on :${port} within 30s; see ${logPath}`);
}

async function gitInit(dir, branch = 'main') {
  await mkdir(dir, { recursive: true });
  const git = (...args) => execFile('git', ['-C', dir, ...args]);
  await git('init', '-b', branch);
  await writeFile(join(dir, 'README.md'), `# ${basename(dir)}\n`);
  await git('add', '.');
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init');
}

// ------------------------------------------------------------ agent-browser

async function browser(args, { allowFailure = false, timeoutMs = 30_000, retries = 2 } = {}) {
  const fullArgs = ['--session', BROWSER_SESSION, ...args];
  log('agent-browser', args.join(' '));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const child = spawn('agent-browser', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
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
        console.error(`[am-smoke] agent-browser failed: ${args.join(' ')}\n${stderr}`);
        throw new Error(`agent-browser failed: ${args.join(' ')}`);
      }
      return { stdout, stderr, code: child.exitCode };
    }
    await wait(800 * (attempt + 1));
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

async function evalJs(expression) {
  return parseEval((await browser(['eval', expression])).stdout);
}

// --- CodeMirror helpers. The view is reached through the DOM
//     (`EditorView.findFromDOM` semantics) and never returned to the caller —
//     each helper runs wholly in page context and returns plain data.

// Replicates `EditorView.findFromDOM`: any editor DOM node carries a
// `cmTile`; the tile chain's root is the DocTile holding the view. (A
// `cmView` walk is kept as a fallback for older @codemirror/view builds.)
const CM_VIEW_LOOKUP = `(() => {
  const ed = document.querySelector('.cm-editor');
  if (!ed) return null;
  const content = ed.querySelector('.cm-content');
  for (const n of [content, ed]) {
    const tile = n && n.cmTile;
    if (tile && tile.root && tile.root.view) return tile.root.view;
  }
  let n = content;
  while (n) {
    if (n.cmTile && n.cmTile.root && n.cmTile.root.view) return n.cmTile.root.view;
    if (n.cmView && n.cmView.view) return n.cmView.view;
    n = n.parentElement;
  }
  return null;
})()`;

async function cmText() {
  return await evalJs(`(() => { const v = ${CM_VIEW_LOOKUP}; return v ? v.state.doc.toString() : 'NO_VIEW'; })()`);
}

async function cmSelection() {
  return await evalJs(`(() => {
    const v = ${CM_VIEW_LOOKUP};
    if (!v) return null;
    const { from, to } = v.state.selection.main;
    return { from, to };
  })()`);
}

async function setCaret(from, to = from) {
  return await evalJs(`(() => {
    const v = ${CM_VIEW_LOOKUP};
    if (!v) return 'NO_VIEW';
    v.dispatch({ selection: { anchor: ${from}, head: ${to} } });
    return { from: v.state.selection.main.from, to: v.state.selection.main.to };
  })()`);
}

// Type text through the real DOM input path (focused editor + execCommand
// insertText, which CodeMirror consumes as genuine user input). The selection
// is placed after focusing so the DOM selection is live; if the synthesized
// input still doesn't produce exactly the requested edit, the same edit is
// applied as a view transaction and flagged for the artifact (weaker seam:
// user-input handling is bypassed).
async function typeText(text, from, to) {
  const before = await cmText();
  const expected = before.slice(0, from) + text + before.slice(to);
  await evalJs(`(() => {
    const v = ${CM_VIEW_LOOKUP};
    if (!v) return false;
    document.querySelector('.cm-content').focus();
    v.dispatch({ selection: { anchor: ${from}, head: ${to} } });
    return true;
  })()`);
  await wait(150); // let CodeMirror sync the DOM selection into the focused view
  // `insertText` swallows a leading newline and `insertParagraph` is a no-op
  // at an empty-line caret; type newlines as real Enter keydowns (CodeMirror's
  // keymap handles them) between text segments — the way a human types them.
  const exec = await evalJs(`(() => {
    const content = document.querySelector('.cm-content');
    const parts = ${JSON.stringify(text.split('\n'))};
    const results = [];
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
        results.push('k');
      }
      if (parts[i]) results.push(document.execCommand('insertText', false, parts[i]) ? 't' : 'T');
    }
    return results.join(',');
  })()`);
  await wait(400); // CodeMirror applies DOM input via its change observer
  const afterExec = await cmText();
  if (afterExec === expected) return { doc: afterExec, method: `dom-input(exec=${exec})` };
  typingFallbackUsed = true;
  log(`dom-input mismatch (exec=${exec}); doc was ${JSON.stringify(afterExec)}, wanted ${JSON.stringify(expected)}`);
  return await evalJs(`(() => {
    const v = ${CM_VIEW_LOOKUP};
    if (!v) return null;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(expected)} },
      selection: { anchor: ${from} + ${JSON.stringify(text)}.length },
    });
    return { doc: v.state.doc.toString(), method: 'view-fallback (dom-input misplaced)' };
  })()`);
}

async function setTagInputValue(value) {
  return await evalJs(`(() => {
    const el = document.querySelector('input[aria-label="Tag name"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

async function clickButtonExact(label) {
  return await evalJs(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const target = btns.filter((b) => b.offsetParent !== null).find((b) => b.textContent.trim() === ${JSON.stringify(label)});
    if (!target) return 'NO_BUTTON';
    target.click();
    return 'CLICKED';
  })()`);
}

async function clickAriaLabel(label) {
  return await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)});
    if (!el) return 'NO_BUTTON';
    el.click();
    return 'CLICKED';
  })()`);
}

async function editorOpen() {
  return (await evalJs(`!!document.querySelector('.cm-editor')`)) === true;
}

async function dialogShows(text) {
  return (await evalJs(`document.body.innerText.includes(${JSON.stringify(text)})`)) === true;
}

// Snapshot-driven click (the agent-browser skill's minimum invocation shape):
// find the interactive ref whose line names `label`, click that ref.
async function clickSnapshotRef(label) {
  const snap = (await browser(['snapshot', '-i'])).stdout;
  const match = snap.split('\n').find((line) => line.includes(label));
  if (!match) return { ok: false, snap };
  const refMatch = match.match(/\[ref=(\S+?)\]/);
  if (!refMatch) return { ok: false, snap };
  const ref = `@${refMatch[1]}`;
  await browser(['click', ref]);
  return { ok: true, ref, snap };
}

// -------------------------------------------------------------------- main

async function main() {
  console.log('[am-smoke] agents-md-editor config-file editor smoke');
  const sandboxHome = await mkdtemp(join(tmpdir(), 'agents-md-editor-smoke-'));
  const configDir = join(sandboxHome, '.config', 'pimote');
  await mkdir(configDir, { recursive: true });

  // Project tree → a plausible dashboard (discovered project + status chip).
  const projectsRoot = join(sandboxHome, 'projects');
  await gitInit(join(projectsRoot, 'alpha'));

  // The file under edit: real content at the real (sandbox) `~/.pi/agent/AGENTS.md`.
  const agentsDir = join(sandboxHome, '.pi', 'agent');
  const agentsPath = join(agentsDir, 'AGENTS.md');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(agentsPath, SEED_CONTENT);

  // Config doubles as the snippet palette the editor fetches via file_get.
  const configPath = join(configDir, 'config.json');
  const port = await freePort();
  await writeFile(
    configPath,
    JSON.stringify({ roots: [projectsRoot], updateCheck: false, tagSnippets: ['note', 'todo'] }, null, 2),
  );

  const logPath = join(sandboxHome, 'pimote.log');
  const shotsDir = process.env.AM_SHOT ? pathResolve(process.env.AM_SHOT) : sandboxHome;
  if (process.env.AM_SHOT) await mkdir(pathResolve(process.env.AM_SHOT, '..'), { recursive: true }).catch(() => {});
  const shotPath = process.env.AM_SHOT ? shotsDir : join(sandboxHome, 'agents-md-editor.png');

  log('sandbox HOME =', sandboxHome);
  log('agents file  =', agentsPath);
  log('port         =', port);

  let child;
  let passed = false;
  try {
    child = startPimote({ port, sandboxHome, logPath });
    await waitForListening(child, port, logPath);
    const baseUrl = `http://127.0.0.1:${port}`;

    // ============================================================
    section('1 — home-page entry button (snapshot → click)');
    // ============================================================
    await browser(['close'], { allowFailure: true });
    await browser(['open', `${baseUrl}/`]);
    await browser(['wait', '3000']);
    const entry = await clickSnapshotRef('Agent instructions');
    assert(entry.ok, `snapshot exposes the "Agent instructions" button and its ref clicks (${entry.ref ?? 'none'})`);
    if (!entry.ok) console.error(entry.snap);

    // ============================================================
    section('2 — dialog opens on ~/.pi/agent/AGENTS.md');
    // ============================================================
    const opened = await waitFor(() => editorOpen(), { timeoutMs: 15_000 });
    assert(opened, 'editor mounts after the dialog opens (lazy CodeMirror load)');
    assert(await dialogShows('Agent instructions'), 'dialog header shows the "Agent instructions" title');
    assert(await dialogShows(agentsPath), `header shows the resolved absolute path (${agentsPath})`);
    const text0 = await cmText();
    assert(text0 === SEED_CONTENT, 'editor content equals the file on disk');
    assert((await clickAriaLabel('Wrap selection with a tag')) === 'CLICKED', 'Tag toolbar button renders');
    assert(await waitFor(() => evalJs(`!!document.querySelector('input[aria-label="Tag name"]')`)), 'Tag button reveals the tag-name input');
    assert((await clickAriaLabel('Wrap selection with a tag')) === 'CLICKED', 'Tag button toggles the input closed again');
    const inputHidden = await waitFor(async () => !(await evalJs(`!!document.querySelector('input[aria-label="Tag name"]')`)));
    assert(inputHidden, 'tag input hidden after the second toggle');
    assert((await evalJs(`document.querySelectorAll('button[aria-label="Wrap with note"]').length`)) === 1, 'snippet button "note" renders from config tagSnippets');
    assert((await evalJs(`document.querySelectorAll('button[aria-label="Wrap with todo"]').length`)) === 1, 'snippet button "todo" renders from config tagSnippets');

    // ============================================================
    section('3 — edit + save round-trip');
    // ============================================================
    const typed = await typeText('\nmanual-edit-line', text0.length, text0.length);
    const expected1 = SEED_CONTENT + '\nmanual-edit-line';
    assert(typed && typed.doc === expected1, `typed text lands in the editor via ${typed ? typed.method : 'no editor'}`);
    assert((await clickButtonExact('Save')) === 'CLICKED', 'Save button clicked');
    const closedAfterSave = await waitFor(async () => !(await dialogShows('Agent instructions')), { timeoutMs: 10_000 });
    assert(closedAfterSave, 'dialog closes after a successful save');
    const disk1 = await waitFor(async () => (await readFile(agentsPath, 'utf8').catch(() => '')) === expected1, { timeoutMs: 5_000, intervalMs: 250 });
    assert(disk1, 'file on disk contains exactly the edited text');
    const entry2 = await clickSnapshotRef('Agent instructions');
    assert(entry2.ok, 'entry button re-clicked from a fresh snapshot (reopen)');
    const reopened = await waitFor(() => editorOpen(), { timeoutMs: 15_000 });
    assert(reopened, 'editor mounts again on reopen');
    assert((await cmText()) === expected1, 'reopen shows the saved content (clean baseline, load path)');

    // ============================================================
    section('4 — tag-wrap, freeform (selection → inline wrap)');
    // ============================================================
    const wordStart = expected1.indexOf('original');
    await setCaret(wordStart, wordStart + 'original'.length);
    assert((await clickAriaLabel('Wrap selection with a tag')) === 'CLICKED', 'Tag button opens the input');
    await waitFor(() => evalJs(`!!document.querySelector('input[aria-label="Tag name"]')`));
    assert(await setTagInputValue('mytag'), 'typed tag name into the tag input');
    await browser(['press', 'Enter']);
    await wait(300);
    const expected2 = `${expected1.slice(0, wordStart)}<mytag>original</mytag>${expected1.slice(wordStart + 'original'.length)}`;
    assert((await cmText()) === expected2, 'Enter wraps the selection inline: <mytag>original</mytag>');
    const sel = await cmSelection();
    assert(sel && sel.from === wordStart + '<mytag>'.length && sel.to === wordStart + '<mytag>'.length + 'original'.length,
      `selection restored on the inner range (${sel ? `${sel.from}..${sel.to}` : 'none'})`);

    // ============================================================
    section('5 — tag-wrap, snippet button (cursor → block insert)');
    // ============================================================
    await setCaret(0);
    assert((await clickAriaLabel('Wrap with note')) === 'CLICKED', 'snippet button "note" clicked');
    await wait(200);
    const expected3 = `<note>\n\n</note>${expected2}`;
    assert((await cmText()) === expected3, 'snippet block-inserts <note>\\n\\n</note> at the cursor');

    // ============================================================
    section('6 — cancel / discard-confirm');
    // ============================================================
    const before4 = await cmText();
    const selBefore = (await cmSelection()) ?? { from: before4.length, to: before4.length };
    await typeText('unsaved', selBefore.from, selBefore.to);
    const expected4 = `${expected3.slice(0, selBefore.from)}unsaved${expected3.slice(selBefore.to)}`;
    assert((await cmText()) === expected4, 'unsaved edit present before the close attempts');
    assert((await clickButtonExact('Cancel')) === 'CLICKED', 'Cancel clicked with unsaved edits');
    assert(await dialogShows('Discard unsaved changes?'), 'discard confirmation appears on Cancel');
    assert((await clickButtonExact('Keep editing')) === 'CLICKED', 'Keep editing chosen');
    await wait(300);
    assert(await dialogShows('Agent instructions'), 'editor dialog still open after Keep editing');
    assert((await cmText()) === expected4, 'edits intact after Keep editing');
    await evalJs(`(() => { const c = document.querySelector('.cm-content'); if (c) c.focus(); return true; })()`);
    await browser(['press', 'Escape']);
    await wait(400);
    assert(await dialogShows('Discard unsaved changes?'), 'Esc with unsaved edits is vetoed into the same confirmation');
    assert(await dialogShows('Agent instructions'), 'editor dialog never closed underneath the confirmation');
    assert((await clickButtonExact('Discard')) === 'CLICKED', 'Discard chosen');
    const closedAfterDiscard = await waitFor(async () => !(await dialogShows('Agent instructions')), { timeoutMs: 10_000 });
    assert(closedAfterDiscard, 'dialog closes after Discard');
    assert((await readFile(agentsPath, 'utf8')) === expected1, 'disk unchanged by the discarded edits (still the saved text)');

    // ============================================================
    section('7 — coherence screenshot');
    // ============================================================
    // Reopen once more so the screenshot shows the dialog as a whole (content,
    // toolbar, save bar) rather than the bare dashboard after the discard.
    await clickSnapshotRef('Agent instructions');
    await waitFor(() => editorOpen(), { timeoutMs: 15_000 });
    await wait(500);
    await browser(['screenshot', shotPath], { allowFailure: true });
    log('coherence screenshot →', shotPath);

    passed = failures === 0;
  } finally {
    await browser(['close'], { allowFailure: true });
    await stopPimote(child);
    const keep = process.env.AM_KEEP === '1' || failures > 0;
    if (keep) {
      log('sandbox preserved:', sandboxHome);
      log('server log    :', logPath);
    } else {
      await rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
    }
    if (typingFallbackUsed) log('NOTE: DOM typing fell back to view transactions at least once (see Harness Limitations).');
  }

  console.log(passed ? '\n[am-smoke] PASS' : '\n[am-smoke] FAIL');
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  console.error('[am-smoke] fatal:', error);
  process.exitCode = 1;
});
