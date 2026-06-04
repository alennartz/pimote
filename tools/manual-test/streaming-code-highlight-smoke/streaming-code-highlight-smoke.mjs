#!/usr/bin/env node
// PWA-side smoke for the streaming-code-highlight topic.
//
// Verifies the FINALIZED render contracts of the new `write` tool
// visualization (ToolCall.svelte → WriteFileBlock.svelte) and the markdown
// rendering path, by fabricating pi sessions that contain *completed* `write`
// tool calls and opening them in the PWA:
//
//   1. Mode routing by extension: a code-extension write (.ts) renders a
//      syntax-highlighted <pre><code class="hljs">; a .md write renders as
//      live markdown via TextBlock (rendered HTML, not raw source).
//   2. Precondition (a): the copy button yields RAW source verbatim in BOTH
//      code and markdown modes (never the rendered/highlighted text).
//   3. Precondition (b): the show-more/collapse wrapper bounds long files in
//      BOTH modes (a >20-line write shows "Show more…" and clamps the body).
//   4. Code mode carries real hljs span markup and preserves the source text.
//   5. Markdown mode renders markdown (headings as HTML) and highlights an
//      inner fenced ```code block.
//
// HARNESS LIMITATION: this driver fabricates sessions on disk and observes the
// SETTLED state only. The streaming-only behaviors (auto-expand-while-
// streaming / auto-collapse-on-completion, and mid-stream highlighting in the
// write view) are NOT exercised here — they require a live token stream. The
// streaming *logic* is covered by client unit tests (code-highlight.test.ts,
// write-content.test.ts, smd-renderer.test.ts mid-stream case). See
// docs/manual-tests/streaming-code-highlight.md → Harness Limitations.
//
// No live LLM is needed.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
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
  console.log(`\n[sch-smoke] ${name}`);
}
function log(...args) {
  console.log('[sch-smoke]', ...args);
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
    const { appendFile } = await import('node:fs/promises');
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
        console.error(`[sch-smoke] agent-browser ${args.join(' ')} -> exit ${child.exitCode}${timedOut ? ' (timed out)' : ''}`);
        if (stderr) console.error(stderr);
        throw new Error(`agent-browser failed: ${args.join(' ')}`);
      }
      return { stdout, stderr, code: child.exitCode };
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error('unreachable');
}

// `agent-browser eval` returns the result JSON-encoded on stdout. Unwrap it.
async function abEval(expr, { allowFailure = false } = {}) {
  const { stdout } = await abCmd(['eval', expr], { allowFailure });
  const raw = stdout.trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, '');
  }
}

// ---- pi session fabrication ----------------------------------------------

