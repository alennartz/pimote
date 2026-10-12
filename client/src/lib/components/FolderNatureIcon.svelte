<script module lang="ts">
  export type FolderIconKind = 'code' | 'code-hub' | 'persona' | 'persona-hub';

  /** Icon kind from folder facts: nature × shortcut presence only.
   *  Shortcut-bearing folders get the hub variant even without hub registry
   *  membership — `repos` gates the membership chips, never the icon. */
  export function folderIconKind(folder: { nature: 'code' | 'persona'; shortcutCount: number }): FolderIconKind {
    const hub = folder.shortcutCount > 0;
    return folder.nature === 'persona' ? (hub ? 'persona-hub' : 'persona') : hub ? 'code-hub' : 'code';
  }
</script>

<script lang="ts">
  let { kind, class: className = '', strokeWidth = 2 }: { kind: FolderIconKind; class?: string; strokeWidth?: number } = $props();
</script>

<!-- Four folder glyphs: code / code-hub / persona / persona-hub. -->
{#if kind === 'code'}
  <svg
    class={className}
    data-folder-icon="code"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="m8 6-5 6 5 6" />
    <path d="m16 6 5 6-5 6" />
    <path d="m13.5 4-3 16" />
  </svg>
{:else if kind === 'code-hub'}
  <svg
    class={className}
    data-folder-icon="code-hub"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="2.5" y="9" width="6" height="6" rx="1.5" />
    <rect x="15.5" y="2.5" width="6" height="6" rx="1.5" />
    <rect x="15.5" y="15.5" width="6" height="6" rx="1.5" />
    <path d="M8.5 12h3.5v-6h3.5" />
    <path d="M12 12v6h3.5" />
  </svg>
{:else if kind === 'persona'}
  <svg
    class={className}
    data-folder-icon="persona"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
{:else}
  <svg
    class={className}
    data-folder-icon="persona-hub"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- lucide "users" (ISC) -->
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <path d="M16 3.128a4 4 0 0 1 0 7.744" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <circle cx="9" cy="7" r="4" />
  </svg>
{/if}
