import { describe, it, expect } from 'vitest';
import type { Dirent, Stats } from 'node:fs';
import { scanFolderModel, type FolderFs, type FolderOccurrence, type SparseTree } from './index.js';

// ---------------------------------------------------------------------------
// In-memory FolderFs fake. Declarative node tree; symlink targets are absolute
// paths. Deterministic readdir order (insertion order) — tests never assert on
// traversal order.
// ---------------------------------------------------------------------------

type FsNode = { kind: 'dir'; children: Record<string, FsNode> } | { kind: 'file'; content: string } | { kind: 'symlink'; target: string };

const dir = (children: Record<string, FsNode> = {}): FsNode => ({ kind: 'dir', children });
const file = (content = ''): FsNode => ({ kind: 'file', content });
const link = (target: string): FsNode => ({ kind: 'symlink', target });
const repo = (): FsNode => dir({ '.git': dir() });
const marker = (name: string, description?: string): FsNode =>
  file(['---', `name: ${name}`, ...(description ? [`description: ${description}`] : []), '---', 'prompt body'].join('\n'));

function memFs(tree: Record<string, FsNode>): FolderFs {
  const nodes = new Map<string, FsNode>();
  const add = (path: string, node: FsNode): void => {
    nodes.set(path, node);
    if (node.kind === 'dir') {
      for (const [name, child] of Object.entries(node.children)) add(`${path}/${name}`, child);
    }
  };
  for (const [path, node] of Object.entries(tree)) add(path, node);

  const resolve = (p: string, followFinal: boolean): string => {
    const segs = p.split('/').filter(Boolean);
    const out: string[] = [];
    let hops = 0;
    while (segs.length > 0) {
      const seg = segs.shift()!;
      out.push(seg);
      const cur = `/${out.join('/')}`;
      const node = nodes.get(cur);
      const isFinal = segs.length === 0;
      if (node?.kind === 'symlink' && (followFinal || !isFinal)) {
        if (++hops > 50) throw new Error(`ELOOP: ${p}`);
        const targetSegs = node.target.split('/').filter(Boolean);
        if (node.target.startsWith('/')) out.length = 0;
        else out.pop();
        segs.unshift(...targetSegs);
      }
    }
    return `/${out.join('/')}`;
  };

  const asDirent = (name: string, node: FsNode): Dirent =>
    ({
      name,
      isFile: () => node.kind === 'file',
      isDirectory: () => node.kind === 'dir',
      isSymbolicLink: () => node.kind === 'symlink',
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    }) as unknown as Dirent;

  const asStats = (node: FsNode): Stats =>
    ({
      isFile: () => node.kind === 'file',
      isDirectory: () => node.kind === 'dir',
      isSymbolicLink: () => node.kind === 'symlink',
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    }) as unknown as Stats;

  return {
    readdir: async (p) => {
      const node = nodes.get(resolve(p, true));
      if (!node || node.kind !== 'dir') throw new Error(`ENOTDIR: ${p}`);
      return Object.entries(node.children).map(([name, child]) => asDirent(name, child));
    },
    lstat: async (p) => {
      const node = nodes.get(resolve(p, false));
      if (!node) throw new Error(`ENOENT: ${p}`);
      return asStats(node);
    },
    realpath: async (p) => {
      const resolved = resolve(p, true);
      if (!nodes.has(resolved)) throw new Error(`ENOENT: ${p}`);
      return resolved;
    },
    readFile: async (p) => {
      const node = nodes.get(resolve(p, true));
      if (!node || node.kind !== 'file') throw new Error(`ENOENT: ${p}`);
      return node.content;
    },
  };
}

/** Order-free projection of an occurrence for compact assertions. */
function shape(occ: FolderOccurrence): { path: string; via: string; entryPath: string } {
  return { path: occ.path, via: occ.via, entryPath: occ.entry.path };
}

function paths(occs: FolderOccurrence[]): string[] {
  return occs.map((o) => o.path);
}

function scan(roots: string[], tree: Record<string, FsNode>): Promise<SparseTree> {
  return scanFolderModel({ roots, fs: memFs(tree) });
}

// ---------------------------------------------------------------------------

