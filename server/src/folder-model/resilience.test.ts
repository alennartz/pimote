import { describe, it, expect } from 'vitest';
import type { Dirent, Stats } from 'node:fs';
import { scanFolderModel, type FolderFs, type FolderOccurrence, type FolderScanWarning, type SparseTree } from './index.js';
import { parsePersonaFrontMatter } from './marker.js';

// ---------------------------------------------------------------------------
// Failure-injecting FolderFs fake for the scanner's failure-path behavior. The
// canonical 43 cases live in folder-model.test.ts (immutable); this suite pins
// the failure and bounds behavior around them.
// ---------------------------------------------------------------------------

type FsNode = { kind: 'dir'; children: Record<string, FsNode> } | { kind: 'file'; content: string } | { kind: 'symlink'; target: string };

const dir = (children: Record<string, FsNode> = {}): FsNode => ({ kind: 'dir', children });
const file = (content = ''): FsNode => ({ kind: 'file', content });
const link = (target: string): FsNode => ({ kind: 'symlink', target });
const repo = (): FsNode => dir({ '.git': dir() });
const persona = (name: string): FsNode => file(`---\nkind: persona\nname: ${name}\n---\nprompt body`);

function join(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

interface FakeFs extends FolderFs {
  calls: Record<string, string[]>;
}

function memFs(tree: Record<string, FsNode>): FakeFs {
  const nodes = new Map<string, FsNode>();
  const add = (path: string, node: FsNode): void => {
    nodes.set(path, node);
    if (node.kind === 'dir') for (const [name, child] of Object.entries(node.children)) add(join(path, name), child);
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
    }) as unknown as Dirent;

  const asStats = (node: FsNode): Stats =>
    ({
      isFile: () => node.kind === 'file',
      isDirectory: () => node.kind === 'dir',
      isSymbolicLink: () => node.kind === 'symlink',
    }) as unknown as Stats;

  const calls: Record<string, string[]> = { readdir: [], readFile: [] };

  return {
    calls,
    readdir: async (p) => {
      calls.readdir.push(p);
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
      calls.readFile.push(p);
      const node = nodes.get(resolve(p, true));
      if (!node || node.kind !== 'file') throw new Error(`ENOENT: ${p}`);
      return node.content;
    },
  };
}

function entries(tree: SparseTree): string[] {
  const out: string[] = [];
  const visit = (occ: FolderOccurrence): void => {
    out.push(occ.entry.path);
    occ.children.forEach(visit);
  };
  tree.occurrences.forEach(visit);
  return out;
}

describe('scanFolderModel — identity checked before I/O (transient re-read failures)', () => {
  it('references the shared entry on a later reach when the marker read fails transiently', async () => {
    const base = memFs({
      '/root': dir({ '.git': dir(), l1: link('/ext/b'), l2: link('/ext/b') }),
      '/ext/b': dir({ 'AGENTS.md': persona('Bee'), inner: repo() }),
    });
    // The marker reads fine on first discovery and fails on every later reach —
    // without identity-first reuse the second encounter re-classifies `b` as
    // skipped (unreadable marker, no git) and descends through it.
    let markerReads = 0;
    const fs: FolderFs = {
      ...base,
      readFile: async (p: string): Promise<string> => {
        if (p.endsWith('AGENTS.md') && ++markerReads > 1) throw new Error('EIO: transient');
        return base.readFile(p);
      },
    };

    const warnings: FolderScanWarning[] = [];
    const tree = await scanFolderModel({ roots: ['/root'], fs, onWarning: (w) => warnings.push(w) });

    const rootOcc = tree.occurrences[0];
    const first = rootOcc.children.find((c) => c.path === '/root/l1');
    const later = rootOcc.children.find((c) => c.path === '/root/l2');
    expect(first).toBeDefined();
    expect(later).toBeDefined();
    // Same shared entry object, first-discovery children reused.
    expect(later!.entry).toBe(first!.entry);
    // Descent never restarted through the already-included folder.
    expect([...new Set(entries(tree))].sort()).toEqual(['/ext/b', '/root']);
    expect(warnings).toEqual([]);
  });

  it('still references the shared entry when the later readdir fails transiently', async () => {
    const base = memFs({
      '/root': dir({ '.git': dir(), l1: link('/ext/b'), l2: link('/ext/b') }),
      '/ext/b': repo(),
    });
    const fs: FolderFs = {
      ...base,
      readdir: (p: string) => (p === '/root/l2' ? Promise.reject(new Error('EIO: transient')) : base.readdir(p)),
    };

    const warnings: FolderScanWarning[] = [];
    const tree = await scanFolderModel({ roots: ['/root'], fs, onWarning: (w) => warnings.push(w) });

    const later = tree.occurrences[0].children.find((c) => c.path === '/root/l2');
    expect(later?.entry.path).toBe('/ext/b');
    expect(warnings).toEqual([]);
  });
});

