<script lang="ts">
  import { panelStore } from '$lib/stores/panel-store.svelte.js';
  import type { CardColor } from '@pimote/shared';

  const colorMap: Record<CardColor, string> = {
    accent: 'border-l-primary',
    success: 'border-l-green-500',
    warning: 'border-l-yellow-500',
    error: 'border-l-red-500',
    muted: 'border-l-muted-foreground',
  };
</script>

<div class="bg-sidebar flex h-full w-70 flex-col overflow-y-auto border-l p-2">
  <div class="flex flex-col gap-2">
    {#each panelStore.cards as card (card.id)}
      {@const baseClass = `rounded border p-2 ${card.color ? colorMap[card.color] + ' border-l-2' : ''}`}
      {#snippet cardBody()}
        <!-- Header -->
        <div class="flex items-center gap-1.5">
          <span class="truncate text-sm font-medium">{card.header.title}</span>
          {#if card.header.tag}
            <span class="bg-muted text-muted-foreground ml-auto shrink-0 rounded px-1 text-xs">{card.header.tag}</span>
          {/if}
        </div>

        <!-- Body -->
        {#if card.body && card.body.length > 0}
          <div class="mt-1.5 flex flex-col gap-0.5">
            {#each card.body as section, i (i)}
              {#if section.style === 'code'}
                <span class="bg-muted rounded px-1 font-mono text-xs break-words whitespace-pre-wrap">{section.content}</span>
              {:else if section.style === 'secondary'}
                <span class="text-muted-foreground text-xs break-words whitespace-pre-wrap">{section.content}</span>
              {:else}
                <span class="text-foreground text-xs break-words whitespace-pre-wrap">{section.content}</span>
              {/if}
            {/each}
          </div>
        {/if}

        <!-- Footer -->
        {#if card.footer && card.footer.length > 0}
          <div class="text-muted-foreground mt-1.5 text-xs">
            {card.footer.join(' · ')}
          </div>
        {/if}
      {/snippet}
      {#if card.href}
        <!-- card.href targets the server-hosted /s/<slug>/ route, not a SPA route, so resolve() does not apply. -->
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
        <a href={card.href} class="{baseClass} text-foreground hover:bg-accent/50 block no-underline transition-colors">
          {@render cardBody()}
        </a>
      {:else}
        <div class={baseClass}>
          {@render cardBody()}
        </div>
      {/if}
    {/each}
  </div>
</div>
