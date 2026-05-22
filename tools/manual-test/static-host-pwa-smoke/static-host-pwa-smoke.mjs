#!/usr/bin/env node
// PWA-side smoke for the static-resources topic.
//
// Drives the client-side behaviours that the test review (`docs/reviews/
// static-resources-tests.md`) deferred to manual testing:
//   - Panel.svelte renders Card.href as a clickable <a>.
//   - Service worker passes /s/* through to the network unmodified.
//   - Browser-back returns to the session view after viewing a bundle.
//
// See README.md alongside this file.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';

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
  console.log(`\n[pwa-smoke] ${name}`);
}
function log(...args) {
  console.log('[pwa-smoke]', ...args);
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = createConnection({ port: 0 }, () => {});
    srv.on('error', () => {
      // fall through to fresh-listener approach
      import('node:net').then(({ createServer }) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
          const p = s.address().port;
          s.close(() => resolve(p));
        });
        s.on('error', reject);
      });
    });
    srv.destroy();
    // Fall back to a fresh listener regardless.
    import('node:net').then(({ createServer }) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
      s.on('error', reject);
    });
  });
}

async function waitForListening(child, port, logPath) {
  // Polls the HTTP server until it responds, with a hard timeout.
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
    // Force a known port via env if pimote honours it; otherwise rely on config.
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
  await Promise.race([
    once(child, 'exit'),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function abCmd(args, { allowFailure = false, retries = 2, timeoutMs = 20_000 } = {}) {
  // Run `agent-browser <args>` and capture stdout. Retries on transient
  // "daemon busy" errors. Hard per-call timeout (default 20s).
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
        console.error(`[pwa-smoke] agent-browser ${args.join(' ')} -> exit ${child.exitCode}${timedOut ? ' (timed out)' : ''}`);
        if (stderr) console.error(stderr);
        throw new Error(`agent-browser failed: ${args.join(' ')}`);
      }
      return { stdout, stderr, code: child.exitCode };
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error('unreachable');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _readClientVersion() {
  const raw = await readFile(join(REPO_ROOT, 'client', 'build', '_app', 'version.json'), 'utf-8');
  return JSON.parse(raw).version;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _openSessionViaWs({ port, folderPath, version }) {
  // Uses the global WebSocket from Node >=22.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=pwa-smoke-fixture&version=${encodeURIComponent(version)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (ev) => reject(ev.error ?? new Error('ws error')), { once: true });
  });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('open_session timed out'));
    }, 15_000);
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'session_opened' && msg.sessionId) {
          clearTimeout(timeout);
          const sessionId = msg.sessionId;
          ws.close();
          resolve(sessionId);
        } else if (msg.type === 'response' && msg.success === false) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`open_session failed: ${msg.error ?? 'unknown'}`));
        } else if (msg.type === 'response' && msg.data?.sessionId) {
          // Some flows respond directly with the sessionId payload.
          clearTimeout(timeout);
          const sessionId = msg.data.sessionId;
          ws.close();
          resolve(sessionId);
        }
      } catch {
        // ignore non-JSON frames
      }
    });
    ws.send(JSON.stringify({ id: 'cmd-1', type: 'open_session', folderPath }));
  });
}

