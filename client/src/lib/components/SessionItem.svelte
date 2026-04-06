<script lang="ts">
  import { ContextMenu } from 'bits-ui';
  import type { SessionInfo } from '@pimote/shared';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry, switchToSession, closeSession, openExistingSession } from '$lib/stores/session-registry.svelte.js';
  import Archive from '@lucide/svelte/icons/archive';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { formatRelativeTime } from '$lib/format-relative-time.js';

  interface Props {
    session: SessionInfo;
    folderPath: string;
    onSessionSelect?: () => void;
  }

  let { session, folderPath, onSessionSelect }: Props = $props();

  const isActive = $derived(sessionRegistry.isActiveSession(session.id));
  const isRemoteActive = $derived(session.liveStatus != null && !session.isOwnedByMe);

  let showDeleteDialog = $state(false);
  let showRenameDialog = $state(false);
  let renameValue = $state('');
  let renaming = $state(false);

  function displayName(): string {
    if (session.name) return session.name;
    if (session.firstMessage) {
      return session.firstMessage.length > 60 ? session.firstMessage.slice(0, 60) + '…' : session.firstMessage;
    }
    return `Session ${session.id.slice(0, 8)}`;
  }

  async function openSession() {
    try {
      onSessionSelect?.();
      if (isActive) {
        switchToSession(session.id);
        return;
      }
      await openExistingSession(session.id, folderPath, { switchTo: true });
    } catch (e) {
      console.error('Failed to open session:', e);
    }
  }

  function openRenameDialog() {
    renameValue = session.name ?? '';
    showRenameDialog = true;
  }

  async function renameSession() {
    const name = renameValue.trim();
    if (!name || renaming) return;

    renaming = true;
    try {
      await connection.send({
        type: 'rename_session',
        folderPath,
        sessionId: session.id,
        name,
      });
      showRenameDialog = false;
    } catch (e) {
      console.error('Failed to rename session:', e);
    } finally {
      renaming = false;
    }
  }

  async function toggleArchived(archived: boolean) {
    try {
      await connection.send({
        type: 'archive_session',
        folderPath,
        sessionId: session.id,
        archived,
      });
      if (archived && isActive) {
        closeSession(session.id);
      }
    } catch (e) {
      console.error('Failed to update archive state:', e);
    }
  }

  async function deleteSession() {
    try {
      if (isActive) {
        closeSession(session.id);
      }
      await connection.send({
        type: 'delete_session',
        folderPath,
        sessionId: session.id,
      });
    } catch (e) {
      console.error('Failed to delete session:', e);
    }
    showDeleteDialog = false;
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger class="w-full">
    <button
      class="active:bg-sidebar-accent/80 w-full rounded-md px-3 py-2 text-left transition-colors active:scale-[0.97] {isActive ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent'}"
      onclick={openSession}
    >
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <div class="text-sidebar-foreground min-w-0 flex-1 truncate text-sm font-medium {session.archived ? 'opacity-70' : ''}">
              {displayName()}
            </div>
            {#if session.archived}
              <span class="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">Archived</span>
            {/if}
          </div>
          <div class="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs {session.archived ? 'opacity-70' : ''}">
            <span>{session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}</span>
            <span>·</span>
            <span>{formatRelativeTime(session.modified)}</span>
          </div>
        </div>
        {#if isActive}
          <div class="bg-status-connected size-2 shrink-0 rounded-full"></div>
        {:else if isRemoteActive}
          <Monitor class="text-muted-foreground size-3.5 shrink-0" />
        {/if}
      </div>
    </button>
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content class="bg-popover text-popover-foreground ring-foreground/10 z-50 min-w-36 overflow-hidden rounded-lg p-1 shadow-md ring-1">
      <ContextMenu.Item
        class="focus:bg-accent focus:text-accent-foreground flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none"
        onSelect={openRenameDialog}
      >
        <Pencil class="size-4" />
        Rename session
      </ContextMenu.Item>
      <ContextMenu.Item
        class="focus:bg-accent focus:text-accent-foreground flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none"
        onSelect={() => {
          void toggleArchived(!session.archived);
        }}
      >
        {#if session.archived}
          <Undo2 class="size-4" />
          Unarchive session
        {:else}
          <Archive class="size-4" />
          Archive session
        {/if}
      </ContextMenu.Item>
      <ContextMenu.Item
        class="focus:bg-destructive/10 dark:focus:bg-destructive/20 text-destructive flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none"
        onSelect={() => {
          showDeleteDialog = true;
        }}
      >
        <Trash2 class="size-4" />
        Delete session
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>

<Dialog.Root bind:open={showRenameDialog}>
  <Dialog.Content showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>Rename session</Dialog.Title>
      <Dialog.Description>Give this session a clearer name in the sidebar.</Dialog.Description>
    </Dialog.Header>
    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        void renameSession();
      }}
    >
      <Input bind:value={renameValue} placeholder={displayName()} autofocus maxlength={120} />
      <Dialog.Footer>
        <Button variant="outline" type="button" onclick={() => (showRenameDialog = false)} disabled={renaming}>Cancel</Button>
        <Button type="submit" disabled={renaming || renameValue.trim().length === 0}>Rename</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={showDeleteDialog}>
  <Dialog.Content showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>Delete session</Dialog.Title>
      <Dialog.Description>This will permanently delete this session file. This cannot be undone.</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (showDeleteDialog = false)}>Cancel</Button>
      <Button variant="destructive" onclick={deleteSession}>Delete</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
