<script lang="ts">
  import type { Card, CardColor } from '@pimote/shared';

  let { cards, openInNewTab = false }: { cards: Card[]; openInNewTab?: boolean } = $props();

  const colorMap: Record<CardColor, string> = {
    accent: 'border-l-primary',
    success: 'border-l-green-500',
    warning: 'border-l-yellow-500',
    error: 'border-l-red-500',
    muted: 'border-l-muted-foreground',
  };
</script>

<div class="flex flex-col gap-2">
  {#each cards as card (card.id)}
    {@const baseClass = `rounded border p-2 ${card.color ? colorMap[card.color] + ' border-l-2' : ''}`}
    {#snippet cardBody()}
      <div class="flex items-center gap-1.5">
        <span class="truncate text-sm font-medium">{card.header.title}</span>
        {#if card.header.tag}
          <span class="bg-muted text-muted-foreground ml-auto shrink-0 rounded px-1 text-xs">{card.header.tag}</span>
        {/if}
      </div>
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
      {#if card.footer && card.footer.length > 0}
        <div class="text-muted-foreground mt-1.5 text-xs">{card.footer.join(' · ')}</div>
      {/if}
    {/snippet}
    {#if card.href}
      <!-- Cards target server-hosted resources, not SPA routes. -->
      <!-- eslint-disable svelte/no-navigation-without-resolve -->
      <a
        href={card.href}
        target={openInNewTab ? '_blank' : undefined}
        rel={openInNewTab ? 'noopener noreferrer' : undefined}
        class="{baseClass} text-foreground hover:bg-accent/50 block no-underline transition-colors"
      >
        {@render cardBody()}
        {#if openInNewTab}<span class="sr-only"> (opens in a new tab)</span>{/if}
      </a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {:else}
      <div class={baseClass}>{@render cardBody()}</div>
    {/if}
  {/each}
</div>
