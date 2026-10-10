import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readdir, lstat, readlink, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FolderInfo } from '../../shared/dist/index.js';
import { FolderRegistry } from './folder-registry.js';
import { RepoIndex } from './repo-index.js';
import { scanFolderModel } from './folder-model/index.js';
import type { FolderModelPort } from './manager/types.js';
import { seededMemberLine } from './hub-agents-md.js';
import { parsePersonaFrontMatter } from './folder-model/marker.js';
import { MEMORY_STUB } from './manager/seed.js';

const execFileAsync = promisify(execFile);

// The managed-block markers (plan: 0.15-2 dashboard folder UX).
const OPEN = '<!-- pimote:members (managed block) -->';
const CLOSE = '<!-- /pimote:members -->';

let tempDir: string;
let storeDir: string;
let rootDir: string;
let secondRoot: string;
let repoA: string;
let repoB: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'folder-registry-members-test-'));
  storeDir = join(tempDir, 'registry');
  rootDir = join(tempDir, 'root');
  secondRoot = join(tempDir, 'second-root');
  repoA = join(rootDir, 'repo-a');
  repoB = join(rootDir, 'repo-b');
  await mkdir(rootDir, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  await initRepo(repoA);
  await initRepo(repoB);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function initRepo(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const gitArgs = ['-c', 'init.defaultBranch=main', '-c', 'user.name=t', '-c', 'user.email=t@t'];
  await execFileAsync('git', [...gitArgs, 'init'], { cwd: repoPath, env });
  await execFileAsync('git', [...gitArgs, 'commit', '--allow-empty', '-m', 'init'], { cwd: repoPath, env });
}

/** A persona folder: marker front matter in AGENTS.md. */
async function makePersona(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'AGENTS.md'), `---\nkind: persona\nname: Friendly\ndescription: Greets everyone\n---\n\nBody.\n`, 'utf8');
  return path;
}

function makeIndex(): RepoIndex {
  return new RepoIndex([rootDir, secondRoot], { now: () => 0, ttlMs: 1_000_000, statusTtlMs: 1_000_000 });
}

function makeTree(): FolderModelPort {
  return { tree: () => scanFolderModel({ roots: [rootDir, secondRoot] }) };
}

function makeRegistry(): FolderRegistry {
  return new FolderRegistry(makeIndex(), storeDir, makeTree());
}

async function findRow(registry: FolderRegistry, path: string): Promise<FolderInfo | undefined> {
  return (await registry.list()).find((folder) => folder.path === path);
}

/** A symlink inside `folderDir` pointing at `target`, if any. */
async function findSymlinkTo(folderDir: string, target: string): Promise<string | undefined> {
  for (const entry of await readdir(folderDir)) {
    const full = join(folderDir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink() && (await readlink(full)) === target) return full;
  }
  return undefined;
}

async function readHubAgents(hubPath: string): Promise<string> {
  return readFile(join(hubPath, 'AGENTS.md'), 'utf8');
}

/** Create the shared hub with repo-a as its first member. */
async function makeHub(registry: FolderRegistry): Promise<string> {
  const row = await registry.createHub({ name: 'hub', root: rootDir, memberPaths: [repoA] });
  return row.path;
}