describe('scanFolderModel — work budget', () => {
  it('bounds a skipped-descent DAG, warns once, and serves a finite partial tree', async () => {
    // Layered DAG: every skipped layer holds a real child folder and a symlink
    // to it — 2^6 re-read reach paths without a budget.
    const layered = (path: string, i: number): Record<string, FsNode> => {
      if (i === 0) return { fin: repo() };
      const realPath = `${path}/real`;
      return { real: dir(layered(realPath, i - 1)), link: link(realPath) };
    };
    const fs = memFs({ '/r': dir(layered('/r', 6)) });

    const warnings: FolderScanWarning[] = [];
    const result = await scanFolderModel({ roots: ['/r'], fs, onWarning: (w) => warnings.push(w), visitBudget: 20 });

    expect(warnings.filter((w) => w.operation === 'budget')).toHaveLength(1);
    // Bounded traversal: far below the 2^6 re-read reach paths an unbudgeted
    // walk would take.
    expect(fs.calls.readdir.length).toBeLessThanOrEqual(21);
    expect(entries(result).length).toBeLessThan(40);
  });

  it('does not trip on a healthy tree within the budget', async () => {
    const fs = memFs({ '/r': dir({ a: repo(), b: repo(), c: dir({ d: repo() }) }) });

    const warnings: FolderScanWarning[] = [];
    const tree = await scanFolderModel({ roots: ['/r'], fs, onWarning: (w) => warnings.push(w), visitBudget: 20 });

    expect(warnings).toEqual([]);
    expect(entries(tree).sort()).toEqual(['/r/a', '/r/b', '/r/c/d']);
  });
});

describe('scanFolderModel — file symlinks below skipped folders', () => {
  it('skips a file symlink silently instead of manufacturing an ENOTDIR warning', async () => {
    const fs = memFs({
      '/root': dir({ stuff: dir({ 'f-link': link('/ext/file.txt'), repo: repo() }) }),
      '/ext': dir({ 'file.txt': file('contents') }),
    });

    const warnings: FolderScanWarning[] = [];
    const tree = await scanFolderModel({ roots: ['/root'], fs, onWarning: (w) => warnings.push(w) });

    expect(warnings).toEqual([]);
    expect(entries(tree)).toEqual(['/root/stuff/repo']);
  });
});

describe('parsePersonaFrontMatter — block scalars', () => {
  it('does not close on an indented --- inside a YAML block scalar', () => {
    const content = ['---', 'kind: persona', 'name: X', 'description: |', '  first', '  ---', '  second', '---', 'prompt body'].join('\n');

    const parsed = parsePersonaFrontMatter(content);
    expect(parsed?.name).toBe('X');
    expect(parsed?.description).toContain('second');
    expect(parsed?.description).toContain('---');
  });
});

describe('scanFolderModel — canonical root at /', () => {
  it('treats top-level symlinks of a root-anchored folder as in-tree and names the entry /', async () => {
    const fs = memFs({
      '/': dir({ '.git': dir(), 'other-link': link('/other'), other: repo() }),
      '/other': repo(),
    });

    const warnings: FolderScanWarning[] = [];
    const tree = await scanFolderModel({ roots: ['/'], fs, onWarning: (w) => warnings.push(w) });

    const rootOcc = tree.occurrences.find((o) => o.entry.path === '/');
    expect(rootOcc).toBeDefined();
    expect(rootOcc!.entry.name).toBe('/');
    // /other resolves inside / — no shortcut occurrence.
    expect(rootOcc!.children).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
