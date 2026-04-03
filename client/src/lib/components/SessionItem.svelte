<script lang="ts">
  import { ContextMenu } from 'bits-ui';
  import type { SessionInfo } from '@pimote/shared';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry, switchToSession, closeSession } from '$lib/stores/session-registry.svelte.js';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
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
      const response = await connection.send({
        type: 'open_session',
        folderPath,
        sessionId: session.id,
      });
      if (!response.success && response.error === 'session_owned') {
        const projectName = folderPath.split('/').pop() || 'Unknown';
        sessionRegistry.addSession(session.id, folderPath, projectName);
        sessionRegistry.sessions[session.id].pendingTakeover = true;
        sessionRegistry.switchTo(session.id);
      }
    } catch (e) {
      console.error('Failed to open session:', e);
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
          <div class="text-sidebar-foreground truncate text-sm font-medium">
            {displayName()}
          </div>
          <div class="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
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
