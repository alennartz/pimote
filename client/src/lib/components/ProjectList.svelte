<script lang="ts">
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import type { ProjectInfo, SessionInfo } from '@pimote/shared';
  import { projectStore } from '$lib/stores/project-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { AGENT_INSTRUCTIONS_PATH, fileEditorStore } from '$lib/stores/file-editor.svelte.js';
  import SessionItem from './SessionItem.svelte';
  import ConfigFileEditor from './ConfigFileEditor.svelte';
  import Archive from '@lucide/svelte/icons/archive';
  import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
  import FilePen from '@lucide/svelte/icons/file-pen';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import Loader2 from '@lucide/svelte/icons/loader-2';
  import Network from '@lucide/svelte/icons/network';
  import Plus from '@lucide/svelte/icons/plus';
  import Star from '@lucide/svelte/icons/star';
  import Tag from '@lucide/svelte/icons/tag';
  import X from '@lucide/svelte/icons/x';
  import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '$lib/components/ui/context-menu/index.js';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuTrigger } from '$lib/components/ui/dropdown-menu/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  interface Props {
    /** Homepage search query — owned by the combined toolbar box at the top. */
    search?: string;
    onSessionSelect?: () => void;
  }

  let { search = '', onSessionSelect }: Props = $props();

  let openError = $state('');
  // Three-state project expander: 'closed' (nothing), 'active' (half-open —
  // sessions open on this client plus sessions open but bound to another
  // client), 'all' (every session).
  // 'active' is the default. An active search overrides all of this so
  // session-level matches stay visible.
  type ExpandState = 'closed' | 'active' | 'all';
  let expandStates = new SvelteMap<string, ExpandState>();
  let expandedSessionLists = new SvelteSet<string>();

  // Project row context menu (long-press on touch, right-click on desktop).
  // A long-press opens the menu while the finger is still down, so the release
  // would fire a click that toggles the row behind the menu — swallow it.
  let rowMenuPath = $state<string | null>(null);
  let suppressRowClick = false;
  let rowsEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const el = rowsEl;
    if (!el) return;
    const swallow = (e: MouseEvent) => {
      if (!suppressRowClick) return;
      suppressRowClick = false;
      e.stopPropagation();
      e.preventDefault();
    };
    el.addEventListener('click', swallow, true);
    return () => el.removeEventListener('click', swallow, true);
  });

  function setRowMenu(path: string, open: boolean) {
    if (open) {
      rowMenuPath = path;
      suppressRowClick = true;
    } else if (rowMenuPath === path) {
      rowMenuPath = null;
      suppressRowClick = false;
    }
  }

  const MAX_SESSIONS_SHOWN = 6;

  /** Session ids open on this client — the local half of the half-open filter. */
  const activeSessionIds = $derived(new SvelteSet(sessionRegistry.activeSessions.map((s) => s.sessionId)));

  /** Half-open filter: a session is listed when it's open — held by this
   *  client (registry) or live in the server's memory. A live session bound
   *  to another client is open too, and the row's live badge counts it, so
   *  hiding it under the expander would contradict the header. */
  function isOpenSession(session: SessionInfo): boolean {
    return activeSessionIds.has(session.id) || session.liveStatus != null;
  }

  let showArchiveAllDialog = $state(false);

  // Create project project flow state
  let showMultiRepoDialog = $state(false);
  let multiRepoName = $state('');
  let multiRepoRoot = $state('');
  let multiRepoMembers = new SvelteSet<string>();
  let multiRepoError = $state('');
  let multiRepoCreating = $state(false);

  // Disband confirmation state
  let disbandTarget = $state<ProjectInfo | null>(null);

  // Add-tag dialog state
  let tagTarget = $state<ProjectInfo | null>(null);
  let tagName = $state('');
  let tagError = $state('');

  function openTagDialog(project: ProjectInfo) {
    tagTarget = project;
    tagName = '';
    tagError = '';
  }

  async function addTag() {
    const tag = tagName.trim();
    if (!tag || !tagTarget) return;
    const project = tagTarget;
    tagTarget = null;
    await updateProject(project, { addTags: [tag] });
  }

  // Two-tier search: a project matching by name/path shows all its sessions;
  // one matching only via session data shows just the matching sessions.
  const searchResults = $derived.by(() => {
    const query = search.trim().toLowerCase();
    if (!query) return null;
    const projects: ProjectInfo[] = [];
    // Non-reactive derived output — recomputed wholesale on every query change.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const sessionView = new Map<string, SessionInfo[]>();
    for (const project of projectStore.visibleProjects) {
      const sessions = projectStore.sessions.get(project.path) ?? [];
      const tagMatch = (project.tags ?? []).some((t) => t.toLowerCase().includes(query));
      const projectMatch = tagMatch || project.name.toLowerCase().includes(query) || project.path.toLowerCase().includes(query);
      const sessionMatches = sessions.filter((s) => (s.name ?? '').toLowerCase().includes(query) || (s.firstMessage ?? '').toLowerCase().includes(query));
      if (projectMatch) {
        projects.push(project);
        sessionView.set(project.path, sessions);
      } else if (sessionMatches.length > 0) {
        projects.push(project);
        sessionView.set(project.path, sessionMatches);
      }
    }
    return { projects, sessionView };
  });

  const displayProjects = $derived(searchResults ? searchResults.projects : projectStore.visibleProjects);

  function sessionsFor(project: ProjectInfo): SessionInfo[] {
    return searchResults?.sessionView.get(project.path) ?? projectStore.sessions.get(project.path) ?? [];
  }
  const archivableCount = $derived(
    projectStore.projects.reduce((total, project) => {
      const sessions = projectStore.sessions.get(project.path) ?? [];
      return total + sessions.filter((s) => !s.archived && !s.liveStatus).length;
    }, 0),
  );
  const multiRepoCandidateRepos = $derived(projectStore.repos.filter((repo) => !repo.missing));

  // Session/project events are routed into the store at module scope
  // (project-store.svelte.ts) for the app's lifetime, not per-mount.

  function toggleProject(path: string) {
    // Cycle closed → active → all → closed… From closed, skip half-open when
    // nothing is open: half-open would render identical to closed, so the tap
    // would look dead.
    const current = expandStates.get(path) ?? 'active';
    if (current === 'active') {
      expandStates.set(path, 'all');
    } else if (current === 'all') {
      expandStates.set(path, 'closed');
    } else {
      const anyOpen = (projectStore.sessions.get(path) ?? []).some(isOpenSession);
      expandStates.set(path, anyOpen ? 'active' : 'all');
    }
  }

  function handleRowClick(project: ProjectInfo) {
    if (isMissingProject(project)) {
      void attemptOpen(project.path);
      return;
    }
    toggleProject(project.path);
  }

  /** Row 2 (git status + tags) renders only when there's something to show. */
  function hasRepoInfo(project: ProjectInfo): boolean {
    if (project.kind === 'multi') return (project.repos?.length ?? 0) > 0;
    const repo = projectStore.repos.find((r) => r.path === project.path);
    return !!repo && !repo.missing && !!repo.branch;
  }

  function toggleSessionList(path: string) {
    if (expandedSessionLists.has(path)) {
      expandedSessionLists.delete(path);
    } else {
      expandedSessionLists.add(path);
    }
  }

  function validateProjectName(name: string): string | null {
    if (!name.trim()) return 'Name is required';
    if (name.includes('/') || name.includes('\\')) return 'Name cannot contain path separators';
    if (name === '.' || name === '..') return 'Invalid name';
    return null;
  }

  /** True when a project's folder doesn't exist on disk yet — opening it gives
   *  its source's onProjectOpen hook the chance to materialize it. */
  function isMissingProject(project: ProjectInfo): boolean {
    if (project.kind === 'single') {
      return projectStore.repos.find((r) => r.path === project.path)?.missing === true;
    }
    const repos = project.repos ?? [];
    return repos.length > 0 && repos.every((r) => r.missing);
  }

  /** Open attempt against a (possibly virtual) project: the server awaits the
   *  source's onProjectOpen hooks before opening the session. */
  async function attemptOpen(folderPath: string) {
    openError = '';
    try {
      const response = await connection.send({ type: 'open_session', folderPath });
      if (!response.success) openError = response.error ?? 'Failed to open project';
    } catch (e) {
      openError = e instanceof Error ? e.message : 'Failed to open project';
    }
  }

  async function newSession(folderPath: string) {
    try {
      onSessionSelect?.();
      await connection.send({
        type: 'open_session',
        folderPath,
      });
    } catch (e) {
      console.error('Failed to create new session:', e);
    }
  }

  async function archiveAll() {
    showArchiveAllDialog = false;
    try {
      await Promise.all(
        projectStore.projects.map((project) => {
          const sessions = projectStore.sessions.get(project.path) ?? [];
          const ids = sessions.filter((s) => !s.archived && !s.liveStatus).map((s) => s.id);
          if (ids.length === 0) return;
          return connection.send({
            type: 'archive_session',
            folderPath: project.path,
            sessionIds: ids,
            archived: true,
          });
        }),
      );
    } catch (e) {
      console.error('Failed to archive sessions:', e);
    }
  }

  /** Apply a curation patch; the store updates via the projects_changed broadcast. */
  async function updateProject(project: ProjectInfo, patch: { favorite?: boolean; archived?: boolean; addTags?: string[]; removeTags?: string[] }) {
    try {
      await connection.send({ type: 'update_project', projectPath: project.path, ...patch });
    } catch (e) {
      console.error('Failed to update project:', e);
    }
  }

  async function disbandProject() {
    const target = disbandTarget;
    disbandTarget = null;
    if (!target) return;
    try {
      await connection.send({ type: 'disband_project', projectPath: target.path });
    } catch (e) {
      console.error('Failed to disband project:', e);
    }
  }

  function openMultiRepoDialog() {
    multiRepoName = '';
    multiRepoRoot = '';
    multiRepoError = '';
    multiRepoCreating = false;
    multiRepoMembers.clear();
    showMultiRepoDialog = true;
    void projectStore.loadRepos();
  }

  function handleMultiRepoDialogOpenChange(open: boolean) {
    showMultiRepoDialog = open;
    if (!open) {
      multiRepoName = '';
      multiRepoRoot = '';
      multiRepoError = '';
      multiRepoCreating = false;
      multiRepoMembers.clear();
    }
  }

  function toggleMultiRepoMember(path: string) {
    if (multiRepoMembers.has(path)) {
      multiRepoMembers.delete(path);
    } else {
      multiRepoMembers.add(path);
    }
  }

  async function createMultiRepoProject() {
    const name = multiRepoName.trim();
    const validationError =
      validateProjectName(name) ?? (!multiRepoRoot ? 'Choose a root folder' : null) ?? (multiRepoMembers.size === 0 ? 'Select at least one member repository' : null);
    if (validationError) {
      multiRepoError = validationError;
      return;
    }

    multiRepoCreating = true;
    multiRepoError = '';

    try {
      const response = await connection.send({
        type: 'create_multi_repo_project',
        name,
        root: multiRepoRoot,
        repoPaths: [...multiRepoMembers],
      });

      if (!response.success) {
        multiRepoError = response.error ?? 'Failed to create multi-repo project';
        multiRepoCreating = false;
        return;
      }

      handleMultiRepoDialogOpenChange(false);
    } catch (e) {
      multiRepoError = e instanceof Error ? e.message : 'Failed to create multi-repo project';
      multiRepoCreating = false;
    }
  }