describe('scanFolderModel — classification', () => {
  it('classifies a folder with agent-definition front matter as a persona', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({
        'my-folder': dir({
          'AGENTS.md': marker('product-manager', 'Drives the product'),
        }),
      }),
    });

    expect(tree.occurrences).toHaveLength(1);
    const occ = tree.occurrences[0];
    expect(occ.path).toBe('/root1/my-folder');
    expect(occ.via).toBe('scan');
    // name is the basename, never the persona name; persona carries the front matter.
    expect(occ.entry).toEqual({
      path: '/root1/my-folder',
      name: 'my-folder',
      nature: 'persona',
      persona: { name: 'product-manager', description: 'Drives the product' },
    });
    expect(occ.children).toEqual([]);
  });

  it('omits persona description when the front matter has none', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ solo: dir({ 'AGENTS.md': marker('solo') }) }),
    });

    expect(tree.occurrences).toHaveLength(1);
    expect(tree.occurrences[0].entry.persona).toEqual({ name: 'solo' });
  });

  it('classifies a folder with a .git directory as code', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ 'my-repo': repo() }),
    });

    expect(tree.occurrences).toHaveLength(1);
    expect(tree.occurrences[0].entry).toEqual({
      path: '/root1/my-repo',
      name: 'my-repo',
      nature: 'code',
    });
  });

  it('classifies a folder with a .git file as code', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ 'my-worktree': dir({ '.git': file('gitdir: /elsewhere') }) }),
    });

    expect(tree.occurrences).toHaveLength(1);
    expect(tree.occurrences[0].entry.nature).toBe('code');
  });

  it('prefers persona over code when marker and git are both present', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ both: dir({ '.git': dir(), 'AGENTS.md': marker('chief') }) }),
    });

    expect(tree.occurrences).toHaveLength(1);
    expect(tree.occurrences[0].entry.nature).toBe('persona');
  });

  it('treats front matter without a name key as no marker', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({
        w: dir({
          'AGENTS.md': file('---\ndescription: no name key\n---\nprompt body'),
          inner: repo(),
        }),
      }),
    });

    expect(paths(tree.occurrences)).toEqual(['/root1/w/inner']);
  });

  it('treats an AGENTS.md without front matter as no marker', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({
        w: dir({
          'AGENTS.md': file('project instructions, no front matter'),
          inner: repo(),
        }),
      }),
    });

    expect(paths(tree.occurrences)).toEqual(['/root1/w/inner']);
  });

  it('treats a front-matter block that does not begin the AGENTS.md as no marker', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({
        w: dir({
          'AGENTS.md': file('intro text\n---\nname: late\n---\n'),
          inner: repo(),
        }),
      }),
    });

    expect(paths(tree.occurrences)).toEqual(['/root1/w/inner']);
  });

  it('captures quoted YAML strings and ignores other agent-definition keys', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ p: dir({ 'AGENTS.md': file('---\nname: "007"\ndescription: "A name: with punctuation"\ntools: [read, bash]\nmodel: example\n---\nprompt') }) }),
    });
    expect(tree.occurrences[0].entry.persona).toEqual({ name: '007', description: 'A name: with punctuation' });
  });

  it.each(['123', 'true', 'null', '[agent]', '{key: value}'])('rejects a non-string YAML name (%s)', async (name) => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ w: dir({ 'AGENTS.md': file(`---\nname: ${name}\n---\n`), inner: repo() }) }),
    });
    expect(paths(tree.occurrences)).toEqual(['/root1/w/inner']);
  });

  it.each(['---\nname: missing-close\n', '---\nname: [broken\n---\n'])('falls back to git for malformed front matter (%s)', async (content) => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ w: dir({ '.git': dir(), 'AGENTS.md': file(content) }) }),
    });
    expect(tree.occurrences[0].entry).toEqual({ path: '/root1/w', name: 'w', nature: 'code' });
  });

  it('classifies marker-less AGENTS.md plus git as code', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ w: dir({ '.git': dir(), 'AGENTS.md': file('project instructions') }) }),
    });
    expect(tree.occurrences[0].entry).toEqual({ path: '/root1/w', name: 'w', nature: 'code' });
  });

  it('does not treat package.json as an inclusion marker', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({
        w: dir({ 'package.json': file('{}'), inner: repo() }),
      }),
    });

    expect(paths(tree.occurrences)).toEqual(['/root1/w/inner']);
  });
});

describe('scanFolderModel — pruning', () => {
  it('discovers nothing hidden inside pruned directories', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({
        node_modules: dir({ pkg: repo() }),
        dist: dir({ deep: repo() }),
        build: dir({ deep: repo() }),
        target: dir({ deep: repo() }),
        '.venv': dir({ deep: repo() }),
        plain: dir({ repo: repo() }),
      }),
    });

    expect(paths(tree.occurrences)).toEqual(['/root1/plain/repo']);
  });

  it('prunes at any depth below a root', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({
        w: dir({
          node_modules: dir({ pkg: repo() }),
          dist: dir({ pkg: dir({ 'AGENTS.md': marker('buried') }) }),
          repo: repo(),
        }),
      }),
    });

    expect(paths(tree.occurrences)).toEqual(['/root1/w/repo']);
  });
});

