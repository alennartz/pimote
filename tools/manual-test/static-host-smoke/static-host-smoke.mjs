#!/usr/bin/env node
// Static-host server-side smoke for the static-resources topic.
//
// Exercises the shipped server-side modules end-to-end without booting the
// full pimote server or requiring an LLM:
//
//   1. Real InMemoryStaticHostRegistry + FileStaticHostStore.
//   2. Real executeRegisterTool / executeRemoveTool with a captured
//      emitPanelCards fake.
//   3. Live http.Server running the shipped serveStaticHostRoute.
//   4. Session evict + rehydrate simulated by calling
//      unregisterAllForSession and then replaying the on-disk store file
//      the same way the extension's session_start handler does.
//   5. gcStaticHostStore against a populated store directory.
//
// See tools/manual-test/static-host-smoke/README.md.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileStaticHostStore,
  InMemoryStaticHostRegistry,
  gcStaticHostStore,
  serveStaticHostRoute,
} from '../../../server/dist/static-host/index.js';
import { executeRegisterTool, executeRemoveTool } from '../../../server/dist/static-host/tools.js';

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
  console.log(`\n[smoke] ${name}`);
}

async function main() {
  console.log('[smoke] static-host server-side smoke');

  // ---- temp dirs ----
  const root = await mkdtemp(join(tmpdir(), 'static-host-smoke-'));
  const storeDir = join(root, 'store');
  const bundleDir = join(root, 'bundle');
  const subDir = join(bundleDir, 'sub');
  await mkdir(subDir, { recursive: true });
  await writeFile(join(bundleDir, 'index.html'), '<!doctype html><h1>hello</h1>\n');
  await writeFile(join(subDir, 'app.js'), 'console.log("ok");\n');
  await writeFile(join(subDir, 'index.html'), '<!doctype html><p>nested</p>\n');
  // sibling outside the bundle that traversal must NOT reach:
  await writeFile(join(root, 'secret.txt'), 'do-not-leak\n');

  const registry = new InMemoryStaticHostRegistry();
  const store = new FileStaticHostStore(storeDir);

  // ---- live HTTP server using the shipped handler ----
  const emitted = [];
  const sessionA = 'sess-A';
  const sessionB = 'sess-B';

  const server = http.createServer(async (req, res) => {
    try {
      const handled = await serveStaticHostRoute(req, res, registry);
      if (handled) return;
      // Stub the SPA fallback so we can tell "fell through" from "handler 404".
      res.statusCode = 200;
      res.setHeader('X-Pimote-Smoke', 'spa-fallback');
      res.end('SPA SHELL');
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String(err));
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // ============================================================
    section('register tool — happy path');
    // ============================================================
    emitted.length = 0;
    const depsA = {
      registry,
      store,
      sessionId: sessionA,
      emitPanelCards: () => emitted.push({ sessionId: sessionA, cards: registry.listForSession(sessionA) }),
    };
    const reg = await executeRegisterTool(
      { slug: 'demo', folder: bundleDir, title: 'Demo bundle', tag: 'preview', color: 'accent' },
      depsA,
    );
    assert(reg.slug === 'demo', 'register returns the input slug when free');
    assert(reg.url === '/s/demo/', 'register returns /s/<slug>/ URL');
    assert(emitted.length === 1, 'emitPanelCards called once on register');
    assert(emitted[0].cards.length === 1 && emitted[0].cards[0].slug === 'demo', 'panel snapshot contains the new card');

    // persistence
    const fileA = await store.read(sessionA);
    assert(fileA && fileA.version === 1 && fileA.entries.length === 1, 'persistence file written with version=1');
    assert(fileA.entries[0].slug === 'demo' && fileA.entries[0].folderPath === bundleDir, 'persisted entry shape ok');
    assert(fileA.entries[0].cardMetadata.title === 'Demo bundle' && fileA.entries[0].cardMetadata.tag === 'preview' && fileA.entries[0].cardMetadata.color === 'accent', 'persisted cardMetadata shape ok');

    // ============================================================
    section('HTTP route — happy paths');
    // ============================================================
    {
      const r = await fetch(`${base}/s/demo/`);
      const text = await r.text();
      assert(r.status === 200, 'GET /s/demo/ -> 200');
      assert(text.includes('<h1>hello</h1>'), 'GET /s/demo/ serves index.html body');
      assert(/text\/html/i.test(r.headers.get('content-type') || ''), 'index.html has text/html content-type');
      const cc = r.headers.get('cache-control') || '';
      assert(/no-cache/i.test(cc), 'response sets no-cache cache-control');
    }
    {
      const r = await fetch(`${base}/s/demo/sub/app.js`);
      const text = await r.text();
      assert(r.status === 200, 'GET /s/demo/sub/app.js -> 200');
      assert(text.includes('console.log'), 'JS asset body intact');
      assert(/javascript/i.test(r.headers.get('content-type') || ''), 'JS asset has JS content-type');
    }
    {
      const r = await fetch(`${base}/s/demo/sub/`);
      const text = await r.text();
      assert(r.status === 200, 'GET /s/demo/sub/ -> 200');
      assert(text.includes('<p>nested</p>'), 'subdirectory serves its index.html');
    }

    // ============================================================
    section('HTTP route — error paths');
    // ============================================================
    {
      const r = await fetch(`${base}/s/no-such/`);
      assert(r.status === 404, 'unknown slug -> 404');
      assert(r.headers.get('x-pimote-smoke') !== 'spa-fallback', 'unknown slug does NOT fall through to SPA');
    }
    {
      // Percent-encoded separator survives URL normalisation and reaches handler intact.
      const r = await fetch(`${base}/s/demo/..%2Fsecret.txt`);
      assert(r.status === 404, 'traversal attempt -> 404');
      const text = await r.text();
      assert(!text.includes('do-not-leak'), 'traversal attempt does not leak external file');
    }
    {
      const r = await fetch(`${base}/s/demo/missing.html`);
      assert(r.status === 404, 'missing file inside bundle -> 404');
    }
    {
      const r = await fetch(`${base}/unrelated`);
      assert(r.status === 200, 'non-prefix path -> handler reports not handled');
      assert(r.headers.get('x-pimote-smoke') === 'spa-fallback', 'non-prefix path falls through to SPA fallback');
    }

    // ============================================================
    section('collision resolution');
    // ============================================================
    {
      const sessionC = 'sess-C';
      const depsC = {
        registry,
        store,
        sessionId: sessionC,
        emitPanelCards: () => {},
      };
      const dup = await executeRegisterTool({ slug: 'demo', folder: bundleDir, title: 'Dup attempt' }, depsC);
      assert(dup.slug === 'demo-2', 'slug collision resolved to demo-2');
      assert(dup.url === '/s/demo-2/', 'collision URL reflects suffixed slug');
      const r = await fetch(`${base}/s/demo-2/`);
      assert(r.status === 200, 'collision-suffixed slug serves');
      // clean up session C so it doesn't pollute later assertions
      registry.unregisterAllForSession(sessionC);
      await store.remove(sessionC);
    }

    // ============================================================
    section('validation failures do not mutate state');
    // ============================================================
    {
      const before = registry.listForSession(sessionA).map((r) => r.slug);
      const emitsBefore = emitted.length;
      let threw = false;
      try {
        await executeRegisterTool({ slug: 'Bad Slug!', folder: bundleDir, title: 'x' }, depsA);
      } catch {
        threw = true;
      }
      assert(threw, 'invalid slug throws');
      assert(registry.listForSession(sessionA).map((r) => r.slug).join(',') === before.join(','), 'invalid slug does not register');
      assert(emitted.length === emitsBefore, 'invalid slug does not emit panel snapshot');
    }
    {
      let threw = false;
      try {
        await executeRegisterTool({ slug: 'fresh-slug', folder: join(root, 'does-not-exist'), title: 'x' }, depsA);
      } catch {
        threw = true;
      }
      assert(threw, 'missing folder throws');
    }
    {
      const emptyDir = join(root, 'empty');
      await mkdir(emptyDir, { recursive: true });
      let threw = false;
      try {
        await executeRegisterTool({ slug: 'also-fresh', folder: emptyDir, title: 'x' }, depsA);
      } catch {
        threw = true;
      }
      assert(threw, 'folder without index.html throws');
    }

    // ============================================================
    section('session evict drops registrations');
    // ============================================================
    registry.unregisterAllForSession(sessionA);
    {
      const r = await fetch(`${base}/s/demo/`);
      assert(r.status === 404, 'after evict, /s/demo/ returns 404');
    }
    // Persistence file is NOT removed on evict.
    const fileAAfterEvict = await store.read(sessionA);
    assert(fileAAfterEvict && fileAAfterEvict.entries.length === 1, 'persistence file survives evict');

    // ============================================================
    section('session rehydrate replays from disk');
    // ============================================================
    emitted.length = 0;
    const replayCards = [];
    {
      // Reproduce the extension's session_start handler shape:
      const file = await store.read(sessionA);
      for (const entry of file?.entries ?? []) {
        registry.register({
          slug: entry.slug,
          folderPath: entry.folderPath,
          sessionId: sessionA,
          cardMetadata: entry.cardMetadata,
        });
      }
      // Mirror what the extension's emitPanelCards builds for the panel event.
      const cards = registry.listForSession(sessionA).map((r) => ({
        id: r.slug,
        header: { title: r.cardMetadata.title, tag: r.cardMetadata.tag },
        color: r.cardMetadata.color,
        href: `/s/${r.slug}/`,
      }));
      replayCards.push(...cards);
    }
    assert(registry.has('demo'), 'rehydrate re-registers slug');
    assert(replayCards.length === 1 && replayCards[0].href === '/s/demo/', 'rehydrate would emit card with href=/s/demo/');
    {
      const r = await fetch(`${base}/s/demo/`);
      assert(r.status === 200, 'after rehydrate, /s/demo/ serves again');
    }

    // ============================================================
    section('boot-time GC');
    // ============================================================
    // sessionA file already exists. Add an orphan and an unrelated non-json file.
    await store.write('orphan-session', { version: 1, entries: [] });
    await writeFile(join(storeDir, 'not-a-session.txt'), 'leave-me-alone\n');
    await gcStaticHostStore({ storeDir, validSessionIds: new Set([sessionA]) });
    {
      const orphan = await store.read('orphan-session');
      assert(orphan === undefined, 'GC removed orphan session file');
      const live = await store.read(sessionA);
      assert(live && live.entries.length === 1, 'GC preserved live session file');
      const unrelated = await readFile(join(storeDir, 'not-a-session.txt'), 'utf8');
      assert(unrelated === 'leave-me-alone\n', 'GC left non-json file alone');
    }
    // GC tolerates missing dir
    {
      const ghostDir = join(root, 'ghost');
      let threw = false;
      try {
        await gcStaticHostStore({ storeDir: ghostDir, validSessionIds: new Set() });
      } catch {
        threw = true;
      }
      assert(!threw, 'GC on missing dir is a no-op');
    }

    // ============================================================
    section('remove tool tears down route + card');
    // ============================================================
    emitted.length = 0;
    const rm1 = await executeRemoveTool({ slug: 'demo' }, depsA);
    assert(rm1.removed === true, 'remove tool reports removed=true');
    assert(emitted.length === 1, 'remove tool emits panel snapshot');
    assert(emitted[0].cards.length === 0, 'panel snapshot is empty after remove');
    {
      const r = await fetch(`${base}/s/demo/`);
      assert(r.status === 404, 'after remove, /s/demo/ returns 404');
    }
    const fileAfterRemove = await store.read(sessionA);
    assert(fileAfterRemove && fileAfterRemove.entries.length === 0, 'persistence file rewritten with empty entries');

    // Unknown slug
    const rm2 = await executeRemoveTool({ slug: 'never-existed' }, depsA);
    assert(rm2.removed === false, 'remove unknown slug -> removed=false');

    // Cross-session removal is a no-op
    {
      // Re-register under sessionA, then attempt remove under sessionB.
      await executeRegisterTool({ slug: 'demo', folder: bundleDir, title: 'Demo bundle' }, depsA);
      const depsB = {
        registry,
        store,
        sessionId: sessionB,
        emitPanelCards: () => {},
      };
      const rm3 = await executeRemoveTool({ slug: 'demo' }, depsB);
      assert(rm3.removed === false, 'remove from wrong session -> removed=false');
      assert(registry.has('demo'), 'cross-session remove did not unregister');
    }
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\n[smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] uncaught error', err);
  process.exit(1);
});
