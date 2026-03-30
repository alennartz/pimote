<script lang="ts">
  import type { SessionInfo } from '@pimote/shared';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry, switchToSession } from '$lib/stores/session-registry.svelte.js';
  import Monitor from '@lucide/svelte/icons/monitor';

  interface Props {
    session: SessionInfo;
    folderPath: string;
    onSessionSelect?: () => void;
  }

  let { session, folderPath, onSessionSelect }: Props = $props();

  const isActive = $derived(sessionRegistry.isActiveSession(session.id));
  const isRemoteActive = $derived(session.liveStatus != null && !session.isOwnedByMe);

  function formatRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 30) return `${diffDay}d ago`;
    return date.toLocaleDateString();
  }

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
        // Session is claimed by another client — show takeover prompt
        const projectName = folderPath.split('/').pop() || 'Unknown';
        sessionRegistry.addSession(session.id, folderPath, projectName);
        sessionRegistry.sessions[session.id].pendingTakeover = true;
        sessionRegistry.switchTo(session.id);
      }
    } catch (e) {
      console.error('Failed to open session:', e);
    }
  }
</script>

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