describe('scanFolderModel — sparse descent', () => {
  it('collapses skipped folders into occurrence paths without emitting nodes for them', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ wrapper: dir({ inner: repo() }) }),
    });

    expect(tree.occurrences).toHaveLength(1);
    expect(shape(tree.occurrences[0])).toEqual({
      path: '/root1/wrapper/inner',
      via: 'scan',
      entryPath: '/root1/wrapper/inner',
    });
  });

  it('stops descent at an included folder', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({
        outer: dir({
          '.git': dir(),
          inner: repo(),
          'inner-persona': dir({ 'AGENTS.md': marker('hidden') }),
        }),
      }),
    });

    expect(paths(tree.occurrences)).toEqual(['/root1/outer']);
    expect(tree.occurrences[0].children).toEqual([]);
  });
});

describe('scanFolderModel — shortcuts', () => {
  it('emits a shortcut occurrence for a top-level out-of-tree symlink of an included folder', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ a: dir({ '.git': dir(), link: link('/ext/t') }) }),
      '/ext': dir({ t: repo() }),
    });

    expect(tree.occurrences).toHaveLength(1);
    const a = tree.occurrences[0];
    expect(shape(a)).toEqual({ path: '/root1/a', via: 'scan', entryPath: '/root1/a' });
    expect(a.children).toHaveLength(1);
    const shortcut = a.children[0];
    expect(shape(shortcut)).toEqual({ path: '/root1/a/link', via: 'shortcut', entryPath: '/ext/t' });
    expect(shortcut.entry).toEqual({ path: '/ext/t', name: 't', nature: 'code' });
    expect(shortcut.children).toEqual([]);
  });

  it('restarts discovery at the shortcut target, recurring through its own shortcuts', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ a: dir({ '.git': dir(), link: link('/ext/t') }) }),
      '/ext': dir({
        t: dir({ '.git': dir(), link2: link('/ext2/u') }),
      }),
      '/ext2': dir({ u: dir({ 'AGENTS.md': marker('builder', 'builds things') }) }),
    });

    const a = tree.occurrences[0];
    const shortcut = a.children[0];
    expect(shortcut.children).toHaveLength(1);
    const nested = shortcut.children[0];
    expect(shape(nested)).toEqual({ path: '/root1/a/link/link2', via: 'shortcut', entryPath: '/ext2/u' });
    expect(nested.entry.nature).toBe('persona');
    expect(nested.entry.persona).toEqual({ name: 'builder', description: 'builds things' });
    expect(nested.children).toEqual([]);
  });

  it('restarts discovery at a skipped shortcut target and descends through it', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ a: dir({ '.git': dir(), link: link('/ext/w') }) }),
      '/ext': dir({ w: dir({ sub: dir({ r: repo() }) }) }),
    });

    const a = tree.occurrences[0];
    expect(a.children).toHaveLength(1);
    const shortcut = a.children[0];
    // The skipped target and its skipped subfolder collapse into the path string.
    expect(shape(shortcut)).toEqual({ path: '/root1/a/link/sub/r', via: 'shortcut', entryPath: '/ext/w/sub/r' });
    expect(shortcut.children).toEqual([]);
    // The skipped target is never an entry of its own.
    expect(a.children.some((c) => c.entry.path === '/ext/w')).toBe(false);
  });

  it('ignores top-level symlinks that do not point out of the folder', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({
        a: dir({
          '.git': dir(),
          inner: dir(),
          self: link('/root1/a/inner'),
          filelink: link('/ext/f'),
        }),
      }),
      '/ext': dir({ f: file('just a file') }),
    });

    expect(tree.occurrences).toHaveLength(1);
    expect(tree.occurrences[0].children).toEqual([]);
  });

  it('recognizes a sibling with a shared path prefix as outside the included folder', async () => {
    const tree = await scan(['/root1/a'], {
      '/root1': dir({ a: dir({ '.git': dir(), sibling: link('/root1/ab'), self: link('/root1/a') }), ab: repo() }),
    });
    expect(tree.occurrences[0].children.map(shape)).toEqual([{ path: '/root1/a/sibling', via: 'shortcut', entryPath: '/root1/ab' }]);
  });

  it('follows in-tree symlinks during skipped descent without an out-of-tree condition', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ alias: link('/root1/w'), w: dir({ r: repo() }) }),
    });
    expect(paths(tree.occurrences).sort()).toEqual(['/root1/alias/r', '/root1/w/r']);
    expect(tree.occurrences.every((o) => o.via === 'scan')).toBe(true);
    expect(tree.occurrences[0].entry).toBe(tree.occurrences[1].entry);
  });

  it('prunes while descending through a skipped shortcut target', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ a: dir({ '.git': dir(), link: link('/ext') }) }),
      '/ext': dir({ node_modules: dir({ hidden: repo() }), w: dir({ r: repo() }) }),
    });
    expect(tree.occurrences[0].children.map(shape)).toEqual([{ path: '/root1/a/link/w/r', via: 'shortcut', entryPath: '/ext/w/r' }]);
  });

  it('follows out-of-tree symlinks during skipped descent like ordinary folders', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ s: dir({ link: link('/ext/x') }) }),
      '/ext': dir({ x: dir({ repo: repo() }) }),
    });

    // No out-of-tree condition outside included folders: discovery descends
    // through the symlink as if it were an ordinary folder.
    expect(tree.occurrences).toHaveLength(1);
    expect(shape(tree.occurrences[0])).toEqual({
      path: '/root1/s/link/repo',
      via: 'scan',
      entryPath: '/ext/x/repo',
    });
    expect(tree.occurrences[0].children).toEqual([]);
  });
});

