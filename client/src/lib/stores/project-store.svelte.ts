// ProjectStore — manages project, repo, and session listing
import type {
  ListProjectsResponseData,
  ListReposResponseData,
  ProjectInfo,
  ProjectsChangedEvent,
  PimoteEvent,
  RepoInfo,
  SessionInfo,
  SessionStateChangedEvent,
  SessionDeletedEvent,
  SessionRenamedEvent,
  SessionArchivedEvent,
} from '@pimote/shared';
import { connection } from './connection.svelte.js';
import { SvelteMap } from 'svelte/reactivity';
import { getShowArchived, setShowArchived } from './persistence.js';

interface InFlightSessionLoad {
  includeArchived: boolean;
  requestId: number;
  promise: Promise<void>;
}

function toTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sortSessionsByRecency(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => toTimestamp(b.modified) - toTimestamp(a.modified) || toTimestamp(b.created) - toTimestamp(a.created) || a.id.localeCompare(b.id));
}

export class ProjectStore {
  projects: ProjectInfo[] = $state([]);
  repos: RepoInfo[] = $state([]);
  roots: string[] = $state([]);
  sessions = $state(new SvelteMap<string, SessionInfo[]>());
  loading: boolean = $state(false);
  showArchived: boolean = $state(getShowArchived());
  private projectsLoadInFlight: Promise<void> | null = null;
  private reposLoadInFlight: Promise<void> | null = null;
  private sessionLoadsInFlight: Map<string, InFlightSessionLoad> = new Map(); // eslint-disable-line svelte/prefer-svelte-reactivity -- in-flight request registry, not reactive UI state
  private nextSessionRequestId = 0;

  /**
   * Projects with the archived filter applied, displayed in three tiers:
   * manually ordered projects (user moved them) in explicit order, then
   * everything else by most recent session activity (old-sidebar behavior),
   * name as tiebreak. Projects with no sessions sink to the bottom.
   */
  get visibleProjects(): ProjectInfo[] {
    const list = this.showArchived ? this.projects : this.projects.filter((p) => !p.archived);
    const recency = (project: ProjectInfo): number => Math.max(0, ...(this.sessions.get(project.path) ?? []).map((s) => toTimestamp(s.modified)));
    const manuallyOrdered = list.filter((p) => typeof p.order === 'number').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const byRecency = list.filter((p) => typeof p.order !== 'number').sort((a, b) => recency(b) - recency(a) || a.name.localeCompare(b.name));
    return [...manuallyOrdered, ...byRecency];
  }

  async loadProjects(): Promise<void> {
    if (this.projectsLoadInFlight) return this.projectsLoadInFlight;

    this.projectsLoadInFlight = (async () => {
      const isInitialLoad = this.projects.length === 0;
      if (isInitialLoad) this.loading = true;
      try {
        const response = await connection.send({ type: 'list_projects' });
        if (response.success && response.data) {
          const data = response.data as ListProjectsResponseData;
          this.projects = data.projects;
          this.roots = data.roots ?? [];
          // Repo listing feeds branch chips and missing-detection; refresh it
          // with the projects so they never disagree.
          void this.loadRepos();
          await Promise.all(data.projects.map((project) => this.loadSessions(project.path)));
        }
      } catch (e) {
        console.error('[ProjectStore] Failed to load projects:', e);
      } finally {
        if (isInitialLoad) this.loading = false;
      }
    })().finally(() => {
      this.projectsLoadInFlight = null;
    });

    return this.projectsLoadInFlight;
  }

  /** Single-flight: branch chips and missing-detection read this listing. */
  loadRepos(): Promise<void> {
    this.reposLoadInFlight ??= (async () => {
      try {
        const response = await connection.send({ type: 'list_repos' });
        if (response.success && response.data) {
          this.repos = (response.data as ListReposResponseData).repos;
        }
      } catch (e) {
        console.error('[ProjectStore] Failed to load repos:', e);
      } finally {
        this.reposLoadInFlight = null;
      }
    })();
    return this.reposLoadInFlight;
  }

  /** Whole-list replacement driven by the server's projects_changed broadcast. */
  applyProjectsChanged(event: ProjectsChangedEvent): void {
    this.projects = event.projects;
  }