</script>

<div class="flex flex-col gap-2 p-2 max-md:p-0">
  <!-- Section header + list actions. The former dashboard-side header lives here
       so the count and the ⋯ menu share one row. -->
  <div class="text-muted-foreground mb-1 -ml-2 flex items-center gap-2 max-md:ml-0">
    <h2 class="text-foreground text-xs font-semibold tracking-widest uppercase">Projects</h2>
    {#if projectStore.projects.length > 0}
      <span class="text-xs">{projectStore.projects.length}</span>
    {/if}
    <div class="ml-auto flex items-center gap-2">
      <Button
        variant="outline"
        size="icon-sm"
        class="text-muted-foreground shrink-0 max-md:size-11"
        title="Agent instructions"
        aria-label="Agent instructions"
        onclick={() => void fileEditorStore.openFile(AGENT_INSTRUCTIONS_PATH, 'Agent instructions')}
      >
        <FilePen class="size-4 max-md:size-5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger>
          <Button variant="outline" size="icon-sm" class="text-muted-foreground shrink-0 max-md:size-11" title="More project actions">
            <EllipsisVertical class="size-4 max-md:size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent class="w-52" align="end">
            <DropdownMenuItem class="gap-2" disabled={connection.status !== 'connected' || projectStore.roots.length === 0} onSelect={() => openMultiRepoDialog()}>
              <Network class="size-4" />
              Create multi-repo project…
            </DropdownMenuItem>
            <DropdownMenuItem class="gap-2" disabled={connection.status !== 'connected' || archivableCount === 0} onSelect={() => (showArchiveAllDialog = true)}>
              <Archive class="size-4" />
              Archive all inactive…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem class="gap-2" onSelect={() => projectStore.setShowArchived(!projectStore.showArchived)}>
              {#if projectStore.showArchived}
                <Undo2 class="size-4" />
                Hide archived
              {:else}
                <Archive class="size-4" />
                Show archived
              {/if}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    </div>
  </div>
  {#if projectStore.loading}
    <div class="text-muted-foreground flex items-center justify-center py-8">
      <Loader2 class="size-5 animate-spin" />
      <span class="ml-2 text-sm">Loading projects…</span>
    </div>
  {:else if projectStore.projects.length === 0}
    <div class="text-muted-foreground px-3 py-8 text-center text-sm">
      {#if connection.status !== 'connected'}
        Connecting to server…
      {:else}
        No projects configured
      {/if}
    </div>
  {:else}
    {#if openError}
      <p class="text-destructive px-1 text-xs">{openError}</p>
    {/if}

    {#if displayProjects.length === 0}
      <div class="text-muted-foreground px-3 py-8 text-center text-sm">
        {#if projectStore.showArchived}
          No projects.
        {:else}
          No projects yet. Archived projects are hidden.
        {/if}
      </div>
    {:else}
      <div class="flex flex-col gap-1" bind:this={rowsEl}>
        {#each displayProjects as project (project.path)}
          {@const expandState = searchResults !== null ? 'all' : (expandStates.get(project.path) ?? 'active')}
          {@const hasTags = (project.tags?.length ?? 0) > 0}
          {@const showAll = expandedSessionLists.has(project.path)}
          {@const projectSessions = sessionsFor(project)}
          {@const listedSessions = expandState === 'all' ? projectSessions : expandState === 'active' ? projectSessions.filter(isOpenSession) : []}
          {@const visibleSessions = showAll ? listedSessions : listedSessions.slice(0, MAX_SESSIONS_SHOWN)}
          {@const hiddenCount = Math.max(0, listedSessions.length - MAX_SESSIONS_SHOWN)}
          <!-- Half-open with nothing open renders no session block, so the row keeps
               its closed shape (bottom-rounded) instead of a dangling open corner. -->
          {@const showSessionBlock = expandState === 'all' || listedSessions.length > 0}

          <div class="border-border/60 rounded-lg">
            <ContextMenu open={rowMenuPath === project.path} onOpenChange={(open) => setRowMenu(project.path, open)}>
              <!-- Whole-row expander: taps land here unless a control stops them.
                   Every control inside the trigger calls stopPropagation(). -->
              <ContextMenuTrigger
                class="group hover:bg-accent active:bg-accent/80 flex cursor-pointer flex-col transition-colors select-none {showSessionBlock ? 'rounded-t-lg' : 'rounded-lg'}"
                onclick={() => handleRowClick(project)}
              >
                <div class="flex items-center gap-0.5">
                  <button
                    class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors max-md:min-h-12 max-md:gap-2 max-md:rounded-lg max-md:px-2 max-md:py-2"
                    title={isMissingProject(project) ? 'Open — its source will create this folder' : undefined}
                    aria-expanded={expandState !== 'closed'}
                  >
                    <span class="text-foreground truncate text-[13px] font-medium max-md:text-base {project.archived ? 'opacity-70' : ''}" data-project-name={project.path}
                      >{project.name}</span
                    >
                    {#if project.archived}
                      <span class="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-[10px] font-medium tracking-wide uppercase">Archived</span>
                    {/if}
                  </button>
                  <div class="ml-auto flex shrink-0 items-center gap-0.5">
                    <button
                      class="group/star flex shrink-0 items-center rounded p-1 transition-colors max-md:-m-1 max-md:p-2"
                      title={project.favorite ? 'Unfavorite' : 'Favorite'}
                      aria-label={project.favorite ? `Unfavorite ${project.name}` : `Favorite ${project.name}`}
                      onclick={(e) => {
                        e.stopPropagation();
                        void updateProject(project, { favorite: !project.favorite });
                      }}
                    >
                      <Star
                        class="size-3 transition-colors max-md:size-4 {project.favorite
                          ? 'fill-yellow-500 text-yellow-500'
                          : 'text-muted-foreground/40 group-hover/star:text-muted-foreground'}"
                      />
                    </button>
                    {#if project.activeSessionCount > 0}
                      <span
                        class="flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-px text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400"
                        title={`${project.activeSessionCount} open session${project.activeSessionCount !== 1 ? 's' : ''}`}
                      >
                        <span class="bg-status-connected size-1.5 rounded-full"></span>
                        {project.activeSessionCount}
                      </span>
                    {/if}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground hover:text-sidebar-foreground shrink-0 max-md:size-11"
                      title="New session in {project.name}"
                      disabled={connection.status !== 'connected'}
                      onclick={(e) => {
                        e.stopPropagation();
                        void newSession(project.path);
                      }}
                    >
                      <Plus class="size-4 max-md:size-5" />
                    </Button>
                  </div>
                </div>
                {#if hasRepoInfo(project) || hasTags}
                  <div class="chips flex flex-wrap items-center gap-1 pb-1 pl-1.5">
                    {#if project.kind === 'multi' && project.repos?.length}
                      {#each project.repos as repo (repo.path)}
                        <span
                          class="bg-muted text-muted-foreground flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] {repo.missing
                            ? 'border border-yellow-500/20 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                            : ''}"
                          title={repo.missing ? `${repo.name} is missing on disk` : repo.path}
                        >
                          {#if !repo.missing}
                            <span class="size-1.5 rounded-full {repo.dirty ? 'bg-yellow-500' : 'bg-muted-foreground/40'}" title={repo.dirty ? 'Uncommitted changes' : 'Clean'}
                            ></span>
                          {/if}
                          <span class="max-w-28 truncate">{repo.name}</span>
                          {#if repo.missing}
                            <span class="font-medium">missing</span>
                          {:else if repo.branch}
                            <span class="max-w-20 truncate opacity-70">{repo.branch}</span>
                          {/if}
                        </span>
                      {/each}
                    {:else}
                      {@const repo = projectStore.repos.find((r) => r.path === project.path)}
                      {#if repo && !repo.missing && repo.branch}
                        <span class="bg-muted text-muted-foreground flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px]" title={repo.path}>
                          <span class="size-1.5 rounded-full {repo.dirty ? 'bg-yellow-500' : 'bg-muted-foreground/40'}" title={repo.dirty ? 'Uncommitted changes' : 'Clean'}></span>
                          <span class="max-w-24 truncate">{repo.branch}</span>
                          {#if repo.ahead || repo.behind}
                            <span class="opacity-70">↑{repo.ahead}↓{repo.behind}</span>
                          {/if}
                        </span>
                      {/if}
                    {/if}
                    {#each project.tags ?? [] as tag (tag)}
                      {@const removable = project.userTags?.includes(tag) === true}
                      <span
                        class="flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[10.5px] leading-none {removable
                          ? 'border-border bg-secondary text-secondary-foreground'
                          : 'border-border/60 bg-muted/60 text-muted-foreground'}"
                        title={removable ? `Tag: ${tag}` : `Tag from a project source: ${tag}`}
                      >
                        {tag}
                        {#if removable}
                          <button
                            class="hover:text-destructive -mr-0.5 rounded-full p-px transition-colors"
                            aria-label="Remove tag {tag}"
                            onclick={(e) => {
                              e.stopPropagation();
                              void updateProject(project, { removeTags: [tag] });
                            }}
                          >
                            <X class="size-2.5" />
                          </button>
                        {/if}
                      </span>
                    {/each}
                    <button
                      class="border-border/60 text-muted-foreground hover:text-foreground hover:border-border hidden items-center gap-0.5 rounded-full border border-dashed px-1.5 py-px text-[10.5px] leading-none transition-colors group-hover:flex"
                      title="Add tag"
                      aria-label="Add tag to {project.name}"
                      onclick={(e) => {
                        e.stopPropagation();
                        openTagDialog(project);
                      }}
                    >
                      <Plus class="size-2.5" />
                      tag
                    </button>
                  </div>
                {/if}
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => openTagDialog(project)}>
                  <Tag class="size-4" />
                  Add tag…
                </ContextMenuItem>
                {#if project.kind === 'multi'}
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => (disbandTarget = project)}>
                    <Trash2 class="size-4" />
                    Disband project
                  </ContextMenuItem>
                {/if}
              </ContextMenuContent>
            </ContextMenu>

            {#if showSessionBlock}
              <div class="border-sidebar-border ml-4 flex flex-col gap-0.5 border-l pt-1 pl-2">
                {#each visibleSessions as session (session.id)}
                  <SessionItem {session} folderPath={project.path} {onSessionSelect} />
                {/each}

                {#if projectSessions.length === 0}
                  <div class="text-muted-foreground px-3 py-1 text-xs">No sessions yet</div>
                {/if}

                {#if hiddenCount > 0 && !showAll}
                  <button
                    class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md px-3 py-1.5 text-xs transition-colors max-md:min-h-11 max-md:text-[13px]"
                    onclick={() => toggleSessionList(project.path)}
                  >
                    Show {hiddenCount} more session{hiddenCount !== 1 ? 's' : ''}
                  </button>
                {:else if showAll && hiddenCount > 0}
                  <button
                    class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md px-3 py-1.5 text-xs transition-colors max-md:min-h-11 max-md:text-[13px]"
                    onclick={() => toggleSessionList(project.path)}
                  >
                    Show fewer sessions
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<Dialog.Root
  open={tagTarget !== null}
  onOpenChange={(open) => {
    if (!open) tagTarget = null;
  }}
>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Add tag</Dialog.Title>
      <Dialog.Description>Tag the project <code class="bg-muted rounded px-1 py-0.5 text-xs">{tagTarget?.name}</code></Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-1.5">
      <Input
        bind:value={tagName}
        placeholder="Tag name"
        autofocus
        onkeydown={(e) => {
          if (e.key === 'Enter') void addTag();
        }}
      />
      {#if tagError}
        <p class="text-destructive text-sm">{tagError}</p>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (tagTarget = null)}>Cancel</Button>
      <Button onclick={() => void addTag()} disabled={!tagName.trim()}>Add tag</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={showArchiveAllDialog}>
  <Dialog.Content showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>Archive all inactive sessions</Dialog.Title>
      <Dialog.Description>
        This will archive {archivableCount} inactive session{archivableCount !== 1 ? 's' : ''} across all projects. Active sessions will not be affected.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (showArchiveAllDialog = false)}>Cancel</Button>
      <Button onclick={archiveAll}>Archive {archivableCount} session{archivableCount !== 1 ? 's' : ''}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={showMultiRepoDialog} onOpenChange={handleMultiRepoDialogOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Create multi-repo project</Dialog.Title>
      <Dialog.Description>Creates a multi-repo project folder with symlinks to each member repository and an AGENTS.md naming the members.</Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-4">
      <Input
        bind:value={multiRepoName}
        placeholder="Project name"
        disabled={multiRepoCreating}
        onkeydown={(e) => {
          if (e.key === 'Enter') void createMultiRepoProject();
        }}
      />

      <div class="flex flex-col gap-1.5">
        <div class="text-muted-foreground text-xs font-medium">Root folder</div>
        {#if projectStore.roots.length === 0}
          <div class="text-muted-foreground px-3 py-2 text-sm">No roots configured.</div>
        {:else}
          <div class="border-border max-h-36 overflow-y-auto rounded-md border">
            <div class="flex flex-col p-1">
              {#each projectStore.roots as root (root)}
                <button
                  class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors {multiRepoRoot === root
                    ? 'bg-accent text-accent-foreground'
                    : ''}"
                  disabled={multiRepoCreating}
                  onclick={() => (multiRepoRoot = root)}
                >
                  <FolderIcon class="text-muted-foreground size-4 shrink-0" />
                  <span class="min-w-0 flex-1 truncate">{root}</span>
                  {#if multiRepoRoot === root}
                    <span class="text-primary size-2 shrink-0 rounded-full"></span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <div class="flex flex-col gap-1.5">
        <div class="text-muted-foreground text-xs font-medium">Member repositories</div>
        {#if multiRepoCandidateRepos.length === 0}
          <div class="text-muted-foreground px-3 py-2 text-sm">
            {#if projectStore.repos.length === 0}
              No repositories discovered yet.
            {:else}
              No available repositories — all discovered repos are missing on disk.
            {/if}
          </div>
        {:else}
          <div class="border-border max-h-60 overflow-y-auto rounded-md border">
            <div class="flex flex-col p-1">
              {#each multiRepoCandidateRepos as repo (repo.path)}
                {@const selected = multiRepoMembers.has(repo.path)}
                <button
                  class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-left transition-colors {selected
                    ? 'bg-accent text-accent-foreground'
                    : ''}"
                  disabled={multiRepoCreating}
                  onclick={() => toggleMultiRepoMember(repo.path)}
                >
                  <input type="checkbox" checked={selected} class="pointer-events-none" tabindex={-1} />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium">{repo.name}</div>
                    <div class="text-muted-foreground truncate text-xs">{repo.path}</div>
                  </div>
                  {#if repo.branch}
                    <span class="text-muted-foreground shrink-0 text-xs">{repo.branch}</span>
                  {/if}
                  <span class="size-1.5 shrink-0 rounded-full {repo.dirty ? 'bg-yellow-500' : 'bg-muted-foreground/40'}" title={repo.dirty ? 'Uncommitted changes' : 'Clean'}
                  ></span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      {#if multiRepoError}
        <p class="text-destructive text-sm">{multiRepoError}</p>
      {/if}

      <Dialog.Footer>
        <Button variant="outline" onclick={() => handleMultiRepoDialogOpenChange(false)} disabled={multiRepoCreating}>Cancel</Button>
        <Button onclick={() => void createMultiRepoProject()} disabled={multiRepoCreating || !multiRepoName.trim() || !multiRepoRoot || multiRepoMembers.size === 0}>
          {#if multiRepoCreating}
            <Loader2 class="size-4 animate-spin" />
            Creating…
          {:else}
            Create project
          {/if}
        </Button>
      </Dialog.Footer>
    </div>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={disbandTarget !== null}
  onOpenChange={(open) => {
    if (!open) disbandTarget = null;
  }}
>
  <Dialog.Content showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>Disband {disbandTarget?.name}</Dialog.Title>
      <Dialog.Description>This deletes the multi-repo project folder and removes the project from the list. Member repositories are not touched.</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (disbandTarget = null)}>Cancel</Button>
      <Button variant="destructive" onclick={disbandProject}>Disband</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<ConfigFileEditor />
