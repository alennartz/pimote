<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { connection } from '$lib/stores/connection.svelte.js';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import { setEditorText } from '$lib/stores/input-bar.svelte.js';
  import type { ExtensionUiRequestEvent } from '@pimote/shared';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Info from '@lucide/svelte/icons/info';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  // Status entries: key → text
  let statuses = new SvelteMap<string, string>();

  // Widget entries: key → lines
  let widgets = new SvelteMap<string, string[]>();

  // Notifications with auto-dismiss
  interface Notification {
    id: number;
    text: string;
    notificationType: 'info' | 'warning' | 'error';
  }
  let notifications: Notification[] = $state([]);
  let nextNotifId = 0;

  function addNotification(text: string, type: 'info' | 'warning' | 'error' = 'info') {
    const id = nextNotifId++;
    notifications = [...notifications, { id, text, notificationType: type }];
    setTimeout(() => {
      notifications = notifications.filter((n) => n.id !== id);
    }, 5000);
  }

  function dismissNotification(id: number) {
    notifications = notifications.filter((n) => n.id !== id);
  }

  onMount(() => {
    const unsubscribe = connection.onEvent((event) => {
      if (event.type !== 'extension_ui_request') return;
      const req = event as ExtensionUiRequestEvent;

      if (req.method === 'setStatus') {
        const key = req.key as string;
        const text = req.text as string | undefined;
        if (text) {
          statuses.set(key, text);
        } else {
          statuses.delete(key);
        }
      } else if (req.method === 'setWidget') {
        const key = req.key as string;
        const lines = req.lines as string[] | undefined;
        if (lines && lines.length > 0) {
          widgets.set(key, lines);
        } else {
          widgets.delete(key);
        }
      } else if (req.method === 'notify') {
        const text = (req.text as string) ?? (req.message as string) ?? '';
        const type = (req.notifyType as 'info' | 'warning' | 'error') ?? (req.notificationType as 'info' | 'warning' | 'error') ?? 'info';
        addNotification(text, type);
      } else if (req.method === 'setEditorText') {
        const text = (req.text as string) ?? '';
        const targetSessionId = req.sessionId as string | undefined;
        if (targetSessionId) {
          const session = sessionRegistry.sessions[targetSessionId];
          if (session) {
            session.draftText = text;
          }
          // Fire reactive signal so InputBar updates if this is the viewed session
          setEditorText(targetSessionId, text);
        }
      }
    });
    return unsubscribe;
  });

  const statusEntries = $derived([...statuses.entries()]);
  const widgetEntries = $derived([...widgets.entries()]);
</script>

<!-- Status bar -->
{#if statusEntries.length > 0}
  <div class="border-border bg-muted/50 text-muted-foreground flex items-center gap-3 border-t px-4 py-1.5 text-xs">
    {#each statusEntries as [key, text] (key)}
      <span class="truncate">{text}</span>
    {/each}
  </div>
{/if}

<!-- Widgets -->
{#if widgetEntries.length > 0}
  <div class="border-border bg-muted/30 flex flex-col gap-2 border-t px-4 py-2">
    {#each widgetEntries as [key, lines] (key)}
      <div class="text-muted-foreground font-mono text-xs">
        {#each lines as line, i (i)}
          <div>{line}</div>
        {/each}
      </div>
    {/each}
  </div>
{/if}

<!-- Toast notifications -->
{#if notifications.length > 0}
  <div class="pointer-events-none fixed top-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
    {#each notifications as notif (notif.id)}
      <button
        class="pointer-events-auto flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm shadow-lg transition-opacity
					{notif.notificationType === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : notif.notificationType === 'warning'
            ? 'border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
            : 'border-border bg-background text-foreground'}"
        onclick={() => dismissNotification(notif.id)}
      >
        {#if notif.notificationType === 'error'}
          <CircleAlert class="size-4 shrink-0" />
        {:else if notif.notificationType === 'warning'}
          <TriangleAlert class="size-4 shrink-0" />
        {:else}
          <Info class="size-4 shrink-0" />
        {/if}
        <span>{notif.text}</span>
      </button>
    {/each}
  </div>
{/if}