  applySessionStateChange(event: SessionStateChangedEvent, myClientId: string): void {
    const project = this.projects.find((p) => p.path === event.folderPath);
    if (project) {
      project.activeSessionCount = event.folderActiveSessionCount;
    }

    const isOwnedByMe = event.connectedClientId === myClientId;
    const projectSessions = this.sessions.get(event.folderPath);
    if (projectSessions) {
      const idx = projectSessions.findIndex((s) => s.id === event.sessionId);
      if (idx >= 0) {
        // Update in place — merge event metadata with existing entry
        this.sessions.set(
          event.folderPath,
          projectSessions.map((s, i) =>
            i === idx
              ? {
                  ...s,
                  liveStatus: event.liveStatus,
                  isOwnedByMe,
                  name: event.sessionName ?? s.name,
                  firstMessage: event.firstMessage ?? s.firstMessage,
                  messageCount: event.messageCount ?? s.messageCount,
                }
              : s,
          ),
        );
      } else if (event.liveStatus !== null) {
        // New active session — add directly from event data
        const now = nowIso();
        const updated = [
          ...projectSessions,
          {
            id: event.sessionId,
            name: event.sessionName ?? '',
            firstMessage: event.firstMessage,
            messageCount: event.messageCount ?? 0,
            created: now,
            modified: now,
            archived: false,
            isOwnedByMe,
            liveStatus: event.liveStatus,
          },
        ];
        this.sessions.set(event.folderPath, sortSessionsByRecency(updated));
      }
    } else if (event.liveStatus !== null) {
      // Sessions for this project not loaded yet — seed with this entry
      const now = nowIso();
      this.sessions.set(event.folderPath, [
        {
          id: event.sessionId,
          name: event.sessionName ?? '',
          firstMessage: event.firstMessage,
          messageCount: event.messageCount ?? 0,
          created: now,
          modified: now,
          archived: false,
          isOwnedByMe,
          liveStatus: event.liveStatus,
        },
      ]);
    }
  }

  applySessionDeleted(event: SessionDeletedEvent): void {
    const projectSessions = this.sessions.get(event.folderPath);
    if (projectSessions) {
      const filtered = projectSessions.filter((s) => s.id !== event.sessionId);
      this.sessions.set(event.folderPath, filtered);
    }
  }

  applySessionRenamed(event: SessionRenamedEvent): void {
    const projectSessions = this.sessions.get(event.folderPath);
    if (!projectSessions) return;
    this.sessions.set(
      event.folderPath,
      projectSessions.map((s) => (s.id === event.sessionId ? { ...s, name: event.name } : s)),
    );
  }

  applySessionArchived(event: SessionArchivedEvent): void {
    if (this.sessions.has(event.folderPath)) {
      void this.loadSessions(event.folderPath);
    }
  }

  setShowArchived(show: boolean): void {
    this.showArchived = show;
    setShowArchived(show);
    void Promise.all(this.projects.map((project) => this.loadSessions(project.path)));
  }

  async loadSessions(folderPath: string): Promise<void> {
    const existing = this.sessionLoadsInFlight.get(folderPath);
    if (existing && existing.includeArchived === this.showArchived) {
      return existing.promise;
    }

    const includeArchived = this.showArchived;
    const requestId = ++this.nextSessionRequestId;

    const promise = (async () => {
      try {
        const response = await connection.send({ type: 'list_sessions', folderPath, includeArchived });
        if (this.sessionLoadsInFlight.get(folderPath)?.requestId !== requestId) return;

        if (response.success && response.data) {
          const data = response.data as { sessions: SessionInfo[] };
          this.sessions.set(folderPath, sortSessionsByRecency(data.sessions));
        }
      } catch (e) {
        console.error('[ProjectStore] Failed to load sessions:', e);
      } finally {
        if (this.sessionLoadsInFlight.get(folderPath)?.requestId === requestId) {
          this.sessionLoadsInFlight.delete(folderPath);
        }
      }
    })();

    this.sessionLoadsInFlight.set(folderPath, { includeArchived, requestId, promise });
    return promise;
  }
}

export const projectStore = new ProjectStore();

// Route server-side project mutations into the store for the lifetime of the app.
connection.onEvent((event: PimoteEvent) => {
  if (event.type === 'projects_changed') {
    projectStore.applyProjectsChanged(event);
  }
});
