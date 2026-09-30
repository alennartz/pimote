import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { ProjectInfo, RepoInfo } from '../../shared/dist/index.js';
import { materializeMultiRepoFolder } from './project-sources/materialize.js';
import type { MultiRepoSourceEntry } from './project-sources/index.js';
import type { RepoIndex } from './repo-index.js';

const REGISTRY_FILE = 'registry.json';
const DOCUMENT_VERSION = 1;

/** One persisted multi-repo project. */
interface MultiRepoEntry {
  path: string;
  name: string;
  memberPaths: string[];
}

/** Curation flags for one project path; absent keys mean "unset". */
interface OverrideEntry {
  favorite?: boolean;
  order?: number;
  archived?: boolean;
  /** User tags at this path. */
  tags?: string[];
}

/** The registry's single JSON document at `<storeDir>/registry.json`. */
interface RegistryDocument {
  version: number;
  multiRepo: MultiRepoEntry[];
  overrides: Record<string, OverrideEntry>;
}

/** Curation patch for one project; keyed by project path. */
export interface ProjectUpdatePatch {
  projectPath: string;
  favorite?: boolean;
  order?: number;
  archived?: boolean;
  addTags?: string[];
  removeTags?: string[];
}

function emptyDocument(): RegistryDocument {
  return { version: DOCUMENT_VERSION, multiRepo: [], overrides: {} };
}

/** Parse a persisted document; a corrupt or malformed file degrades to empty. */
function parseDocument(raw: string): RegistryDocument {
  try {
    const parsed = JSON.parse(raw) as Partial<RegistryDocument>;
    const multiRepo = Array.isArray(parsed.multiRepo) ? parsed.multiRepo : [];
    if (!Array.isArray(multiRepo)) return emptyDocument();
    if (typeof parsed.overrides !== 'object' || parsed.overrides === null) return emptyDocument();
    // Per-entry shape: one malformed multi-repo entry (e.g. no memberPaths in a hand-edited
    // file) must not poison every listing — skip the entry, keep the rest.
    const entries = multiRepo.filter((entry): entry is MultiRepoEntry => {
      if (typeof entry?.path !== 'string' || typeof entry?.name !== 'string') return false;
      return Array.isArray(entry.memberPaths) && entry.memberPaths.every((p) => typeof p === 'string');
    });
    return { version: DOCUMENT_VERSION, multiRepo: entries, overrides: parsed.overrides };
  } catch {
    return emptyDocument();
  }
}

/**
 * The project-name rule shared by every server-side creation path
 * (create_project, multi-repo project creation, the built-in creator): non-empty, no path
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

/** Placeholder for a member repo the index no longer knows. */
function missingRepo(path: string): RepoInfo {
  return { path, name: basename(path), branch: null, dirty: false, ahead: 0, behind: 0, missing: true };
}