describe('FolderRegistry.addMember', () => {
  it('adds a discovered code folder as a hub member via a hub-side symlink', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);

    await registry.addMember(hubPath, repoB);

    expect(await findSymlinkTo(hubPath, repoB)).toBeDefined();
  });

  it('adds a discovered persona folder as a hub member — members are unrestricted by kind', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));

    await registry.addMember(hubPath, personaPath);

    expect(await findSymlinkTo(hubPath, personaPath)).toBeDefined();
  });

  it('rejects a path that is not a discovered folder-model entry, with a user-presentable message', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    // A valid add proves the seam is live — the rejection contract must not
    // pass on a stub that rejects everything.
    await registry.addMember(hubPath, repoB);
    const neverDiscovered = join(secondRoot, 'stray');
    await mkdir(neverDiscovered);

    const error = await registry.addMember(hubPath, neverDiscovered).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeGreaterThan(0);
    expect(await findSymlinkTo(hubPath, neverDiscovered)).toBeUndefined();
  });

  it('rejects a member whose basename collides with an existing member', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    // A valid add proves the seam is live before the rejection contract.
    await registry.addMember(hubPath, repoB);
    const sameBasename = await makePersona(join(secondRoot, 'repo-a'));

    const error = await registry.addMember(hubPath, sameBasename).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeGreaterThan(0);
    expect(await findSymlinkTo(hubPath, sameBasename)).toBeUndefined();
  });

  it("seeds the member's exact link line inside the hub AGENTS.md managed block", async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));

    await registry.addMember(hubPath, personaPath);

    const content = await readHubAgents(hubPath);
    const inner = content.slice(content.indexOf(OPEN) + OPEN.length, content.indexOf(CLOSE));
    expect(inner).toContain(seededMemberLine('ada', 'persona'));
  });

  it('seeds a nature-specific line — code and persona members get different wording', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));

    await registry.addMember(hubPath, repoB);
    await registry.addMember(hubPath, personaPath);

    const content = await readHubAgents(hubPath);
    expect(content).toContain(seededMemberLine('repo-b', 'code'));
    expect(content).toContain(seededMemberLine('ada', 'persona'));
  });

  it('broadcasts a folders_changed delta like the other mutations', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));
    const changes: { changedPaths: string[]; removedPaths: string[] }[] = [];
    const unsubscribe = registry.onChange((change) => changes.push(change));

    await registry.addMember(hubPath, personaPath);
    unsubscribe();

    expect(changes.some((change) => change.changedPaths.includes(hubPath))).toBe(true);
  });
});

describe('FolderRegistry.removeMember', () => {
  it("removes the hub-side symlink and the seeded line, leaving the document's other bytes untouched", async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));
    await registry.addMember(hubPath, personaPath);

    // User prose lands after the seeding — it must survive removal byte-exact.
    const seeded = await readHubAgents(hubPath);
    const userEdited = `${seeded}\nUser notes.\n`;
    await writeFile(join(hubPath, 'AGENTS.md'), userEdited, 'utf8');

    await registry.removeMember(hubPath, personaPath);

    const after = await readHubAgents(hubPath);
    expect(await findSymlinkTo(hubPath, personaPath)).toBeUndefined();
    expect(after).not.toContain(seededMemberLine('ada', 'persona'));
    expect(after).toContain('User notes.');
    expect(after.slice(0, after.indexOf(OPEN) + OPEN.length)).toBe(userEdited.slice(0, userEdited.indexOf(OPEN) + OPEN.length));
    expect(after.slice(after.indexOf(CLOSE))).toBe(userEdited.slice(userEdited.indexOf(CLOSE)));
  });

  it('never touches the member folder', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));
    await registry.addMember(hubPath, personaPath);

    await registry.removeMember(hubPath, personaPath);

    expect(await readFile(join(personaPath, 'AGENTS.md'), 'utf8')).toContain('Body.');
  });

  it('works by path even when the member folder is missing — symlink and seeded line go regardless', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));
    await registry.addMember(hubPath, personaPath);
    await rm(personaPath, { recursive: true, force: true });

    await registry.removeMember(hubPath, personaPath);

    expect(await findSymlinkTo(hubPath, personaPath)).toBeUndefined();
    expect(await readHubAgents(hubPath)).not.toContain(seededMemberLine('ada', 'persona'));
  });

  it('leaves a seeded line the user rewrote alone — mangled user files are not regenerated', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));
    await registry.addMember(hubPath, personaPath);

    const line = seededMemberLine('ada', 'persona');
    const rewritten = (await readHubAgents(hubPath)).replace(line, '- the user rewrote this member line');
    await writeFile(join(hubPath, 'AGENTS.md'), rewritten, 'utf8');

    await registry.removeMember(hubPath, personaPath);

    expect(await readHubAgents(hubPath)).toBe(rewritten);
  });

  it('does nothing to AGENTS.md when the block markers are gone', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));
    await registry.addMember(hubPath, personaPath);

    const stripped = (await readHubAgents(hubPath)).replaceAll(OPEN, '').replaceAll(CLOSE, '');
    await writeFile(join(hubPath, 'AGENTS.md'), stripped, 'utf8');

    await registry.removeMember(hubPath, personaPath);

    expect(await readHubAgents(hubPath)).toBe(stripped);
  });

  it('broadcasts a folders_changed delta like the other mutations', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));
    await registry.addMember(hubPath, personaPath);
    const changes: { changedPaths: string[]; removedPaths: string[] }[] = [];
    const unsubscribe = registry.onChange((change) => changes.push(change));

    await registry.removeMember(hubPath, personaPath);
    unsubscribe();

    expect(changes.some((change) => change.changedPaths.includes(hubPath))).toBe(true);
  });
});

