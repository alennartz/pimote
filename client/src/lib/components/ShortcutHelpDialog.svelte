<script lang="ts">
  import { createHotkey, formatForDisplay, type RegisterableHotkey } from '@tanstack/svelte-hotkeys';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { shortcutHelpStore } from '$lib/stores/shortcut-help-store.svelte.js';

  interface ShortcutRow {
    keys: RegisterableHotkey;
    label: string;
  }

  interface ShortcutSection {
    title: string;
    rows: ShortcutRow[];
  }

  createHotkey('?', (event) => {
    if (shortcutHelpStore.isOpen) {
      shortcutHelpStore.close();
      return;
    }
    // Never fight an open modal for the key.
    if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== null) return;
    shortcutHelpStore.open();
  });

  const sections: ShortcutSection[] = [
    {
      title: 'Global',
      rows: [
        { keys: 'Mod+K', label: 'Open or close the launcher' },
        { keys: '?', label: 'Show or hide this shortcut map' },
      ],
    },
    {
      title: 'Launcher',
      rows: [
        { keys: '#', label: 'Search folders only' },
        { keys: '@', label: 'Search sessions only' },
        { keys: '>', label: 'Search commands only' },
        { keys: 'Escape', label: 'Close the launcher' },
      ],
    },
    {
      title: 'Home toolbar',
      rows: [{ keys: 'Mod+/', label: 'Switch between search and the manager' }],
    },
    {
      title: 'Transcript',
      rows: [
        { keys: 'Mod+F', label: 'Find in conversation' },
        { keys: 'Escape', label: 'Close find' },
        { keys: 'Mod+End', label: 'Stick to the bottom' },
      ],
    },
    {
      title: 'Composer',
      rows: [
        { keys: 'Enter', label: 'Send message' },
        { keys: 'Shift+Enter', label: 'New line' },
        { keys: 'Tab', label: 'Accept autocomplete suggestion' },
        { keys: 'Escape', label: 'Dismiss suggestion or abort while streaming' },
        { keys: 'ArrowUp', label: 'Recall previous message' },
        { keys: 'ArrowDown', label: 'Next message or back to your draft' },
        { keys: 'End', label: 'From history: jump straight to your draft' },
      ],
    },
  ];

  function formatShortcut(keys: RegisterableHotkey): string {
    return formatForDisplay(keys);
  }
</script>

<Dialog.Root bind:open={shortcutHelpStore.isOpen}>
  <Dialog.Content class="max-h-[80dvh] overflow-y-auto sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Keyboard shortcuts</Dialog.Title>
      <Dialog.Description>Every Pimote shortcut in one place.</Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-5">
      {#each sections as section (section.title)}
        <section>
          <h3 class="text-muted-foreground mb-1 text-xs font-medium">{section.title}</h3>
          <ul class="flex flex-col">
            {#each section.rows as row (row.keys + row.label)}
              <li class="border-border/60 flex items-center justify-between gap-4 border-b py-1.5 text-sm last:border-b-0">
                <span>{row.label}</span>
                <kbd class="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-xs">{formatShortcut(row.keys)}</kbd>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