/** Union tag sets; undefined when all inputs are empty (keeps the wire clean). */
function unionTags(...sets: (string[] | undefined)[]): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    for (const tag of set ?? []) {
      if (!seen.has(tag)) {
        seen.add(tag);
        out.push(tag);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/** The merged view: every index repo as `single`, every multi-repo project as `multi` with resolved members.
 *  Multi-repo entries come from two layers — persisted (user-created) and source-listed (derived,
 *  gone when the source stops listing). On a path collision the persisted entry wins. */
function mergedProjects(doc: RegistryDocument, repos: RepoInfo[], sourceProjects: MultiRepoSourceEntry[] = []): ProjectInfo[] {
  const byPath = new Map(repos.map((repo) => [repo.path, repo]));

  /** Effective tags at a repo path: source-contributed ∪ user. */
  const repoTags = (repoPath: string): string[] | undefined => unionTags(byPath.get(repoPath)?.tags, doc.overrides[repoPath]?.tags);

  const projects: ProjectInfo[] = repos.map((repo) => ({
    path: repo.path,
    name: repo.name,
    kind: 'single' as const,
    activeSessionCount: 0,
    externalProcessCount: 0,
    ...doc.overrides[repo.path],
    tags: repoTags(repo.path),
    userTags: doc.overrides[repo.path]?.tags,
  }));
  const seen = new Set(projects.map((p) => p.path));

  for (const entry of [...doc.multiRepo, ...sourceProjects]) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const members: RepoInfo[] = entry.memberPaths.map((memberPath) => {
      const base = byPath.get(memberPath) ?? missingRepo(memberPath);
      // Member carries its own effective tags (source ∪ its own user tags).
      return { ...base, tags: repoTags(memberPath) };
    });
    // Multi-repo projects implicitly inherit their members' tags.
    const memberTagUnion = unionTags(...members.map((m) => m.tags));
    const sourceTags = sourceProjects.find((sp) => sp.path === entry.path)?.tags;
    const userTags = doc.overrides[entry.path]?.tags;
    projects.push({
      path: entry.path,
      name: entry.name,
      kind: 'multi' as const,
      repos: members,
      activeSessionCount: 0,
      externalProcessCount: 0,
      ...doc.overrides[entry.path],
      tags: unionTags(userTags, sourceTags, memberTagUnion),
      userTags,
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

/**
 * The persistent user-owned layer over the repo index: multi-repo project
 * projects, curation overrides (favorite / manual order / archived) keyed by
 * repo path for single-repo projects, multi-repo project creation (mkdir + symlinks +
 * generated AGENTS.md), disbanding, and change notifications. Persists as
 * JSON following the session-json-store pattern.
 */
export class ProjectRegistry {
  private documentPromise: Promise<RegistryDocument> | null = null;
  private readonly subscribers = new Set<() => void>();
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repos: RepoIndex,
    private readonly storeDir: string,
  ) {}

  /**
   * The merged project view: every repo from the index as a `single` project
   * (with curation overrides applied) plus persisted multi-repo projects as `multi`.
   */
  async list(): Promise<ProjectInfo[]> {
    const [doc, repos, sourceProjects] = await Promise.all([this.document(), this.repos.list(), this.repos.listSourceProjects()]);
    return sortProjects(mergedProjects(doc, repos, sourceProjects));
  }

  /** Apply a curation patch. Unknown project paths reject. */
  update(patch: ProjectUpdatePatch): Promise<void> {
    return this.serialized(async () => {
      const doc = await this.document();
      const known = await this.knownProjectPaths(doc);
      if (!known.has(patch.projectPath)) throw new Error(`Unknown project: ${patch.projectPath}`);

      const override = doc.overrides[patch.projectPath] ?? {};
      if (patch.favorite !== undefined) override.favorite = patch.favorite;
      if (patch.order !== undefined) override.order = patch.order;
      if (patch.archived !== undefined) override.archived = patch.archived;
      if (patch.addTags?.length || patch.removeTags?.length) {
        const tags = new Set(override.tags ?? []);
        for (const tag of patch.addTags ?? []) {
          const trimmed = tag.trim();
          if (trimmed) tags.add(trimmed);
        }
        for (const tag of patch.removeTags ?? []) tags.delete(tag);
        override.tags = [...tags];
      }
      doc.overrides[patch.projectPath] = override;

      await this.persist(doc);
      this.fireChange();
    });
  }

  /**
   * Create a multi-repo project: mkdir under `root`, symlink every member
   * repo, and generate the project AGENTS.md with the sub-project convention.
   * Every repoPath must exist in the repo index; unknown members reject.
   */
  async createMultiRepoProject(name: string, root: string, repoPaths: string[]): Promise<{ path: string }> {
    return this.serialized(async () => {
      const doc = await this.document();
      const repos = await this.repos.list();
      const byPath = new Map(repos.map((repo) => [repo.path, repo]));

      if (!isValidProjectName(name)) throw new Error(`Invalid project name: ${name}`);
      const unknown = repoPaths.find((repoPath) => !byPath.has(repoPath));
      if (unknown !== undefined) throw new Error(`Unknown repo: ${unknown}`);
      const memberPaths = repoPaths.map((repoPath) => byPath.get(repoPath)!.path);
      // Two members with the same basename collide on one symlink target inside
      // the target dir — reject up front so no partial project is ever built.
      const seen = new Set<string>();
      for (const memberPath of memberPaths) {
        const base = basename(memberPath);
        if (seen.has(base)) throw new Error(`Duplicate member name: ${base}`);
        seen.add(base);
      }
      const target = join(root, name);
      if (await pathExists(target)) throw new Error(`Directory already exists: ${target}`);

      try {
        await materializeMultiRepoFolder({ kind: 'project', path: target, name, memberPaths });
        doc.multiRepo.push({ path: target, name, memberPaths });
        await this.persist(doc);
      } catch (error) {
        // Never leave a half-built multi-repo project folder behind: it would block retry
        // (Directory already exists) and couldn't be disbanded (no registry
        // entry) — all-or-nothing.
        await rm(target, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      this.fireChange();
      return { path: target };
    });
  }

  /** Remove a multi-repo project: registry entry removed and the multi-repo project folder deleted. */
  disband(projectPath: string): Promise<void> {
    return this.serialized(async () => {
      const doc = await this.document();
      const index = doc.multiRepo.findIndex((entry) => entry.path === projectPath);
      if (index === -1) throw new Error(`Not a multi-repo project: ${projectPath}`);

      // rm on a directory unlinks symlinks inside it; the member repos survive.
      await rm(doc.multiRepo[index].path, { recursive: true, force: true });
      doc.multiRepo.splice(index, 1);
      await this.persist(doc);
      this.fireChange();
    });
  }

  /** Subscribe to registry mutations; returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Index repo paths plus persisted multi-repo project paths — everything update() accepts. */
  private async knownProjectPaths(doc: RegistryDocument): Promise<Set<string>> {
    const [repos, sourceProjects] = await Promise.all([this.repos.list(), this.repos.listSourceProjects()]);
    return new Set([...repos.map((repo) => repo.path), ...doc.multiRepo.map((entry) => entry.path), ...sourceProjects.map((entry) => entry.path)]);
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

  /** Serialize mutating operations: WS commands are handled fire-and-forget,
   *  so interleaved mutations would race on the shared cached document and
   *  the tmp file (e.g. two renames, the second hitting a moved tmp path).
   *  Each mutation runs only after the previous one settles. */
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => {});
    return result;
  }

  /** Atomic replace: write to a unique `.tmp`, then rename over the final
   *  path. On failure the cached document is dropped so the next read
   *  reloads from disk — the mutation may already sit in the shared cached
   *  object, and memory must not diverge from what's persisted. */
  private async persist(doc: RegistryDocument): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    const finalPath = join(this.storeDir, REGISTRY_FILE);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, finalPath);
    } catch (error) {
      this.documentPromise = null;
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private fireChange(): void {
    for (const cb of [...this.subscribers]) cb();
  }
}