describe('FolderInfo.members — hub rows', () => {
  it('lists the hub symlink inventory with path, name, and nature', async () => {
    const registry = makeRegistry();
    const hubPath = await makeHub(registry);
    const personaPath = await makePersona(join(rootDir, 'ada'));
    await registry.addMember(hubPath, personaPath);

    const row = await findRow(registry, hubPath);
    expect(row?.members).toHaveLength(2);
    expect(row?.members).toContainEqual({ path: repoA, name: basename(repoA), nature: 'code' });
    expect(row?.members).toContainEqual({ path: personaPath, name: basename(personaPath), nature: 'persona' });
  });
});

describe('FolderRegistry.createHub — widened membership and persona variant', () => {
  it('accepts persona folders as members — any discovered folder-model entry', async () => {
    const registry = makeRegistry();
    const personaPath = await makePersona(join(rootDir, 'ada'));

    const row = await registry.createHub({ name: 'hub', root: rootDir, memberPaths: [personaPath] });

    expect(await findSymlinkTo(row.path, personaPath)).toBeDefined();
  });

  it('seeds the AGENTS.md body from the text step (code-hub variant)', async () => {
    const registry = makeRegistry();

    const row = await registry.createHub({ name: 'hub', root: rootDir, memberPaths: [repoA], body: 'We build the widget.' });

    expect(await readHubAgents(row.path)).toContain('We build the widget.');
  });

  it('seeds exact nature-specific member links at creation', async () => {
    const registry = makeRegistry();
    const personaPath = await makePersona(join(rootDir, 'ada'));
    const row = await registry.createHub({ name: 'mixed', root: rootDir, memberPaths: [repoA, personaPath] });
    const content = await readHubAgents(row.path);
    const inner = content.slice(content.indexOf(OPEN) + OPEN.length, content.indexOf(CLOSE));
    expect(inner).toContain(seededMemberLine('repo-a', 'code'));
    expect(inner).toContain(seededMemberLine('ada', 'persona'));
  });

  it('seeds the nonempty persona-hub text body', async () => {
    const registry = makeRegistry();
    const row = await registry.createHub({ name: 'team', root: rootDir, memberPaths: [repoA], description: 'Team', personaText: 'Coordinate the team.' });
    expect(await readHubAgents(row.path)).toContain('Coordinate the team.');
  });

  it('seeds a persona marker and memory.md for the persona-hub variant', async () => {
    const registry = makeRegistry();

    const row = await registry.createHub({ name: 'team', root: rootDir, memberPaths: [repoA], description: 'Team of agents', personaText: '' });

    const content = await readHubAgents(row.path);
    expect(parsePersonaFrontMatter(content)).toEqual({ name: 'team', description: 'Team of agents' });
    expect(await readFile(join(row.path, 'memory.md'), 'utf8')).toBe(MEMORY_STUB);
  });
});
