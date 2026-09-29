import { mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { ProjectInfo, RepoInfo } from '../../shared/dist/index.js';
import type { RepoIndex } from './repo-index.js';

const REGISTRY_FILE = 'registry.json';
const DOCUMENT_VERSION = 1;

/** One persisted multi-repo hub project. */
interface HubEntry {
  path: string;
  name: string;
  memberPaths: string[];
}

/** Curation flags for one project path; absent keys mean "unset". */
interface OverrideEntry {
  favorite?: boolean;
  order?: number;
  archived?: boolean;
}

/** The registry's single JSON document at `<storeDir>/registry.json`. */
interface RegistryDocument {
  version: number;
  hubs: HubEntry[];
  overrides: Record<string, OverrideEntry>;
}

/** Curation patch for one project; keyed by project path. */
export interface ProjectUpdatePatch {
  projectPath: string;
  favorite?: boolean;
  order?: number;
  archived?: boolean;
}

function emptyDocument(): RegistryDocument {
  return { version: DOCUMENT_VERSION, hubs: [], overrides: {} };
}

/** Parse a persisted document; a corrupt or malformed file degrades to empty. */
function parseDocument(raw: string): RegistryDocument {
  try {
    const parsed = JSON.parse(raw) as Partial<RegistryDocument>;
    if (!Array.isArray(parsed.hubs)) return emptyDocument();
    if (typeof parsed.overrides !== 'object' || parsed.overrides === null) return emptyDocument();
    // Per-entry shape: one malformed hub (e.g. no memberPaths in a hand-edited
    // file) must not poison every listing — skip the entry, keep the rest.
    const hubs = parsed.hubs.filter((hub): hub is HubEntry => {
      if (typeof hub?.path !== 'string' || typeof hub?.name !== 'string') return false;
      return Array.isArray(hub.memberPaths) && hub.memberPaths.every((p) => typeof p === 'string');
    });
    return { version: DOCUMENT_VERSION, hubs, overrides: parsed.overrides };
  } catch {
    return emptyDocument();
  }
}

/**
 * The project-name rule shared by every server-side creation path
 * (create_project, hub creation, the built-in creator): non-empty, no path
 * separators, not . or ..
 */
export function isValidProjectName(name: string): boolean {
  return !!name && !name.includes('/') && !name.includes(sep) && name !== '.' && name !== '..';
}

/**
 * Enrich projects in place with live session counts: a session counts toward
 * the project whose path it runs in (exact match). Derived state the registry
 * itself cannot know — every path that serves `ProjectInfo`s (list_projects,
 * the projects_changed broadcast, the manager tool) runs its list through
 * this so no consumer ever sees zeroed counts.
 */
export function enrichActiveSessionCounts(projects: ProjectInfo[], activeSessions: ReadonlyArray<{ folderPath: string | null }>): void {
  for (const project of projects) {
    project.activeSessionCount = activeSessions.filter((session) => session.folderPath === project.path).length;
  }
}

/** Whether anything (file, directory, symlink) exists at the path. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Placeholder for a hub member the index no longer knows. */
function missingRepo(path: string): RepoInfo {
  return { path, name: basename(path), branch: null, dirty: false, ahead: 0, behind: 0, missing: true };
}

/** The merged view: every index repo as `single`, every hub as `multi` with resolved members. */
function mergedProjects(doc: RegistryDocument, repos: RepoInfo[]): ProjectInfo[] {
  const byPath = new Map(repos.map((repo) => [repo.path, repo]));
  const projects: ProjectInfo[] = repos.map((repo) => ({
    path: repo.path,
    name: repo.name,
    kind: 'single' as const,
    activeSessionCount: 0,
    externalProcessCount: 0,
    ...doc.overrides[repo.path],
  }));

  for (const hub of doc.hubs) {
    projects.push({
      path: hub.path,
      name: hub.name,
      kind: 'multi' as const,
      repos: hub.memberPaths.map((memberPath) => byPath.get(memberPath) ?? missingRepo(memberPath)),
      activeSessionCount: 0,
      externalProcessCount: 0,
      ...doc.overrides[hub.path],
    });
  }

  return projects;
}

/** Manual order ascending first, then the rest by name. */
function sortProjects(projects: ProjectInfo[]): ProjectInfo[] {
  return [...projects].sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order || a.name.localeCompare(b.name);
    if (a.order !== undefined) return -1;
    if (b.order !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** The generated hub AGENTS.md: members plus the sub-project convention. */
function agentsMarkdown(hubName: string, memberPaths: string[]): string {
  const members = memberPaths.map((memberPath) => `- ${basename(memberPath)} → ${memberPath}`).join('\n');
  return [
    `# ${hubName}`,
    '',
    'A multi-repo project. The member repositories below are symlinked into this directory:',
    '',
    members,
    '',
    '## Convention',
    '',
    'Each member directory is an independent git repository with its own AGENTS.md. When working',
    'inside a member directory, that repository is a sub-project: its AGENTS.md takes precedence',
    "over this file, and keep each repository's work inside its own directory.",
    '',
  ].join('\n');
}

/**
 * The persistent user-owned layer over the repo index: multi-repo hub
 * projects, curation overrides (favorite / manual order / archived) keyed by
 * repo path for single-repo projects, hub creation (mkdir + symlinks +
 * generated AGENTS.md), disbanding, and change notifications. Persists as
 * JSON following the session-json-store pattern.
 */
export class ProjectRegistry {
  private documentPromise: Promise<RegistryDocument> | null = null;
  private readonly subscribers = new Set<() => void>();

  constructor(
    private readonly repos: RepoIndex,
    private readonly storeDir: string,
  ) {}

  /**
   * The merged project view: every repo from the index as a `single` project
   * (with curation overrides applied) plus persisted hub projects as `multi`.
   */
  async list(): Promise<ProjectInfo[]> {
    const [doc, repos] = await Promise.all([this.document(), this.repos.list()]);
    return sortProjects(mergedProjects(doc, repos));
  }

  /** Apply a curation patch. Unknown project paths reject. */
  async update(patch: ProjectUpdatePatch): Promise<void> {
    const doc = await this.document();
    const known = await this.knownProjectPaths(doc);
    if (!known.has(patch.projectPath)) throw new Error(`Unknown project: ${patch.projectPath}`);

    const override = doc.overrides[patch.projectPath] ?? {};
    if (patch.favorite !== undefined) override.favorite = patch.favorite;
    if (patch.order !== undefined) override.order = patch.order;
    if (patch.archived !== undefined) override.archived = patch.archived;
    doc.overrides[patch.projectPath] = override;

    await this.persist(doc);
    this.fireChange();
  }

  /**
   * Create a multi-repo hub project: mkdir under `root`, symlink every member
   * repo, and generate the hub AGENTS.md with the sub-project convention.
   * Every repoPath must exist in the repo index; unknown members reject.
   */
  async createHub(name: string, root: string, repoPaths: string[]): Promise<{ path: string }> {
    const doc = await this.document();
    const repos = await this.repos.list();
    const byPath = new Map(repos.map((repo) => [repo.path, repo]));

    if (!isValidProjectName(name)) throw new Error(`Invalid project name: ${name}`);
    const unknown = repoPaths.find((repoPath) => !byPath.has(repoPath));
    if (unknown !== undefined) throw new Error(`Unknown repo: ${unknown}`);
    const memberPaths = repoPaths.map((repoPath) => byPath.get(repoPath)!.path);
    // Two members with the same basename collide on one symlink target inside
    // the hub dir — reject up front so no partial hub is ever built.
    const seen = new Set<string>();
    for (const memberPath of memberPaths) {
      const base = basename(memberPath);
      if (seen.has(base)) throw new Error(`Duplicate member name: ${base}`);
      seen.add(base);
    }
    const target = join(root, name);
    if (await pathExists(target)) throw new Error(`Directory already exists: ${target}`);

    await mkdir(target, { recursive: true });
    try {
      for (const memberPath of memberPaths) {
        await symlink(memberPath, join(target, basename(memberPath)));
      }
      await writeFile(join(target, 'AGENTS.md'), agentsMarkdown(name, memberPaths), 'utf8');
      doc.hubs.push({ path: target, name, memberPaths });
      await this.persist(doc);
    } catch (error) {
      // Never leave a half-built hub folder behind: it would block retry
      // (Directory already exists) and couldn't be disbanded (no registry
      // entry) — all-or-nothing.
      await rm(target, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    this.fireChange();
    return { path: target };
  }

  /** Remove a hub project: registry entry removed and the hub folder deleted. */
  async disband(projectPath: string): Promise<void> {
    const doc = await this.document();
    const index = doc.hubs.findIndex((hub) => hub.path === projectPath);
    if (index === -1) throw new Error(`Not a hub project: ${projectPath}`);

    // rm on a directory unlinks symlinks inside it; the member repos survive.
    await rm(doc.hubs[index].path, { recursive: true, force: true });
    doc.hubs.splice(index, 1);
    await this.persist(doc);
    this.fireChange();
  }

  /** Subscribe to registry mutations; returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Index repo paths plus persisted hub paths — everything update() accepts. */
  private async knownProjectPaths(doc: RegistryDocument): Promise<Set<string>> {
    const repos = await this.repos.list();
    return new Set([...repos.map((repo) => repo.path), ...doc.hubs.map((hub) => hub.path)]);
  }

  /** Lazy-loaded document; the promise is cached so the file is read once.
   *  A load failure clears the cache — one transient read error (EACCES,
   *  EISDIR) must not brick every project command until restart. */
  private document(): Promise<RegistryDocument> {
    if (!this.documentPromise) {
      this.documentPromise = this.loadDocument().catch((error) => {
        this.documentPromise = null;
        throw error;
      });
    }
    return this.documentPromise;
  }

  private async loadDocument(): Promise<RegistryDocument> {
    try {
      const raw = await readFile(join(this.storeDir, REGISTRY_FILE), 'utf8');
      return parseDocument(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument();
      throw error;
    }
  }

  /** Atomic replace: write to `.tmp`, then rename over the final path. */
  private async persist(doc: RegistryDocument): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    const finalPath = join(this.storeDir, REGISTRY_FILE);
    const temporaryPath = `${finalPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, finalPath);
  }

  private fireChange(): void {
    for (const cb of [...this.subscribers]) cb();
  }
}