// Build a linear pi session JSONL containing a sequence of write tool calls.
// `writes` is a list of { path, content }. Each becomes:
//   user prompt -> assistant(toolCall write) -> toolResult.
// Returns { lines, sessionId }.
function fabricateWriteSession({ cwd, firstPrompt, writes }) {
  const sessionId = randomUUID();
  const isoNow = new Date().toISOString();
  const lines = [];
  let prevId = null;
  const nextId = () => randomUUID().slice(0, 8);

  lines.push({ type: 'session', version: 3, id: sessionId, timestamp: isoNow, cwd });

  for (let i = 0; i < writes.length; i++) {
    const w = writes[i];
    const toolCallId = `call_${i}_${nextId()}`;

    const uid = nextId();
    lines.push({
      type: 'message',
      id: uid,
      parentId: prevId,
      timestamp: isoNow,
      message: {
        role: 'user',
        content: [{ type: 'text', text: i === 0 ? firstPrompt : `write ${w.path}` }],
        timestamp: Date.now(),
      },
    });
    prevId = uid;

    const aid = nextId();
    lines.push({
      type: 'message',
      id: aid,
      parentId: prevId,
      timestamp: isoNow,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `Writing ${w.path}.` },
          { type: 'toolCall', id: toolCallId, name: 'write', arguments: { path: w.path, content: w.content } },
        ],
        api: 'fabricated',
        provider: 'fabricated',
        model: 'fabricated',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: Date.now(),
        responseId: `resp_${aid}`,
      },
    });
    prevId = aid;

    const tid = nextId();
    lines.push({
      type: 'message',
      id: tid,
      parentId: prevId,
      timestamp: isoNow,
      message: {
        role: 'toolResult',
        toolCallId,
        toolName: 'write',
        content: [{ type: 'text', text: `Wrote ${w.content.length} bytes to ${w.path}` }],
        isError: false,
        timestamp: Date.now(),
      },
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

// ---- fixtures -------------------------------------------------------------

const SHORT_TS = `export function greet(name: string): string {
  // a short, highlightable snippet
  const greeting = \`Hello, \${name}!\`;
  return greeting;
}
`;

// >20 lines to trip the collapse threshold.
const LONG_TS =
  `import { readFile } from 'node:fs/promises';\n\n` +
  Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i}; // line ${i}`).join('\n') +
  `\n`;

// Markdown with a heading, list, and an inner fenced code block.
const SHORT_MD = `# Streaming highlight demo

Some **bold** intro text and a list:

- first item
- second item

\`\`\`ts
const answer: number = 42;
console.log(answer);
\`\`\`
`;

// >20 lines of markdown to trip collapse in markdown mode.
const LONG_MD =
  `# Long markdown document\n\n` +
  Array.from({ length: 30 }, (_, i) => `- bullet point number ${i} with some text`).join('\n') +
  `\n`;

const WRITES = [
  { path: 'src/example.ts', content: SHORT_TS },
  { path: 'README.md', content: SHORT_MD },
  { path: 'src/long.ts', content: LONG_TS },
  { path: 'notes.md', content: LONG_MD },
];

async function main() {
  console.log('[sch-smoke] streaming-code-highlight PWA-side smoke (finalized render contracts)');

  const sandboxHome = await mkdtemp(join(tmpdir(), 'streaming-code-highlight-smoke-'));
  const xdgConfig = join(sandboxHome, '.config');
  const xdgState = join(sandboxHome, '.local', 'state');
  await mkdir(join(xdgConfig, 'pimote'), { recursive: true });
  await mkdir(xdgState, { recursive: true });

  const projectsRoot = join(sandboxHome, 'projects');
  const projectDir = join(projectsRoot, 'demo-project');
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(projectDir, '.git'), { recursive: true });
  await writeFile(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  const port = await getFreePort();
  const configPath = join(xdgConfig, 'pimote', 'config.json');
  await writeFile(configPath, JSON.stringify({ roots: [projectsRoot], port, bufferSize: 200 }, null, 2));

  const logPath = join(sandboxHome, 'pimote.log');
  log('sandbox HOME =', sandboxHome);
  log('port         =', port);

  const FIRST_PROMPT = 'write tool visualization demo';

  let child;
  try {
    section('Fabricate pi session with completed write tool calls');
    const fab = fabricateWriteSession({ cwd: projectDir, firstPrompt: FIRST_PROMPT, writes: WRITES });
    const sessionPath = await seedSession({ sandboxHome, projectDir, ...fab });
    assert(true, `seeded session with ${WRITES.length} write tool calls: ${sessionPath}`);

    section('Boot pimote');
    child = startPimote({ port, sandboxHome, logPath });
    await waitForListening(child, port, logPath);
    log('pimote listening');

    const baseUrl = `http://127.0.0.1:${port}`;

    section('Open the session in the PWA (Journey 1 + 2 entry)');
    await abCmd(['close'], { allowFailure: true });
    await abCmd(['open', `${baseUrl}/`]);
    await abCmd(['wait', '3000']);
    // Mandatory-reuse: snapshot + a real find/click against a snapshot element.
    const idxSnap = (await abCmd(['snapshot', '-i'])).stdout;
    log('index snapshot excerpt:\n' + idxSnap.slice(0, 1200));
    await abCmd(['find', 'role', 'button', 'click', '--name', FIRST_PROMPT]);
    await abCmd(['wait', '3000']);

    // Expand every tool block so the WriteFileBlock bodies mount.
    await abEval(`(() => { document.querySelectorAll('.tool-header').forEach(b => b.click()); return document.querySelectorAll('.tool-header').length; })()`);
    await abCmd(['wait', '1500']);

    const toolCount = await abEval(`document.querySelectorAll('.write-file-block').length`);
    assert(Number(toolCount) === WRITES.length, `all ${WRITES.length} write tool calls render a .write-file-block (got ${toolCount})`);

    // Helper installed in the page: locate a write-file-block by the
    // tool-detail path text of its enclosing tool-block.
    const installFinder = `
      window.__wfbFor = (pathText) => {
        const blocks = Array.from(document.querySelectorAll('.tool-block'));
        for (const b of blocks) {
          const detail = b.querySelector('.tool-detail');
          if (detail && detail.textContent.includes(pathText)) {
            return b.querySelector('.write-file-block');
          }
        }
        return null;
      };
      'ok'
    `;
    await abEval(installFinder.replace(/\n\s*/g, ' '));

    // -----------------------------------------------------------------
    section('Test 1 + 4: code-mode routing + real hljs highlighting (.ts)');
    // -----------------------------------------------------------------
    const codeMode = await abEval(`(() => { const w = window.__wfbFor('example.ts'); return w && w.getAttribute('data-mode'); })()`);
    assert(codeMode === 'code', `.ts write routes to code mode (data-mode=code, got ${JSON.stringify(codeMode)})`);

    const codeInfo = await abEval(
      `(() => { const w = window.__wfbFor('example.ts'); if(!w) return null; const code = w.querySelector('pre.wfb-code code'); if(!code) return null; return { hasHljsClass: code.classList.contains('hljs'), spanCount: code.querySelectorAll('[class^=hljs-]').length, hasGreet: code.textContent.includes('greet'), hasArrow: code.textContent.includes('Hello, ') }; })()`,
    );
    assert(codeInfo && codeInfo.hasHljsClass, 'code body <code> carries the hljs class');
    assert(codeInfo && codeInfo.spanCount > 0, `code body carries hljs-* span markup (got ${codeInfo?.spanCount} spans)`);
    assert(codeInfo && codeInfo.hasGreet && codeInfo.hasArrow, 'code body preserves the underlying source text verbatim');

    // -----------------------------------------------------------------
    section('Test 1 + 5: markdown-mode routing + rendered markdown (.md)');
    // -----------------------------------------------------------------
    const mdMode = await abEval(`(() => { const w = window.__wfbFor('README.md'); return w && w.getAttribute('data-mode'); })()`);
    assert(mdMode === 'markdown', `.md write routes to markdown mode (data-mode=markdown, got ${JSON.stringify(mdMode)})`);

    const mdInfo = await abEval(
      `(() => { const w = window.__wfbFor('README.md'); if(!w) return null; const body = w.querySelector('.wfb-markdown'); if(!body) return null; return { hasH1: !!body.querySelector('h1'), h1Text: body.querySelector('h1') && body.querySelector('h1').textContent.trim(), hasLi: body.querySelectorAll('li').length, literalHash: body.textContent.includes('# Streaming'), innerCodeHljs: !!body.querySelector('code.hljs') || body.querySelectorAll('[class^=hljs-]').length > 0, innerSpanCount: body.querySelectorAll('[class^=hljs-]').length }; })()`,
    );
    assert(mdInfo && mdInfo.hasH1, `markdown body renders the heading as <h1> (text: ${JSON.stringify(mdInfo?.h1Text)})`);
    assert(mdInfo && mdInfo.hasLi >= 2, `markdown body renders the list as <li> items (got ${mdInfo?.hasLi})`);
    assert(mdInfo && !mdInfo.literalHash, 'markdown body does NOT show the literal "# Streaming" source (rendered, not raw)');
    assert(mdInfo && mdInfo.innerCodeHljs, `markdown body highlights its inner fenced code block (hljs spans: ${mdInfo?.innerSpanCount})`);

    // -----------------------------------------------------------------
    section('Test 2 (precondition a): copy yields RAW source in BOTH modes');
    // -----------------------------------------------------------------
    // Override clipboard.writeText to capture the copied string (headless
    // Chromium clipboard reads are unreliable; capture the argument instead).
    await abEval(`(() => { window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; return 'ok'; })()`);

    // Code mode copy.
    await abEval(`(() => { const w = window.__wfbFor('example.ts'); w.querySelector('.code-copy-btn').click(); return 'ok'; })()`);
    await abCmd(['wait', '300']);
    const copiedCode = await abEval(`window.__copied`);
    assert(copiedCode === SHORT_TS, 'code-mode copy yields the raw .ts source verbatim (byte-identical)');

    // Markdown mode copy — must be RAW markdown source, not rendered text.
    await abEval(`window.__copied = null`);
    await abEval(`(() => { const w = window.__wfbFor('README.md'); w.querySelector('.code-copy-btn').click(); return 'ok'; })()`);
    await abCmd(['wait', '300']);
    const copiedMd = await abEval(`window.__copied`);
    assert(copiedMd === SHORT_MD, 'markdown-mode copy yields the raw .md source verbatim (NOT rendered text)');
    assert(typeof copiedMd === 'string' && copiedMd.includes('# Streaming highlight demo') && copiedMd.includes('```ts'), 'markdown-mode copied text retains literal markdown bytes (#, ``` fences)');

    // -----------------------------------------------------------------
    section('Test 3 (precondition b): collapse wrapper bounds long files in BOTH modes');
    // -----------------------------------------------------------------
    const longCode = await abEval(
      `(() => { const w = window.__wfbFor('long.ts'); if(!w) return null; const toggle = w.querySelector('.wfb-toggle'); return { mode: w.getAttribute('data-mode'), hasToggle: !!toggle, toggleText: toggle && toggle.textContent.trim() }; })()`,
    );
    assert(longCode && longCode.mode === 'code', 'long .ts write is in code mode');
    assert(longCode && longCode.hasToggle && /Show more/.test(longCode.toggleText), `long code write shows a "Show more…" collapse toggle (got ${JSON.stringify(longCode?.toggleText)})`);

    // After expanding-all earlier, the long block may already be expanded.
    // Collapse it, then assert the body clamps.
    const clampCode = await abEval(
      `(() => { const w = window.__wfbFor('long.ts'); const t = w.querySelector('.wfb-toggle'); if (w.querySelector('.wfb-body').classList.contains('scrollable')) { t.click(); } const body = w.querySelector('.wfb-body'); return { clamped: body.classList.contains('clamped') }; })()`,
    );
    assert(clampCode && clampCode.clamped === true, 'long code write body is height-clamped when collapsed');

    const longMd = await abEval(
      `(() => { const w = window.__wfbFor('notes.md'); if(!w) return null; const toggle = w.querySelector('.wfb-toggle'); return { mode: w.getAttribute('data-mode'), hasToggle: !!toggle, toggleText: toggle && toggle.textContent.trim() }; })()`,
    );
    assert(longMd && longMd.mode === 'markdown', 'long .md write is in markdown mode');
    assert(longMd && longMd.hasToggle && /Show more/.test(longMd.toggleText), `long markdown write shows a "Show more…" collapse toggle (got ${JSON.stringify(longMd?.toggleText)})`);

    const clampMd = await abEval(
      `(() => { const w = window.__wfbFor('notes.md'); const t = w.querySelector('.wfb-toggle'); if (w.querySelector('.wfb-body').classList.contains('scrollable')) { t.click(); } const body = w.querySelector('.wfb-body'); return { clamped: body.classList.contains('clamped') }; })()`,
    );
    assert(clampMd && clampMd.clamped === true, 'long markdown write body is height-clamped when collapsed (collapse applies in markdown mode too)');

    // Coherence screenshot: expand all again and capture the rendered view.
    await abEval(`(() => { document.querySelectorAll('.wfb-toggle').forEach(t => { const b = t.closest('.write-file-block').querySelector('.wfb-body'); if (b.classList.contains('clamped')) t.click(); }); return 'ok'; })()`);
    await abCmd(['wait', '500']);
    const shotPath = process.env.SCH_SHOT || join(sandboxHome, 'write-blocks.png');
    await abCmd(['screenshot', shotPath], { allowFailure: true });
    log('coherence screenshot:', shotPath);

    await abCmd(['close'], { allowFailure: true });
  } catch (err) {
    console.error('[sch-smoke] FAILED:', err);
    failures++;
    try {
      const tail = await readFile(logPath, 'utf-8').catch(() => '');
      if (tail) console.error('[sch-smoke] pimote.log tail:\n' + tail.slice(-2000));
    } catch {}
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

  console.log(`\n[sch-smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[sch-smoke] uncaught', err);
  process.exit(1);
});