describe('scanFolderModel — identity', () => {
  it('terminates symlink cycles through skipped directories without losing healthy folders', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ w: dir({ back: link('/root1'), r: repo() }) }),
    });
    expect(paths(tree.occurrences)).toEqual(['/root1/w/r']);
    expect(() => JSON.stringify(tree)).not.toThrow();
  });

  it('shares one entry across shortcut occurrences and takes children from the first discovery', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ a: dir({ '.git': dir(), l1: link('/ext/t'), l2: link('/ext/t') }) }),
      '/ext': dir({ t: dir({ '.git': dir(), ll: link('/ext2/u') }) }),
      '/ext2': dir({ u: repo() }),
    });

    const a = tree.occurrences[0];
    expect(a.children).toHaveLength(2);
    expect(paths(a.children).sort()).toEqual(['/root1/a/l1', '/root1/a/l2']);

    const [first, second] = a.children;
    // One entry, one identity — later encounters reference the same entry.
    expect(first.entry.path).toBe('/ext/t');
    expect(second.entry.path).toBe('/ext/t');
    expect(second.entry).toBe(first.entry);

    // Children come from the first discovery: both occurrences show the
    // target's own shortcuts (paths are deliberately not asserted here —
    // whether they are shared verbatim or rebased is unpinned).
    for (const occ of a.children) {
      expect(occ.children).toHaveLength(1);
      expect(occ.children[0].via).toBe('shortcut');
      expect(occ.children[0].entry.path).toBe('/ext2/u');
    }
  });

  it('terminates when shortcuts form a cycle', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ a: dir({ '.git': dir(), link: link('/ext/b') }) }),
      '/ext': dir({ b: dir({ '.git': dir(), back: link('/root1/a') }) }),
    });

    expect(tree.occurrences).toHaveLength(1);
    const a = tree.occurrences[0];
    expect(shape(a)).toEqual({ path: '/root1/a', via: 'scan', entryPath: '/root1/a' });
    expect(a.children).toHaveLength(1);
    const toB = a.children[0];
    expect(shape(toB)).toEqual({ path: '/root1/a/link', via: 'shortcut', entryPath: '/ext/b' });
    expect(toB.children).toHaveLength(1);
    // The cycle closes on the already-discovered entry and discovery stops there.
    const backToA = toB.children[0];
    expect(shape(backToA)).toEqual({ path: '/root1/a/link/back', via: 'shortcut', entryPath: '/root1/a' });
    expect(backToA.entry).toBe(a.entry);
    expect(backToA.children).toEqual([]);
    expect(() => JSON.stringify(tree)).not.toThrow();
  });
});