async function main() {
  console.log('[pwa-smoke] static-host PWA-side smoke');

  // ---- sandbox ----
  const sandboxHome = await mkdtemp(join(tmpdir(), 'static-host-pwa-smoke-'));
  const xdgConfig = join(sandboxHome, '.config');
  const xdgState = join(sandboxHome, '.local', 'state');
  await mkdir(join(xdgConfig, 'pimote'), { recursive: true });
  await mkdir(xdgState, { recursive: true });

  const projectsRoot = join(sandboxHome, 'projects');
  const projectDir = join(projectsRoot, 'test-project');
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(projectDir, '.git'), { recursive: true });
  await writeFile(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  const bundleDir = join(projectDir, 'bundle');
  await mkdir(bundleDir, { recursive: true });
  await writeFile(
    join(bundleDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Smoke Bundle</title></head>' +
      '<body><h1 id="bundle-marker">STATIC-HOST-SMOKE-OK</h1></body></html>\n',
  );

  const port = await new Promise((resolve, reject) => {
    import('node:net').then(({ createServer }) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
      s.on('error', reject);
    });
  });

  const configPath = join(xdgConfig, 'pimote', 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({ roots: [projectsRoot], port, bufferSize: 100 }, null, 2),
  );

  const storeDir = join(xdgState, 'pimote', 'static-host');
  const logPath = join(sandboxHome, 'pimote.log');

  log('sandbox HOME =', sandboxHome);
  log('port         =', port);

  let child;
  try {
    // ============================================================
    section('Fabricate a pi session jsonl on disk');
    // ============================================================
    // Bypass the WS open-then-close dance: pi only persists a session
    // jsonl once it has content, but `SessionManager.list` (used by
    // FolderIndex) discovers sessions purely by reading jsonl files on
    // disk. Writing a minimal `session` record with a known id is
    // enough for pimote to enumerate it and for the static-host
    // extension to fire `session_start` on open.
    const sessionId = randomUUID();
    const piSessionsDir = join(sandboxHome, '.pi', 'agent', 'sessions');
    const encodedCwd = `--${projectDir.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const sessionDir = join(piSessionsDir, encodedCwd);
    await mkdir(sessionDir, { recursive: true });
    const isoNow = new Date().toISOString();
    const filenameStamp = isoNow.replace(/:/g, '-');
    const sessionPath = join(sessionDir, `${filenameStamp}_${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: sessionId,
        timestamp: isoNow,
        cwd: projectDir,
      }) + '\n',
    );
    assert(true, `seeded pi session ${sessionPath}`);

    // ============================================================
    section('Seed static-host store for the session');
    // ============================================================
    await mkdir(storeDir, { recursive: true });
    const slug = 'static-host-pwa-smoke-bundle';
    const storeFile = join(storeDir, `${sessionId}.json`);
    await writeFile(
      storeFile,
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              slug,
              folderPath: bundleDir,
              cardMetadata: { title: 'Smoke Bundle Card', tag: 'smoke', color: 'accent' },
            },
          ],
        },
        null,
        2,
      ),
    );
    assert(true, `seeded ${storeFile}`);

    // ============================================================
    section('Boot pimote');
    // ============================================================
    child = startPimote({ port, sandboxHome, logPath });
    await waitForListening(child, port, logPath);
    log('pimote listening');

    // ============================================================
    section('Drive the PWA via agent-browser');
    // ============================================================
    const baseUrl = `http://127.0.0.1:${port}`;

    await abCmd(['close'], { allowFailure: true }); // make sure no stale browser
    await abCmd(['open', `${baseUrl}/`]);
    // The PWA opens a long-lived WebSocket so networkidle never fires.
    // Use a fixed delay for SW registration + initial hydrate.
    await abCmd(['wait', '3000']);

    // The folder list starts expanded, so the session row is visible
    // immediately. With no firstMessage in the jsonl, its accessible name is
    // "(no messages) 0 msgs · <relative-time>" — click by the stable "0 msgs"
    // substring.
    log('opening the seeded session');
    await abCmd(['find', 'role', 'button', 'click', '--name', '0 msgs']);
    await abCmd(['wait', '3000']);

    // ============================================================
    section('Verify the panel renders <a href> for the card');
    // ============================================================
    const expectedHref = `/s/${slug}/`;
    // Use a snapshot to find the panel anchor by accessible name (a link's
    // accessible name includes the card title + tag).
    const sessionSnap = (await abCmd(['snapshot', '-i'])).stdout;
    const hasLinkInSnapshot = /link "Smoke Bundle Card/.test(sessionSnap);
    const linkHref = hasLinkInSnapshot
      ? (await abCmd(['get', 'attr', 'a[href^="/s/"]', 'href'], { allowFailure: true })).stdout.trim()
      : '';
    const hasAnchor = hasLinkInSnapshot && linkHref.includes(expectedHref);
    assert(hasLinkInSnapshot, 'panel renders a link element for the card');
    assert(hasAnchor, `link href is ${expectedHref} (got ${JSON.stringify(linkHref)})`);

    if (!hasLinkInSnapshot) {
      log('session snapshot excerpt:');
      console.log(sessionSnap.slice(0, 4000));
    }

    // ============================================================
    section('Click the card → bundle served from /s/<slug>/');
    // ============================================================
    if (hasAnchor) {
      await abCmd(['find', 'role', 'link', 'click', '--name', 'Smoke Bundle Card']);
      await abCmd(['wait', '2000']);
      const url = (await abCmd(['get', 'url'])).stdout.trim();
      assert(url.endsWith(expectedHref), `URL is ${expectedHref} (got ${url})`);
      const body = (await abCmd(['get', 'text', 'body'])).stdout;
      assert(body.includes('STATIC-HOST-SMOKE-OK'), 'bundle index.html body rendered (SW pass-through ok)');

      // SW pass-through: directly check the response headers from the page context.
      const headersJson = (
        await abCmd([
          'eval',
          `fetch('${expectedHref}', {cache: 'no-store'}).then(r => JSON.stringify({status: r.status, cc: r.headers.get('cache-control'), ct: r.headers.get('content-type')}))`,
        ])
      ).stdout;
      let parsedHeaders;
      try {
        // agent-browser eval echoes the JS return value as a JSON-quoted string;
        // strip the outer quoting and parse.
        const trimmed = headersJson.trim();
        const unquoted = trimmed.startsWith('"') ? JSON.parse(trimmed) : trimmed;
        parsedHeaders = JSON.parse(unquoted);
      } catch {
        parsedHeaders = null;
      }
      assert(parsedHeaders && parsedHeaders.status === 200, `fetch /s/<slug>/ from page context -> 200 (got ${JSON.stringify(parsedHeaders)})`);
      assert(
        parsedHeaders && /no-cache/i.test(parsedHeaders.cc || ''),
        'response cache-control from server (no-cache) — proves SW did not synthesize an SPA-shell response',
      );

      // ========================================================
      section('Browser-back returns to the session view');
      // ========================================================
      await abCmd(['back']);
      await abCmd(['wait', '3000']);
      const backUrl = (await abCmd(['get', 'url'])).stdout.trim();
      assert(!backUrl.endsWith(expectedHref), `back navigation left the bundle (now ${backUrl})`);
      const backSnap = (await abCmd(['snapshot', '-i'])).stdout;
      assert(
        /Send a message|Smoke Bundle Card|test-project/.test(backSnap),
        'session view restored after back (input bar / panel card / folder visible)',
      );
    } else {
      log('skipping click/back/SW checks because anchor was not found');
    }

    await abCmd(['close'], { allowFailure: true });
  } catch (err) {
    console.error('[pwa-smoke] FAILED:', err);
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

  console.log(`\n[pwa-smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[pwa-smoke] uncaught', err);
  process.exit(1);
});
