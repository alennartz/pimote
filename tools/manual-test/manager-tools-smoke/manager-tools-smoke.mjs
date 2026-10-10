#!/usr/bin/env node
// Deterministic probe for the manager's pimote toolset (manual-testing skill).
//
// Registers the shipped `createManagerExtension` toolset against a stub pi
// `ExtensionAPI` (capture-only — the pi wiring itself is pi's API contract),
// then executes the folder-view tools through a real ManagerToolContext: a
// real folder scan (`scanFolderModel`), a real `FolderRegistry` over a temp
// store, and a hub created by the real `createHub` (mkdir + absolute member
// symlinks + `git init` + `.gitignore` + generated AGENTS.md).
//
// Covers, hard and without an LLM: the tool names are the renamed ones
// (pimote_list_folders / pimote_folder_tree — no `*_projects` survives),
// pimote_list_folders returns complete FolderInfo rows with schema defaults,
// and pimote_folder_tree reports the sparse tree shape — hub member symlinks
// surface as `via: 'shortcut'` occurrences referencing the member entries.
//
// Parameterized for reuse: MTMS_ROOT=<dir> uses an existing fixture tree
// (containing at least two git repos `<root>/alpha`, `<root>/beta` and a
// persona folder `<root>/omega`) instead of fabricating one.
//
// Inputs: none (fresh os.tmpdir() sandbox unless MTMS_ROOT is set).
// Outputs: per-check ✓/✗ lines on stdout; non-zero exit on any failure.
// Prerequisites: workspaces built (`npm run build`) so server/dist exists;
// `git` on PATH (the real hub materializer runs `git init`). No server,
// browser, network, or LLM required.

import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve, basename } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCb);

