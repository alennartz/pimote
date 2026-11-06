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
// Covers, hard and without an LLM: the manager toolset registers by name
// (nine tools, including the restored `pimote_disband_hub`; no `*_projects`
// or retired persona/search/repo/tree names survive),
// pimote_find_folders returns complete FolderInfo rows with schema defaults
// (and the nature filter serves the team view; hub rows carry their member
// lists), pimote_create_folder (kind persona) materializes the persona
// folder (front matter + memory stub) and publishes it exactly on success
// (discovery invalidation + folders_changed pairing), and the worktree-hub
// lifecycle runs end-to-end through the manager seams: worktree creation
// (detached checkouts + mode marker), representation-aware membership edits
// via pimote_update_hub_members, and the guarded pimote_disband_hub
// rejections (symlink hub, working-or-observed session, dirty checkout,
// unreachable detached HEAD) followed by a successful disband that closes
// the idle observerless hub session itself and preserves branches.
// The destructive disband fixture is always fabricated inside the sandbox —
// a user-supplied MTMS_ROOT tree never hosts it.
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

import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
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

  // Destructive worktree/disband fixture: always fabricated inside the
  // sandbox. Disband deletes worktrees and the hub directory, so a
  // user-supplied MTMS_ROOT tree must never host it.
  const disbandRoot = join(sandbox, 'disband-fixture');
  const codeA = join(disbandRoot, 'code-a');
  const codeB = join(disbandRoot, 'code-b');
  const guideDir = join(disbandRoot, 'guide');
  await gitInit(codeA);
  await gitInit(codeB);
  await writePersona(guideDir, 'Guide Persona', 'Fixture persona for the worktree probe');

  const git = (cwd, ...args) => execFile('git', ['-C', cwd, ...args]);
  /** A nested worktree carries `.git` as a file; an independent repo as a directory. */
  const isWorktreeCheckout = async (dir) => (await lstat(join(dir, '.git')).then((s) => s.isFile(), () => false)) === true;

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
  const { HubWorktrees, defaultWorktreeGitRunner } = await import(dist('hub-worktrees.js'));
  const { HubActivity } = await import(dist('hub-activity.js'));
  const { createManagerExtension } = await import(dist('manager/extension.js'));

  const tree = { tree: () => scanFolderModel({ roots: [root, disbandRoot], onWarning: () => {} }) };
  // Duck-typed RepoIndex seam: the probe fabricates the repo rows, the
  // registry and tools consume them through the same narrow port boot wires.
  const invalidations = [];
  const notifications = [];
  const repos = {
    list: async () => [await repoRow(alpha), await repoRow(beta)],
    // The registry's membership paths read the lazy view (never blocked on
    // git probes); the stub serves the same fabricated rows.
    listLazy: async () => [await repoRow(alpha), await repoRow(beta)],
    listSourceHubs: async () => [],
    listSourcePersonas: async () => [],
    runOpenHooks: async () => {},
    invalidateListing: () => invalidations.push(Date.now()),
    // Git facts fill in per served row; the probe stubs the refresh seam.
    requestStatusRefresh: async () => {},
  };
  // Session slots the disband guard sees, split by the guard's rule: an idle
  // observerless slot closes during disband (recorded for assertion); a
  // working or observed slot stays and keeps the hub busy.
  const workingSessionCwds = [];
  let idleSessionCwd = null;
  const closedSessionCwds = [];
  const hostedBy = (cwd, paths) => paths.some((p) => cwd === p || cwd.startsWith(p + '/'));
  const folders = new FolderRegistry(
    repos,
    storeDir,
    tree,
    new HubWorktrees(defaultWorktreeGitRunner),
    new HubActivity({
      // Stand-in for the session manager's close seam: idle observerless
      // slots close during the guard, working or observed slots remain.
      closeIdleSessionsAt: async (paths) => {
        if (idleSessionCwd && hostedBy(idleSessionCwd, paths)) {
          closedSessionCwds.push(idleSessionCwd);
          idleSessionCwd = null;
        }
        return workingSessionCwds.filter((cwd) => hostedBy(cwd, paths));
      },
      externalPiWorkingDirectories: async () => [],
    }),
  );
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
      resumeSession: async (sessionId) => ({ sessionId, outcome: 'not_found' }),
    },
    creators: {
      create: async () => {
        throw new Error('not used by this probe');
      },
    },
    config: { roots: [root, disbandRoot], managerRoot: sandbox },
    notifyFoldersChanged: (changedPaths) => notifications.push(changedPaths),
  };

  // Identity is canonical: compare against real paths everywhere below.
  const [alphaC, betaC, omegaC, codeAC, codeBC, guideC] = await Promise.all([
    realpath(alpha),
    realpath(beta),
    realpath(omega),
    realpath(codeA),
    realpath(codeB),
    realpath(guideDir),
  ]);

  // --- hub creation through the real registry (hint: self-describing hub) ---
  section('hub materialization (real createHub)');
  let created;
  try {
    created = await folders.createHub({ name: 'west', root, memberPaths: [alpha, beta] });
  } catch (error) {
    assert(false, `createHub succeeds (${error instanceof Error ? error.message : error})`);
    throw error;
  }
  assert(created.path === (await realpath(west)), 'createHub returns the canonical path');
  const createdRow = (await folders.list()).find((row) => row.path === created.path);
  assert(createdRow?.repos?.length === 2, 'the folder view derives both code-member repos from the hub symlinks');
  assert(
    createdRow?.members
      ?.map((member) => member.path)
      .sort()
      .join(',') === [alphaC, betaC].sort().join(','),
    'the folder view derives membership from the symlink inventory',
  );
  assert(!(await exists(join(storeDir, 'registry.json'))), 'hub creation writes no creator-ownership receipt');
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
    'pimote_find_folders',
    'pimote_find_sessions',
    'pimote_start_session',
    'pimote_resume_session',
    'pimote_archive_sessions',
    'pimote_create_folder',
    'pimote_update_folder',
    'pimote_update_hub_members',
    'pimote_disband_hub',
  ];
  for (const name of expected) assert(tools.has(name), `tool registered: ${name}`);
  assert(names.length === 9, `the toolset registers exactly nine tools (got: ${names.length})`);
  assert(!names.some((name) => name.includes('project')), `no registered tool name contains "project" (got: ${names.join(', ')})`);
  assert(
    ![
      'pimote_list_projects',
      'pimote_project_tree',
      'pimote_create_persona',
      'pimote_list_personas',
      'pimote_search_sessions',
      'pimote_list_repos',
      'pimote_folder_tree',
    ].some((name) => tools.has(name)),
    'the retired tool names stay gone',
  );

  // --- pimote_find_folders: complete FolderInfo rows with schema defaults ---
  section('pimote_find_folders execution');
  const listResult = await tools.get('pimote_find_folders').execute('call-1', {});
  assert(listResult.isError !== true, 'list_folders executes without error');
  const rows = listResult.structuredContent?.folders;
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

  // --- The unified sessions view still executes ---
  section('remaining folder-view tools execute');
  const sessionsResult = await tools.get('pimote_find_sessions').execute('call-4', {});
  assert(sessionsResult.isError !== true && Array.isArray(sessionsResult.structuredContent?.sessions), 'list_sessions executes against the sessions port');

  // --- pimote_find_folders nature filter: the team view ---
  section('pimote_find_folders nature filter');
  const personasResult = await tools.get('pimote_find_folders').execute('call-5', { nature: 'persona' });
  assert(personasResult.isError !== true, 'list_folders (nature: persona) executes without error');
  const personaRows = personasResult.structuredContent?.folders;
  assert(Array.isArray(personaRows) && personaRows.every((row) => row.nature === 'persona'), 'every filtered row is a persona');
  const omegaPersona = personaRows?.find((row) => row.path === omegaC);
  assert(omegaPersona?.persona?.name === 'Omega Persona', 'omega row carries the marker name');
  assert(omegaPersona?.persona?.description?.includes('Fixture persona'), 'omega row carries the marker description');
  assert(!personaRows?.some((row) => row.path === alphaC || row.path === betaC), 'code folders are excluded from the nature-filtered rows');

  // --- pimote_create_folder (kind persona): disk effects + publish pairing ---
  if (!process.env.MTMS_ROOT) {
    section('pimote_create_folder (kind persona) execution');
    const invBefore = invalidations.length;
    const notBefore = notifications.length;
    const createResult = await tools.get('pimote_create_folder').execute('call-6', {
      kind: 'persona',
      name: 'zeta',
      parentPath: root,
      description: 'Created persona',
      prompt: 'CUSTOM PROMPT MARKER.',
    });
    assert(createResult.isError !== true, 'create_folder (kind persona) executes without error');
    const zetaC = createResult.structuredContent?.folderPath;
    assert(zetaC === (await realpath(join(root, 'zeta'))), 'result folderPath is the canonical new folder');
    const zetaAgents = await readFile(join(root, 'zeta', 'AGENTS.md'), 'utf8');
    assert(zetaAgents.includes('kind: persona') && zetaAgents.includes('name: "zeta"'), 'AGENTS.md carries parseable persona front matter');
    assert(zetaAgents.includes('description: "Created persona"'), 'front matter carries the caller description');
    assert(zetaAgents.includes('CUSTOM PROMPT MARKER.'), "the caller's prompt folds into the body");
    assert(zetaAgents.includes('memory.md'), 'body keeps the maintain-memory.md instruction');
    assert(await exists(join(root, 'zeta', 'memory.md')), 'memory.md stub is created');
    assert(invalidations.length > invBefore, 'creation invalidates folder-model discovery');
    assert(notifications.length > notBefore && notifications[notifications.length - 1].includes(zetaC), 'creation broadcasts folders_changed with the new path');

    // Collision: refuses, leaves the existing folder untouched, publishes nothing.
    const zetaBefore = await readFile(join(root, 'zeta', 'AGENTS.md'), 'utf8');
    const inv2 = invalidations.length;
    const not2 = notifications.length;
    const collision = await tools.get('pimote_create_folder').execute('call-7', {
      kind: 'persona',
      name: 'zeta',
      parentPath: root,
      description: 'Overwrite attempt',
    });
    assert(collision.isError === true, 'name collision returns a tool error');
    assert(String(collision.structuredContent?.error ?? '').includes('leaves'), 'collision error carries the leaf-rule hint');
    assert((await readFile(join(root, 'zeta', 'AGENTS.md'), 'utf8')) === zetaBefore, 'collision leaves the existing persona untouched');
    assert(invalidations.length === inv2 && notifications.length === not2, 'failed creations publish nothing');

    const badName = await tools.get('pimote_create_folder').execute('call-8', { kind: 'persona', name: '../evil', parentPath: root, description: 'x' });
    assert(badName.isError === true && !(await exists(join(sandbox, 'evil'))), 'traversal names are rejected with no disk effect');
    const outside = await tools.get('pimote_create_folder').execute('call-9', { kind: 'persona', name: 'stray', parentPath: sandbox, description: 'x' });
    assert(outside.isError === true && !(await exists(join(sandbox, 'stray'))), 'parentPath outside the scan roots is rejected with no disk effect');

    const personasAfter = (await tools.get('pimote_find_folders').execute('call-10', { nature: 'persona' })).structuredContent?.folders;
    assert(
      personasAfter?.some((row) => row.path === zetaC && row.persona?.name === 'zeta'),
      'the nature-filtered team view picks up the created persona',
    );
  } else {
    console.log('  ⊝ create_folder execution skipped — MTMS_ROOT fixture tree is user-supplied');
  }

  // ============================================================
  // Worktree-hub lifecycle through the manager seams. The fixture is the
  // isolated sandbox root, so these run even when MTMS_ROOT supplies the
  // scan tree: disband deletes worktrees and the hub directory.
  // ============================================================
  section('pimote_create_folder: worktree hub (detached checkouts, marker, row facts)');
  const wtHub = join(disbandRoot, 'wt-hub');
  const wtCreate = await tools.get('pimote_create_folder').execute('call-wt1', {
    kind: 'code-hub',
    name: 'wt-hub',
    parentPath: disbandRoot,
    memberPaths: [codeA],
    memberRepresentation: 'worktree',
    body: 'Worktree hub for the disband probe.',
  });
  assert(wtCreate.isError !== true, `create_folder (kind code-hub, worktree) executes without error (${JSON.stringify(wtCreate.structuredContent ?? wtCreate.content)})`);
  const wtHubC = wtCreate.structuredContent?.folderPath;
  assert(wtHubC === (await realpath(wtHub)), 'the worktree hub result path is canonical');
  assert((await readFile(join(wtHub, '.pimote-hub.json'), 'utf8').catch(() => '')).trim() === '{"memberRepresentation":"worktree"}', 'the hub carries the minimal worktree-mode marker');
  assert((await isWorktreeCheckout(join(wtHub, 'code-a'))) === true, 'the code member materializes as a nested worktree (.git file, not a directory)');
  const checkout = join(wtHubC, 'code-a');
  const { stdout: checkoutRef } = await git(checkout, 'rev-parse', '--abbrev-ref', 'HEAD');
  const [{ stdout: checkoutSha }, { stdout: sourceSha }] = await Promise.all([git(checkout, 'rev-parse', 'HEAD'), git(codeAC, 'rev-parse', 'HEAD')]);
  assert(checkoutRef.trim() === 'HEAD' && checkoutSha.trim() === sourceSha.trim(), 'the checkout is detached exactly at the source HEAD');
  const { stdout: sourceBranch } = await git(codeAC, 'rev-parse', '--abbrev-ref', 'HEAD');
  const { stdout: sourceStatus } = await git(codeAC, 'status', '--porcelain');
  const { stdout: sourceWorktrees } = await git(codeAC, 'worktree', 'list', '--porcelain');
  assert(sourceBranch.trim() === 'main' && sourceStatus.trim() === '', 'creation leaves the source repository on main and clean');
  assert(sourceWorktrees.includes(checkout), 'git worktree list confirms the nested checkout from the source repository');
  const wtRows = (await tools.get('pimote_find_folders').execute('call-wt2', {})).structuredContent?.folders;
  const wtRow = wtRows?.find((row) => row.path === wtHubC);
  assert(wtRow?.hub?.representation === 'worktree', 'the folder row carries the worktree hub fact');
  const wtMember = wtRow?.members?.find((member) => member.path === codeAC);
  assert(
    wtMember?.representation === 'worktree' && wtMember?.worktreePath === checkout,
    'the member row reports worktree representation with its checkout path',
  );
  assert(wtRow?.repos?.some((repo) => repo.path === codeAC && repo.worktreePath === checkout), 'the member repo row reports the nested checkout under the canonical source identity');
  assert(wtRow?.shortcutCount === 0, 'worktree members are not shortcuts (shortcutCount 0)');

  section('pimote_update_hub_members: representation-aware edits in a worktree hub');
  const addGuide = await tools.get('pimote_update_hub_members').execute('call-wt3', { hubPath: wtHubC, add: [guideC] });
  assert(addGuide.isError !== true, 'update_hub_members adds the persona member');
  assert((await readlink(join(wtHub, 'guide')).catch(() => null)) === guideC, 'a persona member joins a worktree hub as a symlink');
  const wtAgents = await readFile(join(wtHub, 'AGENTS.md'), 'utf8').catch(() => '');
  assert(wtAgents.includes('- guide (persona): always spin a sub-agent in this folder to interact with it.'), 'the exact seeded persona line lands in the managed block');
  assert(wtAgents.includes('Code members are nested detached Git worktrees; persona members are symlinks'), 'the generated intro describes the worktree layout');

  const addCodeB = await tools.get('pimote_update_hub_members').execute('call-wt4', { hubPath: wtHubC, add: [codeBC] });
  assert(addCodeB.isError !== true, 'update_hub_members adds the code member');
  assert((await isWorktreeCheckout(join(wtHub, 'code-b'))) === true, 'a code member joins a worktree hub as a detached worktree');
  const wtRows2 = (await tools.get('pimote_find_folders').execute('call-wt5', {})).structuredContent?.folders;
  const wtMemberB = wtRows2?.find((row) => row.path === wtHubC)?.members?.find((member) => member.path === codeBC);
  assert(wtMemberB?.representation === 'worktree' && wtMemberB?.worktreePath === join(wtHubC, 'code-b'), 'the added code member reports its checkout path');

  await writeFile(join(checkout, 'scratch.txt'), 'uncommitted\n');
  const removeDirty = await tools.get('pimote_update_hub_members').execute('call-wt6', { hubPath: wtHubC, remove: [codeAC] });
  const dirtyOutcome = removeDirty.structuredContent?.results?.[0];
  assert(
    removeDirty.isError !== true && dirtyOutcome?.outcome === 'error' && String(dirtyOutcome?.error ?? '').includes('uncommitted changes'),
    'removing a dirty worktree member reports the clean-state error',
  );
  assert((await isWorktreeCheckout(checkout)) === true, 'the dirty member keeps its checkout on disk');
  await rm(join(checkout, 'scratch.txt'), { force: true });

  const removeCodeB = await tools.get('pimote_update_hub_members').execute('call-wt7', { hubPath: wtHubC, remove: [codeBC] });
  const codeBOutcome = removeCodeB.structuredContent?.results?.[0];
  assert(removeCodeB.isError !== true && codeBOutcome?.outcome === 'removed', 'update_hub_members removes the clean code member');
  assert(!(await exists(join(wtHub, 'code-b'))), 'clean removal deletes the nested checkout');
  const { stdout: codeBBranch } = await git(codeBC, 'rev-parse', '--abbrev-ref', 'HEAD');
  const { stdout: codeBStatus } = await git(codeBC, 'status', '--porcelain');
  assert(codeBBranch.trim() === 'main' && codeBStatus.trim() === '', 'removal leaves the source repository on main and clean');
  assert(!(await git(codeBC, 'worktree', 'list', '--porcelain')).stdout.includes(join(wtHubC, 'code-b')), 'git no longer lists the removed checkout');

  section('pimote_disband_hub: guarded rejections and a successful disband');
  const disband = async (callId, hubPath) => tools.get('pimote_disband_hub').execute(callId, { hubPath });
  const disbandError = (result) => String(result.structuredContent?.error ?? '');

  const disbandSymlink = await disband('call-db1', westC);
  assert(disbandSymlink.isError === true && disbandError(disbandSymlink).includes('Not a worktree hub'), 'a symlink hub rejects disband');
  assert(await exists(west), 'the rejected symlink hub stays on disk');

  // A working or observed session slot stays hosted: the guard rejects.
  workingSessionCwds.push(checkout);
  const disbandBusy = await disband('call-db2', wtHubC);
  assert(disbandBusy.isError === true && disbandError(disbandBusy).includes('in use'), 'a hub with a working or observed session in its subtree rejects disband');
  assert(await exists(wtHub), 'the busy hub stays on disk');
  workingSessionCwds.length = 0;

  // An idle, observerless slot closes during the guard, so disband proceeds
  // to the worktree guards: here the dirty checkout still rejects, and the
  // closed slot is recorded.
  idleSessionCwd = checkout;
  await writeFile(join(checkout, 'scratch.txt'), 'uncommitted\n');
  const disbandDirty = await disband('call-db3', wtHubC);
  assert(disbandDirty.isError === true && disbandError(disbandDirty).includes('uncommitted changes'), 'a dirty checkout rejects disband after the idle session closed');
  assert(closedSessionCwds.includes(checkout), 'the guard closed the idle observerless hub session during the disband attempt');
  assert(await exists(wtHub), 'the dirty-rejected hub stays on disk');
  await rm(join(checkout, 'scratch.txt'), { force: true });

  // A detached HEAD no branch ref reaches: commit work on the detached HEAD.
  await writeFile(join(checkout, 'lonely.txt'), 'unreachable work\n');
  await git(checkout, 'add', '.');
  await git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'lonely detached work');
  const disbandUnreachable = await disband('call-db4', wtHubC);
  assert(
    disbandUnreachable.isError === true && disbandError(disbandUnreachable).includes('not reachable from a branch ref'),
    'a detached HEAD unreachable from any branch ref rejects disband',
  );
  assert(await exists(wtHub), 'the unreachable-rejected hub stays on disk');

  // Branch creation is user-owned: naming the detached commit keeps the work.
  await git(checkout, 'branch', 'feature/keep');
  const disbandOk = await disband('call-db5', wtHubC);
  assert(disbandOk.isError !== true, 'disband succeeds once HEAD is reachable from a branch ref');
  assert(
    JSON.stringify(disbandOk.structuredContent?.removedWorktreePaths) === JSON.stringify([checkout]),
    'the response lists the removed checkout path',
  );
  assert(!(await exists(wtHub)), 'the hub directory is gone after disband');
  assert(await exists(guideC), 'disband never follows member symlinks (the persona folder survives)');
  const { stdout: keptBranch } = await git(codeAC, 'branch', '--list', 'feature/keep');
  assert(keptBranch.includes('feature/keep'), 'disband never deletes the user-created branch');
  const { stdout: afterBranch } = await git(codeAC, 'rev-parse', '--abbrev-ref', 'HEAD');
  const { stdout: afterStatus } = await git(codeAC, 'status', '--porcelain');
  const { stdout: afterWorktrees } = await git(codeAC, 'worktree', 'list', '--porcelain');
  assert(afterBranch.trim() === 'main' && afterStatus.trim() === '' && !afterWorktrees.includes(wtHubC), 'the source repository stays on main, clean, with no stale worktree registration');
  const rowsAfterDisband = (await tools.get('pimote_find_folders').execute('call-db6', {})).structuredContent?.folders;
  assert(!rowsAfterDisband?.some((row) => row.path === wtHubC), 'the disbanded hub leaves the folder listing');

  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  console.log(`\n[mt-smoke] complete: ${failures === 0 ? 'PASS' : `${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[mt-smoke] uncaught:', error);
  process.exit(1);
});