describe('scanFolderModel — roots', () => {
  it('classifies configured roots normally and stops at included roots', async () => {
    const tree = await scan(['/code', '/persona'], {
      '/code': dir({ '.git': dir(), nested: repo() }),
      '/persona': dir({ 'AGENTS.md': marker('chief'), nested: repo() }),
    });

    expect(paths(tree.occurrences).sort()).toEqual(['/code', '/persona']);
    expect(tree.occurrences.find((o) => o.path === '/code')?.entry.nature).toBe('code');
    expect(tree.occurrences.find((o) => o.path === '/persona')?.entry.nature).toBe('persona');
    expect(tree.occurrences.every((o) => o.children.length === 0)).toBe(true);
  });

  it('scans every configured root', async () => {
    const tree = await scan(['/root1', '/root2'], {
      '/root1': dir({ r1: repo() }),
      '/root2': dir({ r2: repo() }),
    });

    expect(paths(tree.occurrences).sort()).toEqual(['/root1/r1', '/root2/r2']);
    expect(tree.occurrences.every((o) => o.via === 'scan')).toBe(true);
  });

  it('returns an empty tree for an empty roots list', async () => {
    const tree = await scan([], {});
    expect(tree).toEqual({ occurrences: [] });
  });

  it('returns an empty tree when every folder below the roots is skipped', async () => {
    const tree = await scan(['/root1'], {
      '/root1': dir({ a: dir({ b: dir({ c: dir() }) }) }),
    });
    expect(tree).toEqual({ occurrences: [] });
  });
});

describe('scanFolderModel — filesystem failures', () => {
  it('warns and skips missing/non-directory roots while scanning healthy roots', async () => {
    const warnings: { path: string }[] = [];
    const tree = await scanFolderModel({
      roots: ['/missing', '/file', '/root1'],
      fs: memFs({ '/file': file(), '/root1': dir({ r: repo() }) }),
      onWarning: (warning) => warnings.push(warning),
    });
    expect(paths(tree.occurrences)).toEqual(['/root1/r']);
    expect(warnings.some((w) => w.path === '/missing')).toBe(true);
    expect(warnings.some((w) => w.path === '/file')).toBe(true);
  });

  it('warns and skips dangling/looping shortcuts without hiding healthy shortcuts', async () => {
    const warnings: { path: string }[] = [];
    const tree = await scanFolderModel({
      roots: ['/root1'],
      fs: memFs({
        '/root1': dir({ a: dir({ '.git': dir(), dangling: link('/missing'), loop: link('/loop'), good: link('/ext') }) }),
        '/loop': link('/loop'),
        '/ext': repo(),
      }),
      onWarning: (warning) => warnings.push(warning),
    });
    expect(tree.occurrences[0].children.map(shape)).toEqual([{ path: '/root1/a/good', via: 'shortcut', entryPath: '/ext' }]);
    expect(warnings.some((w) => w.path === '/root1/a/dangling')).toBe(true);
    expect(warnings.some((w) => w.path === '/root1/a/loop')).toBe(true);
  });

  it.each(['readdir', 'lstat', 'realpath'] as const)('warns on %s failure and preserves healthy siblings', async (operation) => {
    const fs = memFs({ '/root1': dir({ bad: dir({ r: repo() }), good: repo() }) });
    const original = fs[operation];
    const error = new Error('permission denied');
    fs[operation] = (async (path: string) => {
      if (path === '/root1/bad') throw error;
      return original(path);
    }) as (typeof fs)[typeof operation];
    const warnings: { path: string; operation: string; error: unknown }[] = [];
    const tree = await scanFolderModel({ roots: ['/root1'], fs, onWarning: (warning) => warnings.push(warning) });
    expect(paths(tree.occurrences)).toEqual(['/root1/good']);
    expect(warnings).toContainEqual({ path: '/root1/bad', operation, error });
  });

  it('warns on unreadable AGENTS.md and falls back to git or skipped descent', async () => {
    const fs = memFs({
      '/root1': dir({
        code: dir({ '.git': dir(), 'AGENTS.md': marker('unreadable') }),
        skipped: dir({ 'AGENTS.md': marker('unreadable'), r: repo() }),
      }),
    });
    const error = new Error('permission denied');
    fs.readFile = async () => {
      throw error;
    };
    const warnings: { path: string; operation: string; error: unknown }[] = [];
    const tree = await scanFolderModel({ roots: ['/root1'], fs, onWarning: (warning) => warnings.push(warning) });
    expect(paths(tree.occurrences).sort()).toEqual(['/root1/code', '/root1/skipped/r']);
    expect(tree.occurrences.every((o) => o.entry.nature === 'code')).toBe(true);
    for (const path of ['/root1/code/AGENTS.md', '/root1/skipped/AGENTS.md']) {
      expect(warnings).toContainEqual({ path, operation: 'readFile', error });
    }
  });
});
