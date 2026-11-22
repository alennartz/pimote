<script lang="ts">
  import type { AppInfo } from '@pimote/shared';
  import { appIconLetter, iconCandidates } from '$lib/app-icon.js';

  interface Props {
    app: AppInfo;
    class?: string;
  }

  let { app, class: sizeClass = 'size-12' }: Props = $props();

  let candidates = $derived(iconCandidates(app));
  let index = $state(0);
  let letter = $derived(appIconLetter(app.title));

  $effect(() => {
    void candidates;
    index = 0;
  });
</script>

{#if index < candidates.length}
  <img
    src={candidates[index]}
    alt=""
    loading="lazy"
    class="{sizeClass} bg-card border-border rounded-xl border object-contain p-0.5"
    onerror={() => {
      index += 1;
    }}
  />
{:else}
  <span
    class="{sizeClass} bg-muted text-muted-foreground border-border flex items-center justify-center overflow-hidden rounded-xl border text-lg font-semibold"
    aria-hidden="true"
  >
    {letter}
  </span>
{/if}
