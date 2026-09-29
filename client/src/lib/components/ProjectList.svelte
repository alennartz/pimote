<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { ProjectInfo } from '@pimote/shared';
  import { projectStore } from '$lib/stores/project-store.svelte.js';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { formatRelativeTime } from '$lib/format-relative-time.js';
  import SessionItem from './SessionItem.svelte';
  import Archive from '@lucide/svelte/icons/archive';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
  import Loader2 from '@lucide/svelte/icons/loader-2';
  import Network from '@lucide/svelte/icons/network';
  import Plus from '@lucide/svelte/icons/plus';
  import Star from '@lucide/svelte/icons/star';
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

  // Create hub project flow state
  let showHubDialog = $state(false);
  let hubName = $state('');
  let hubRoot = $state('');
  let hubMembers = new SvelteSet<string>();
  let hubError = $state('');
  let hubCreating = $state(false);

  // Disband confirmation state
  let disbandTarget = $state<ProjectInfo | null>(null);

  const displayProjects = $derived(projectStore.visibleProjects);
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
  const hubCandidateRepos = $derived(projectStore.repos.filter((repo) => !repo.missing));

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
  async function updateProject(project: ProjectInfo, patch: { favorite?: boolean; order?: number; archived?: boolean }) {
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

  function openHubDialog() {
    hubName = '';
    hubRoot = '';
    hubError = '';
    hubCreating = false;
    hubMembers.clear();
    showHubDialog = true;
    void projectStore.loadRepos();
  }

  function handleHubDialogOpenChange(open: boolean) {
    showHubDialog = open;
    if (!open) {
      hubName = '';
      hubRoot = '';
      hubError = '';
      hubCreating = false;
      hubMembers.clear();
    }
  }

  function toggleHubMember(path: string) {
    if (hubMembers.has(path)) {
      hubMembers.delete(path);
    } else {
      hubMembers.add(path);
    }
  }

  async function createHub() {
    const name = hubName.trim();
    const validationError = validateProjectName(name) ?? (!hubRoot ? 'Choose a root folder' : null) ?? (hubMembers.size === 0 ? 'Select at least one member repository' : null);
    if (validationError) {
      hubError = validationError;
      return;
    }

    hubCreating = true;
    hubError = '';

    try {
      const response = await connection.send({
        type: 'create_hub_project',
        name,
        root: hubRoot,
        repoPaths: [...hubMembers],
      });

      if (!response.success) {
        hubError = response.error ?? 'Failed to create hub project';
        hubCreating = false;
        return;
      }

      handleHubDialogOpenChange(false);
    } catch (e) {
      hubError = e instanceof Error ? e.message : 'Failed to create hub project';
      hubCreating = false;
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
    <div class="flex flex-col gap-1 px-1">
      <Button class="w-full justify-center" onclick={openNewSessionDialog} disabled={connection.status !== 'connected'}>
        <Plus class="size-4" />
        New session
      </Button>
      <div class="flex items-center justify-between">
        <label class="text-muted-foreground hover:text-sidebar-foreground flex items-center gap-1.5 py-1 text-xs">
          <input type="checkbox" checked={projectStore.showArchived} onchange={(e) => projectStore.setShowArchived((e.currentTarget as HTMLInputElement).checked)} />
          <span>Show archived</span>
        </label>
        <div class="flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-sidebar-foreground"
            title="Create multi-repo hub"
            disabled={connection.status !== 'connected' || projectStore.roots.length === 0}
            onclick={openHubDialog}
          >
            <Network class="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-sidebar-foreground"
            title="Archive all inactive sessions"
            disabled={connection.status !== 'connected' || archivableCount === 0}
            onclick={() => (showArchiveAllDialog = true)}
          >
            <Archive class="size-4" />
          </Button>
        </div>
      </div>
    </div>

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
          {@const projectSessions = projectStore.sessions.get(project.path) ?? []}
          {@const visibleSessions = showAll ? projectSessions : projectSessions.slice(0, MAX_SESSIONS_SHOWN)}
          {@const hiddenCount = Math.max(0, projectSessions.length - MAX_SESSIONS_SHOWN)}
          {@const idx = projectIndex(project.path)}

          <div class="rounded-lg">
            <div class="flex items-center gap-1">
              <button
                class="hover:bg-sidebar-accent active:bg-sidebar-accent/80 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors active:scale-[0.97]"
                onclick={() => toggleProject(project.path)}
              >
                <ChevronRight class="text-muted-foreground size-4 shrink-0 transition-transform {expanded ? 'rotate-90' : ''}" />
                {#if project.kind === 'multi'}
                  <FolderGit2 class="text-muted-foreground size-4 shrink-0" />
                {:else}
                  <FolderIcon class="text-muted-foreground size-4 shrink-0" />
                {/if}
                <div class="min-w-0 flex-1">
                  <div class="text-sidebar-foreground flex items-center gap-2 truncate text-sm font-medium">
                    <span class="truncate {project.archived ? 'opacity-70' : ''}">{project.name}</span>
                    {#if project.archived}
                      <span class="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">Archived</span>
                    {/if}
                    {#if project.activeSessionCount > 0}
                      <span class="bg-status-connected size-2 shrink-0 rounded-full"></span>
                    {/if}
                  </div>
                  <div class="text-muted-foreground mt-0.5 truncate text-xs">
                    {#if projectSessions.length === 0}
                      No sessions
                    {:else}
                      {projectSessions.length} session{projectSessions.length !== 1 ? 's' : ''} · updated {formatRelativeTime(projectSessions[0].modified)}
                    {/if}
                  </div>
                </div>
              </button>

              <Button
                variant="ghost"
                size="icon-sm"
                class="shrink-0 {project.favorite ? 'text-yellow-500' : 'text-muted-foreground hover:text-sidebar-foreground'}"
                title={project.favorite ? 'Unfavorite' : 'Favorite'}
                disabled={connection.status !== 'connected'}
                onclick={() => void updateProject(project, { favorite: !project.favorite })}
              >
                <Star class="size-4 {project.favorite ? 'fill-yellow-500' : ''}" />
              </Button>

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

            {#if project.kind === 'multi' && project.repos?.length}
              <div class="mt-0.5 flex flex-wrap gap-1 pr-2 pl-8">
                {#each project.repos as repo (repo.path)}
                  <span
                    class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] {repo.missing
                      ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                      : 'bg-muted text-muted-foreground'}"
                    title={repo.missing ? `${repo.name} is missing on disk` : repo.path}
                  >
                    {#if !repo.missing}
                      <span class="size-1.5 rounded-full {repo.dirty ? 'bg-yellow-500' : 'bg-muted-foreground/40'}" title={repo.dirty ? 'Uncommitted changes' : 'Clean'}></span>
                    {/if}
                    <span class="max-w-32 truncate">{repo.name}</span>
                    {#if repo.missing}
                      <span class="font-medium">missing</span>
                    {:else if repo.branch}
                      <span class="max-w-24 truncate">{repo.branch}</span>
                    {/if}
                  </span>
                {/each}
              </div>
            {/if}

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

<Dialog.Root open={showHubDialog} onOpenChange={handleHubDialogOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Create multi-repo hub</Dialog.Title>
      <Dialog.Description>Creates a hub folder with symlinks to each member repository and an AGENTS.md naming the members.</Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-4">
      <Input
        bind:value={hubName}
        placeholder="Hub name"
        disabled={hubCreating}
        onkeydown={(e) => {
          if (e.key === 'Enter') void createHub();
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
                  class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors {hubRoot === root
                    ? 'bg-accent text-accent-foreground'
                    : ''}"
                  disabled={hubCreating}
                  onclick={() => (hubRoot = root)}
                >
                  <FolderIcon class="text-muted-foreground size-4 shrink-0" />
                  <span class="min-w-0 flex-1 truncate">{root}</span>
                  {#if hubRoot === root}
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
        {#if hubCandidateRepos.length === 0}
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
              {#each hubCandidateRepos as repo (repo.path)}
                {@const selected = hubMembers.has(repo.path)}
                <button
                  class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-left transition-colors {selected
                    ? 'bg-accent text-accent-foreground'
                    : ''}"
                  disabled={hubCreating}
                  onclick={() => toggleHubMember(repo.path)}
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

      {#if hubError}
        <p class="text-destructive text-sm">{hubError}</p>
      {/if}

      <Dialog.Footer>
        <Button variant="outline" onclick={() => handleHubDialogOpenChange(false)} disabled={hubCreating}>Cancel</Button>
        <Button onclick={() => void createHub()} disabled={hubCreating || !hubName.trim() || !hubRoot || hubMembers.size === 0}>
          {#if hubCreating}
            <Loader2 class="size-4 animate-spin" />
            Creating…
          {:else}
            Create hub
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
      <Dialog.Description>This deletes the hub folder and removes the project from the list. Member repositories are not touched.</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (disbandTarget = null)}>Cancel</Button>
      <Button variant="destructive" onclick={disbandProject}>Disband</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
