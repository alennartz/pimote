<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { createHotkey, formatForDisplay, type RegisterableHotkey } from '@tanstack/svelte-hotkeys';
  import type { FolderInfo, LauncherSessionHit } from '@pimote/shared';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import TerminalIcon from '@lucide/svelte/icons/terminal';
  import * as Command from '$lib/components/ui/command/index.js';
  import { isSessionOpenCancelledResponse } from '$lib/session-open-response.js';
  import { openExistingSession, openNewSession, sessionRegistry, switchToSession } from '$lib/stores/session-registry.svelte.js';
  import type { GlobalLauncherActions, GlobalLauncherProps, LauncherCommand, LauncherSnapshot } from '$lib/launcher/contracts.js';
  import { getDefaultLauncherCommands } from '$lib/launcher/commands.js';
  import { createLauncherSearch, createWsLauncherTransport } from '$lib/launcher/search-client.js';

  let { transport, getCommands, actions, debounceMs }: GlobalLauncherProps = $props();

  const defaultActions: GlobalLauncherActions = {
    async startSessionInFolder(folderPath: string) {
      const response = await openNewSession(folderPath);
      if (!response.success && !isSessionOpenCancelledResponse(response)) {
        console.error('Failed to create new session:', response.error);
      }
    },
    async openSession(hit: LauncherSessionHit) {
      if (sessionRegistry.sessions[hit.sessionId]) {
        switchToSession(hit.sessionId);
        return;
      }
      await openExistingSession(hit.sessionId, hit.folderPath, { switchTo: true });
    },
  };

  const defaultTransport = createWsLauncherTransport();
  let open = $state(false);
  let queryInput = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);
  let snapshot = $state<LauncherSnapshot>({
    query: { raw: '', category: 'all', prefix: null, term: '' },
    loading: false,
    error: null,
    folders: [],
    sessions: [],
    commands: [],
  });

  const controller = createLauncherSearch({
    transport: {
      search: (params) => (transport ?? defaultTransport).search(params),
    },
    getCommands: () => (getCommands ?? getDefaultLauncherCommands)(),
    debounceMs: untrack(() => debounceMs),
    onChange(next) {
      snapshot = next;
    },
  });

  onDestroy(() => {
    controller.dispose();
  });

  function openLauncher(): void {
    open = true;
    queryInput = '';
    controller.open();
    void tick().then(() => inputEl?.focus());
  }

  function closeLauncher(): void {
    if (!open) return;
    open = false;
    queryInput = '';
    controller.reset();
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (nextOpen) openLauncher();
    else closeLauncher();
  }

  function handleQueryInput(nextValue: string): void {
    queryInput = nextValue;
    if (open) controller.setQuery(nextValue);
  }

  createHotkey(
    'Mod+K',
    () => {
      if (open) closeLauncher();
      else openLauncher();
    },
    { ignoreInputs: false },
  );

  function selectFolder(folder: FolderInfo): void {
    closeLauncher();
    void (actions ?? defaultActions).startSessionInFolder(folder.path);
  }

  function selectSession(hit: LauncherSessionHit): void {
    closeLauncher();
    void (actions ?? defaultActions).openSession(hit);
  }

  function selectCommand(command: LauncherCommand): void {
    closeLauncher();
    void command.run();
  }

  function folderLabel(folder: FolderInfo): string {
    return folder.persona?.name ?? folder.name;
  }

  function sessionLabel(hit: LauncherSessionHit): string {
    const trimmedName = hit.name?.trim();
    if (trimmedName) return trimmedName;
    const trimmedMessage = hit.firstMessage.trim();
    return trimmedMessage || hit.sessionId;
  }

  function formatShortcut(shortcut: string | undefined): string {
    if (!shortcut) return '';
    return formatForDisplay(shortcut as RegisterableHotkey);
  }

  const hasResults = $derived(snapshot.folders.length > 0 || snapshot.sessions.length > 0 || snapshot.commands.length > 0);
</script>

<Command.Dialog
  {open}
  onOpenChange={handleOpenChange}
  onOpenAutoFocus={(event) => {
    event.preventDefault();
    inputEl?.focus();
  }}
  shouldFilter={false}
  vimBindings={false}
  loop={true}
  title="Global Launcher"
  description="Jump to folders, sessions, or commands"
>
  <Command.Input
    bind:ref={inputEl}
    value={queryInput}
    oninput={(event) => handleQueryInput(event.currentTarget.value)}
    placeholder="Search folders, sessions, or type > commands, @ sessions, # folders..."
    aria-label="Search folders, sessions, or commands"
  />
  <Command.List>
    {#if snapshot.error}
      <div class="text-destructive border-border border-b px-3 py-2 text-xs" role="alert">
        {snapshot.error}
      </div>
    {/if}

    {#if !hasResults}
      <Command.Empty>
        {#if snapshot.loading}
          Searching...
        {:else}
          No matching results.
        {/if}
      </Command.Empty>
    {/if}

    {#if snapshot.folders.length > 0}
      <Command.Group heading="Folders">
        {#each snapshot.folders as folder (folder.path)}
          <Command.Item value={`folder:${folder.path}`} onSelect={() => selectFolder(folder)}>
            <FolderIcon class="size-4 shrink-0" />
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-medium">{folderLabel(folder)}</span>
              <span class="text-muted-foreground truncate text-xs">{folder.path}</span>
            </div>
            <Command.Shortcut>New session</Command.Shortcut>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    {#if snapshot.sessions.length > 0}
      <Command.Group heading="Sessions">
        {#each snapshot.sessions as hit (hit.sessionId)}
          <Command.Item value={`session:${hit.sessionId}`} onSelect={() => selectSession(hit)}>
            <MessageSquareIcon class="size-4 shrink-0" />
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-medium">{sessionLabel(hit)}</span>
              <span class="text-muted-foreground truncate text-xs">{hit.folderName}</span>
            </div>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}

    {#if snapshot.commands.length > 0}
      <Command.Group heading="Commands">
        {#each snapshot.commands as command (command.id)}
          <Command.Item value={`command:${command.id}`} onSelect={() => selectCommand(command)}>
            <TerminalIcon class="size-4 shrink-0" />
            <span class="truncate">{command.label}</span>
            {#if command.shortcut}
              <Command.Shortcut>{formatShortcut(command.shortcut)}</Command.Shortcut>
            {/if}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
  </Command.List>
  <div class="border-border text-muted-foreground flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[11px]">
    <div class="flex items-center gap-2.5">
      <span><kbd class="bg-muted rounded px-1 py-0.5 font-mono">#</kbd> folders</span>
      <span><kbd class="bg-muted rounded px-1 py-0.5 font-mono">@</kbd> sessions</span>
      <span><kbd class="bg-muted rounded px-1 py-0.5 font-mono">&gt;</kbd> commands</span>
    </div>
    <span><kbd class="bg-muted rounded px-1 py-0.5 font-mono">Esc</kbd> close</span>
  </div>
</Command.Dialog>