const REPO_ROOT = pathResolve(new URL('../../../', import.meta.url).pathname);
const dist = (rel) => pathToFileURL(join(REPO_ROOT, 'server', 'dist', rel)).href;

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}
function section(message) {
  console.log(`\n[mt-smoke] ${message}`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function gitInit(dir, branch = 'main') {
  await mkdir(dir, { recursive: true });
  const git = (...args) => execFile('git', ['-C', dir, ...args]);
  await git('init', '-b', branch);
  await writeFile(join(dir, 'README.md'), `# ${basename(dir)}\n`);
  await git('add', '.');
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init');
}

/** Persona folder: AGENTS.md opening with YAML front matter (`kind: persona`, string `name:`). */
async function writePersona(dir, name, description) {
  await mkdir(dir, { recursive: true });
  const front = ['---', 'kind: persona', `name: ${name}`, `description: ${description}`, '---'].join('\n');
  await writeFile(join(dir, 'AGENTS.md'), `${front}\nYou are ${name}, a fixture persona.\n`);
}

/** RepoInfo row for a git repo — the same shape RepoIndex.list() serves. */
async function repoRow(dir) {
  const git = (...args) => execFile('git', ['-C', dir, ...args]);
  const { stdout: branch } = await git('rev-parse', '--abbrev-ref', 'HEAD');
  return { path: dir, name: basename(dir), branch: branch.trim(), dirty: false, ahead: 0, behind: 0 };
}

async function main() {
  console.log('[mt-smoke] manager toolset probe (deterministic, no LLM)');
  const sandbox = await mkdtemp(join(tmpdir(), 'manager-tools-smoke-'));
  const root = process.env.MTMS_ROOT ? pathResolve(process.env.MTMS_ROOT) : join(sandbox, 'scan');
  const storeDir = join(sandbox, 'store');
  await mkdir(storeDir, { recursive: true });

  // --- fixture tree (fabricated unless MTMS_ROOT supplies one) ---
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  const omega = join(root, 'omega');
  const west = join(root, 'west');
  if (!process.env.MTMS_ROOT) {
    await gitInit(alpha);
    await gitInit(beta);
    await writePersona(omega, 'Omega Persona', 'Fixture persona for the toolset probe');
  }

  const { scanFolderModel } = await import(dist('folder-model/index.js'));
  const { FolderRegistry } = await import(dist('folder-registry.js'));
  const { createManagerExtension } = await import(dist('manager/extension.js'));

  const tree = { tree: () => scanFolderModel({ roots: [root], onWarning: () => {} }) };
  // Duck-typed RepoIndex seam: the probe fabricates the repo rows, the
  // registry and tools consume them through the same narrow port boot wires.
  const repos = {
    list: async () => [await repoRow(alpha), await repoRow(beta)],
    listSourceHubs: async () => [],
    listSourcePersonas: async () => [],
    runOpenHooks: async () => {},
  };
  const folders = new FolderRegistry(repos, storeDir, tree);
  const context = {
    folders,
    repos,
    tree,
    sessions: {
      getAllSessions: () => [],
      listDiskSessions: async () => [],
      openSession: async () => {
        throw new Error('not used by this probe');
      },
      archiveSessions: async () => [],
    },
    config: { roots: [root], managerRoot: sandbox },
  };

  // Identity is canonical: compare against real paths everywhere below.
  const [alphaC, betaC, omegaC] = await Promise.all([realpath(alpha), realpath(beta), realpath(omega)]);

  // --- hub creation through the real registry (hint: self-describing hub) ---
  section('hub materialization (real createHub)');
  let created;
  try {
    created = await folders.createHub({ name: 'west', root, memberPaths: [alpha, beta] });
  } catch (error) {
    assert(false, `createHub succeeds (${error instanceof Error ? error.message : error})`);
    throw error;
  }
  assert(created.path === (await realpath(west)) && created.repos?.length === 2, 'createHub returns the hub FolderInfo with both member repos');
  const westC = created.path; // canonical identity, from the real createHub
  assert(await exists(join(west, '.git')), 'hub is self-describing: git init ran in the hub folder');
  const ignore = await readFile(join(west, '.gitignore'), 'utf8').catch(() => '');
  const ignoreLines = ignore.split('\n').filter(Boolean);
  assert(ignoreLines.includes('/alpha') && ignoreLines.includes('/beta'), `.gitignore lists root-anchored member symlink patterns (got: ${JSON.stringify(ignoreLines)})`);
  assert((await readlink(join(west, 'alpha'))) === alpha && (await readlink(join(west, 'beta'))) === beta, 'member symlinks point at the absolute member paths');
  const { stdout: hubStatus } = await execFile('git', ['-C', west, 'status', '--porcelain']);
  assert(!hubStatus.split('\n').some((line) => /\b(alpha|beta)\b/.test(line)), 'member symlinks are git-ignored (absent from hub git status)');

  // --- tool registration (the rename's hard surface) ---
  section('tool registration');
  const tools = new Map();
  const piStub = {
    registerTool: (spec) => tools.set(spec.name, spec),
  };
  createManagerExtension(context)(piStub);
  const names = [...tools.keys()];
  const expected = [
    'pimote_list_folders',
    'pimote_folder_tree',
    'pimote_list_repos',
    'pimote_list_sessions',
    'pimote_search_sessions',
    'pimote_start_session',
    'pimote_archive_sessions',
    'pimote_create_persona',
    'pimote_list_personas',
  ];
  for (const name of expected) assert(tools.has(name), `tool registered: ${name}`);
  assert(!names.some((name) => name.includes('project')), `no registered tool name contains "project" (got: ${names.join(', ')})`);
  assert(
    !['pimote_list_projects', 'pimote_project_tree'].some((name) => tools.has(name)),
    'the pre-rename tool names are gone',
  );

  // --- pimote_list_folders: complete FolderInfo rows with schema defaults ---
  section('pimote_list_folders execution');
  const listResult = await tools.get('pimote_list_folders').execute('call-1', {});
  assert(listResult.isError !== true, 'list_folders executes without error');
  const rows = listResult.structuredContent;
  assert(Array.isArray(rows), 'structured output is a FolderInfo array');
  const byName = new Map(rows.map((row) => [row.path, row]));
  const alphaRow = byName.get(alphaC);
  const betaRow = byName.get(betaC);
  const omegaRow = byName.get(omegaC);
  const westRow = byName.get(westC);
  assert(alphaRow?.nature === 'code' && alphaRow?.shortcutCount === 0, 'alpha row: code nature, shortcutCount 0');
  assert(
    alphaRow?.favorite === false && alphaRow?.archived === false && alphaRow?.missing === false && Array.isArray(alphaRow?.tags),
    'alpha row carries required defaults (favorite/archived/missing false, tags array)',
  );
  assert(omegaRow?.nature === 'persona' && omegaRow?.persona?.name === 'Omega Persona', 'omega row: persona nature with marker name');
  assert(omegaRow?.name === 'omega' && omegaRow?.persona?.description?.includes('Fixture persona'), 'persona row keeps the folder basename as name; description survives');
  assert(betaRow?.nature === 'code', 'beta row: code nature');
  assert(westRow?.nature === 'code' && westRow?.shortcutCount === 2, 'west row: code nature with shortcutCount = member count');
  assert(westRow?.repos?.length === 2 && westRow?.repos?.every((r) => typeof r.branch === 'string'), 'west row lists both member repos with branch info');
  assert(!rows.some((row) => row.name === 'Omega Persona'), 'no row uses the persona name as its folder name');

  // --- pimote_folder_tree: sparse tree shape incl. shortcut occurrences ---
  section('pimote_folder_tree execution');
  const treeResult = await tools.get('pimote_folder_tree').execute('call-2', {});
  assert(treeResult.isError !== true, 'folder_tree executes without error');
  const sparse = treeResult.structuredContent;
  assert(Array.isArray(sparse?.occurrences), 'structured output carries an occurrences array');
  assert(sparse?.truncated === undefined, 'small tree is not truncated');
  const flat = [];
  const walk = (occurrences, depth) => {
    for (const occ of occurrences ?? []) {
      flat.push({ ...occ, depth });
      walk(occ.children, depth + 1);
    }
  };
  walk(sparse?.occurrences, 0);
  const westOcc = flat.find((occ) => occ.entry?.path === westC);
  assert(westOcc?.via === 'scan', 'hub occurrence reached by scan');
  const westShortcuts = (westOcc?.children ?? []).filter((occ) => occ.via === 'shortcut');
  assert(westShortcuts.length === 2, `hub exposes both member symlinks as shortcut occurrences (got ${westShortcuts.length})`);
  assert(
    westShortcuts.some((occ) => occ.entry?.path === alphaC) && westShortcuts.some((occ) => occ.entry?.path === betaC),
    'shortcut occurrences reference the member entries by canonical path',
  );
  const alphaScanOcc = flat.find((occ) => occ.entry?.path === alphaC && occ.via === 'scan');
  const alphaShortcutOcc = westShortcuts.find((occ) => occ.entry?.path === alphaC);
  assert(alphaScanOcc !== undefined && alphaScanOcc.entry === alphaShortcutOcc?.entry, 'scan and shortcut occurrences share one entry (identity is the canonical path)');
  assert(westShortcuts.every((occ) => typeof occ.path === 'string' && occ.path.includes('west')), 'shortcut reach paths extend the hub path');
  assert(
    flat.some((occ) => occ.entry?.path === omegaC && occ.entry?.nature === 'persona' && occ.entry?.persona?.name === 'Omega Persona'),
    'tree entries carry persona metadata',
  );
  assert(flat.every((occ) => typeof occ.path === 'string' && (occ.via === 'scan' || occ.via === 'shortcut') && Array.isArray(occ.children)), 'every occurrence has path/via/children');

  // --- pimote_list_repos and the read-only tools still execute ---
  section('remaining folder-view tools execute');
  const reposResult = await tools.get('pimote_list_repos').execute('call-3', {});
  assert(reposResult.isError !== true && Array.isArray(reposResult.structuredContent), 'list_repos executes against the repos port');
  const sessionsResult = await tools.get('pimote_list_sessions').execute('call-4', {});
  assert(sessionsResult.isError !== true && Array.isArray(sessionsResult.structuredContent), 'list_sessions executes against the sessions port');

  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  console.log(`\n[mt-smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[mt-smoke] uncaught:', error);
  process.exit(1);
});
