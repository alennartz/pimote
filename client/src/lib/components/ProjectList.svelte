<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { ProjectInfo, SessionInfo } from '@pimote/shared';
  import { projectStore } from '$lib/stores/project-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import SessionItem from './SessionItem.svelte';
  import Archive from '@lucide/svelte/icons/archive';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import Loader2 from '@lucide/svelte/icons/loader-2';
  import Network from '@lucide/svelte/icons/network';
  import Plus from '@lucide/svelte/icons/plus';
  import Star from '@lucide/svelte/icons/star';
  import Tags from '@lucide/svelte/icons/tags';
  import X from '@lucide/svelte/icons/x';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuTrigger } from '$lib/components/ui/dropdown-menu/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  interface Props {
    onSessionSelect?: () => void;
  }

  let { onSessionSelect }: Props = $props();

  let openError = $state('');
  let collapsedProjects = new SvelteSet<string>();
  let expandedSessionLists = new SvelteSet<string>();

  const MAX_SESSIONS_SHOWN = 6;

  let showNewSessionDialog = $state(false);
  let showArchiveAllDialog = $state(false);
  let projectSearch = $state('');

  // Create project flow state
  type DialogMode = 'pick' | 'create-root' | 'create-name';
  let dialogMode: DialogMode = $state('pick');
  let createRoot: string = $state('');
  let createName: string = $state('');
  let createError: string = $state('');
  let creating: boolean = $state(false);

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
    const query = projectSearch.trim().toLowerCase();
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
  const pickerProjects = $derived(
    [...projectStore.projects]
      .filter((folder) => {
        const query = projectSearch.trim().toLowerCase();
        if (!query) return true;
        return folder.name.toLowerCase().includes(query) || folder.path.toLowerCase().includes(query);
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
  );
  const multiRepoCandidateRepos = $derived(projectStore.repos.filter((repo) => !repo.missing));

  function projectIndex(path: string): number {
    return projectStore.projects.findIndex((p) => p.path === path);
  }

  onMount(() => {
    const unsub = connection.onEvent((event) => {
      if (event.type === 'session_state_changed') {
        projectStore.applySessionStateChange(event, connection.clientId);
      } else if (event.type === 'session_deleted') {
        projectStore.applySessionDeleted(event);
      } else if (event.type === 'session_renamed') {
        projectStore.applySessionRenamed(event);
      } else if (event.type === 'session_archived') {
        projectStore.applySessionArchived(event);
      }
    });

    return unsub;
  });

  function toggleProject(path: string) {
    if (collapsedProjects.has(path)) {
      collapsedProjects.delete(path);
    } else {
      collapsedProjects.add(path);
    }
  }

  function toggleSessionList(path: string) {
    if (expandedSessionLists.has(path)) {
      expandedSessionLists.delete(path);
    } else {
      expandedSessionLists.add(path);
    }
  }

  function openNewSessionDialog() {
    projectSearch = '';
    dialogMode = 'pick';
    createRoot = '';
    createName = '';
    createError = '';
    creating = false;
    showNewSessionDialog = true;
  }

  function handleNewSessionDialogOpenChange(open: boolean) {
    showNewSessionDialog = open;
    if (!open) {
      projectSearch = '';
      dialogMode = 'pick';
      createRoot = '';
      createName = '';
      createError = '';
      creating = false;
    }
  }

  function startCreateProject() {
    const roots = projectStore.roots;
    if (roots.length === 1) {
      createRoot = roots[0];
      dialogMode = 'create-name';
    } else {
      dialogMode = 'create-root';
    }
    createName = '';
    createError = '';
  }

  function selectRoot(root: string) {
    createRoot = root;
    dialogMode = 'create-name';
    createName = '';
    createError = '';
  }

  function backToPickMode() {
    dialogMode = 'pick';
    createRoot = '';
    createName = '';
    createError = '';
  }

  function backToRootSelection() {
    dialogMode = 'create-root';
    createName = '';
    createError = '';
  }

  function validateProjectName(name: string): string | null {
    if (!name.trim()) return 'Name is required';
    if (name.includes('/') || name.includes('\\')) return 'Name cannot contain path separators';
    if (name === '.' || name === '..') return 'Invalid name';
    return null;
  }

  async function createProject() {
    const name = createName.trim();
    const validationError = validateProjectName(name);
    if (validationError) {
      createError = validationError;
      return;
    }

    creating = true;
    createError = '';

    try {
      const response = await connection.send({
        type: 'create_project',
        root: createRoot,
        name,
      });

      if (!response.success) {
        createError = response.error ?? 'Failed to create project';
        creating = false;
        return;
      }

      const folderPath = (response.data as { folderPath: string }).folderPath;
      // Refresh project list so the new project appears
      void projectStore.loadProjects();
      await connection.send({ type: 'open_session', folderPath });
      showNewSessionDialog = false;
      onSessionSelect?.();
    } catch (e) {
      createError = e instanceof Error ? e.message : 'Failed to create project';
      creating = false;
    }
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
      showNewSessionDialog = false;
      projectSearch = '';
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
  async function updateProject(project: ProjectInfo, patch: { favorite?: boolean; order?: number; archived?: boolean; addTags?: string[]; removeTags?: string[] }) {
    try {
      await connection.send({ type: 'update_project', projectPath: project.path, ...patch });
    } catch (e) {
      console.error('Failed to update project:', e);
    }
  }

  /** Move a project within the list by renumbering explicit orders to match the new arrangement. */
  function moveProject(project: ProjectInfo, delta: -1 | 1) {
    const list = [...projectStore.projects];
    const from = list.findIndex((p) => p.path === project.path);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return;

    const reordered = [...list];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);

    for (let i = 0; i < reordered.length; i++) {
      if (reordered[i].order !== i) void updateProject(reordered[i], { order: i });
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

<div class="flex flex-col gap-2 p-2">
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
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-1.5">
        <div
          class="border-border bg-secondary/50 focus-within:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors focus-within:ring-1 focus-within:outline-none"
        >
          <span class="text-muted-foreground text-xs">🔎</span>
          <input
            bind:value={projectSearch}
            placeholder="Search projects"
            aria-label="Search projects"
            class="text-foreground placeholder:text-muted-foreground w-full min-w-0 bg-transparent text-xs outline-none"
          />
        </div>
        <Button size="sm" class="shrink-0" onclick={openNewSessionDialog} disabled={connection.status !== 'connected'}>
          <Plus class="size-3.5" />
          New session
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button variant="outline" size="icon-sm" class="text-muted-foreground shrink-0" title="More project actions">
              <EllipsisVertical class="size-4" />
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
      <div class="flex flex-col gap-1">
        {#each displayProjects as project (project.path)}
          {@const expanded = !collapsedProjects.has(project.path)}
          {@const showAll = expandedSessionLists.has(project.path)}
          {@const projectSessions = sessionsFor(project)}
          {@const visibleSessions = showAll ? projectSessions : projectSessions.slice(0, MAX_SESSIONS_SHOWN)}
          {@const hiddenCount = Math.max(0, projectSessions.length - MAX_SESSIONS_SHOWN)}
          {@const idx = projectIndex(project.path)}

          <div class="border-border/60 rounded-lg">
            <div class="flex flex-wrap items-center gap-0.5">
              <button
                class="hover:bg-accent active:bg-accent/80 flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors"
                title={isMissingProject(project) ? 'Open — its source will create this folder' : undefined}
                onclick={() => {
                  if (isMissingProject(project)) {
                    void attemptOpen(project.path);
                    return;
                  }
                  toggleProject(project.path);
                }}
              >
                <ChevronRight class="text-muted-foreground size-3.5 shrink-0 transition-transform {expanded ? 'rotate-90' : ''}" />
                <Star class="size-3 shrink-0 {project.favorite ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground/40'}" />
                <span class="text-foreground truncate text-[13px] font-medium {project.archived ? 'opacity-70' : ''}" data-project-name={project.path}>{project.name}</span>
                {#if project.archived}
                  <span class="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-[10px] font-medium tracking-wide uppercase">Archived</span>
                {/if}
              </button>
              <div class="chips ml-auto flex shrink-0 items-center gap-1 max-md:ml-0 max-md:basis-full max-md:overflow-x-auto max-md:py-0.5">
                {#if project.activeSessionCount > 0}
                  <span
                    class="flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-px text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400"
                    title={`${project.activeSessionCount} open session${project.activeSessionCount !== 1 ? 's' : ''}`}
                  >
                    <span class="bg-status-connected size-1.5 rounded-full"></span>
                    {project.activeSessionCount}
                  </span>
                {/if}
                {#if project.kind === 'multi' && project.repos?.length}
                  {#each project.repos as repo (repo.path)}
                    <span
                      class="bg-muted text-muted-foreground flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] {repo.missing
                        ? 'border border-yellow-500/20 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                        : ''}"
                      title={repo.missing ? `${repo.name} is missing on disk` : repo.path}
                    >
                      {#if !repo.missing}
                        <span class="size-1.5 rounded-full {repo.dirty ? 'bg-yellow-500' : 'bg-muted-foreground/40'}" title={repo.dirty ? 'Uncommitted changes' : 'Clean'}></span>
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
              </div>

              {#if project.tags?.length}
                <div class="flex shrink-0 items-center gap-1 max-md:basis-full max-md:overflow-x-auto max-md:py-0.5">
                  {#each project.tags as tag (tag)}
                    {@const removable = project.userTags?.includes(tag) === true}
                    <span
                      class="flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[10.5px] {removable
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
                </div>
              {/if}

              <DropdownMenu>
                <DropdownMenuTrigger>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="text-muted-foreground hover:text-sidebar-foreground shrink-0"
                    title="Manage project"
                    disabled={connection.status !== 'connected'}
                  >
                    <EllipsisVertical class="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuContent class="w-48" align="end">
                    <DropdownMenuItem class="gap-2" onSelect={() => openTagDialog(project)}>
                      <Tags class="size-4" />
                      Add tag…
                    </DropdownMenuItem>
                    <DropdownMenuItem class="gap-2" onSelect={() => void updateProject(project, { favorite: !project.favorite })}>
                      <Star class="size-4 {project.favorite ? 'fill-yellow-500 text-yellow-500' : ''}" />
                      {project.favorite ? 'Unfavorite' : 'Favorite'}
                    </DropdownMenuItem>
                    <DropdownMenuItem class="gap-2" disabled={idx <= 0} onSelect={() => moveProject(project, -1)}>
                      <ArrowUp class="size-4" />
                      Move up
                    </DropdownMenuItem>
                    <DropdownMenuItem class="gap-2" disabled={idx < 0 || idx >= projectStore.projects.length - 1} onSelect={() => moveProject(project, 1)}>
                      <ArrowDown class="size-4" />
                      Move down
                    </DropdownMenuItem>
                    <DropdownMenuItem class="gap-2" onSelect={() => void updateProject(project, { archived: !project.archived })}>
                      {#if project.archived}
                        <Undo2 class="size-4" />
                        Unarchive project
                      {:else}
                        <Archive class="size-4" />
                        Archive project
                      {/if}
                    </DropdownMenuItem>
                    {#if project.kind === 'multi'}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem class="text-destructive focus:bg-destructive/10 dark:focus:bg-destructive/20 gap-2" onSelect={() => (disbandTarget = project)}>
                        <Trash2 class="size-4" />
                        Disband project
                      </DropdownMenuItem>
                    {/if}
                  </DropdownMenuContent>
                </DropdownMenuPortal>
              </DropdownMenu>

              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-sidebar-foreground shrink-0"
                title="New session in {project.name}"
                disabled={connection.status !== 'connected'}
                onclick={(e) => {
                  e.stopPropagation();
                  void newSession(project.path);
                }}
              >
                <Plus class="size-4" />
              </Button>
            </div>

            {#if expanded}
              <div class="border-sidebar-border ml-4 flex flex-col gap-0.5 border-l pt-1 pl-2">
                {#each visibleSessions as session (session.id)}
                  <SessionItem {session} folderPath={project.path} {onSessionSelect} />
                {/each}

                {#if projectSessions.length === 0}
                  <div class="text-muted-foreground px-3 py-1 text-xs">No sessions yet</div>
                {/if}

                {#if hiddenCount > 0 && !showAll}
                  <button
                    class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md px-3 py-1.5 text-xs transition-colors"
                    onclick={() => toggleSessionList(project.path)}
                  >
                    Show {hiddenCount} more session{hiddenCount !== 1 ? 's' : ''}
                  </button>
                {:else if showAll && hiddenCount > 0}
                  <button
                    class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md px-3 py-1.5 text-xs transition-colors"
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

<Dialog.Root open={showNewSessionDialog} onOpenChange={handleNewSessionDialogOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    {#if dialogMode === 'pick'}
      <Dialog.Header>
        <Dialog.Title>Start a new session</Dialog.Title>
        <Dialog.Description>Choose a project to start from. Search is client-side over discovered projects.</Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col gap-4">
        <Input bind:value={projectSearch} placeholder="Search projects" autofocus />

        <div class="border-border max-h-80 overflow-y-auto rounded-md border">
          {#if pickerProjects.length === 0}
            <div class="text-muted-foreground px-3 py-6 text-center text-sm">No matching projects.</div>
          {:else}
            <div class="flex flex-col p-1">
              {#each pickerProjects as folder (folder.path)}
                <button
                  class="hover:bg-accent hover:text-accent-foreground flex items-start gap-2 rounded-md px-3 py-2 text-left transition-colors"
                  disabled={connection.status !== 'connected'}
                  onclick={() => void newSession(folder.path)}
                >
                  <FolderIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium">{folder.name}</div>
                    <div class="text-muted-foreground truncate text-xs">{folder.path}</div>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <Dialog.Footer class="flex gap-2">
          {#if projectStore.roots.length > 0}
            <Button variant="outline" onclick={startCreateProject}>
              <Plus class="size-4" />
              Create new project
            </Button>
          {/if}
          <div class="flex-1"></div>
          <Button variant="outline" type="button" onclick={() => handleNewSessionDialogOpenChange(false)}>Cancel</Button>
        </Dialog.Footer>
      </div>
    {:else if dialogMode === 'create-root'}
      <Dialog.Header>
        <Dialog.Title>Create new project</Dialog.Title>
        <Dialog.Description>Choose where to create the project.</Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col gap-4">
        <div class="border-border max-h-80 overflow-y-auto rounded-md border">
          <div class="flex flex-col p-1">
            {#each projectStore.roots as root (root)}
              <button class="hover:bg-accent hover:text-accent-foreground flex items-start gap-2 rounded-md px-3 py-2 text-left transition-colors" onclick={() => selectRoot(root)}>
                <FolderIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium">{root}</div>
                </div>
              </button>
            {/each}
          </div>
        </div>

        <Dialog.Footer>
          <Button variant="outline" onclick={backToPickMode}>Back</Button>
        </Dialog.Footer>
      </div>
    {:else if dialogMode === 'create-name'}
      <Dialog.Header>
        <Dialog.Title>Create new project</Dialog.Title>
        <Dialog.Description>New project in <code class="bg-muted rounded px-1 py-0.5 text-xs">{createRoot}</code></Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <Input
            bind:value={createName}
            placeholder="Project name"
            autofocus
            disabled={creating}
            onkeydown={(e) => {
              if (e.key === 'Enter') void createProject();
            }}
          />
          {#if createError}
            <p class="text-destructive text-sm">{createError}</p>
          {/if}
        </div>

        <Dialog.Footer>
          <Button variant="outline" onclick={projectStore.roots.length > 1 ? backToRootSelection : backToPickMode} disabled={creating}>Back</Button>
          <Button onclick={() => void createProject()} disabled={creating || !createName.trim()}>
            {#if creating}
              <Loader2 class="size-4 animate-spin" />
              Creating…
            {:else}
              Create
            {/if}
          </Button>
        </Dialog.Footer>
      </div>
    {/if}
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
