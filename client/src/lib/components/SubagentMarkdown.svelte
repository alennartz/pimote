<script lang="ts">
  import CodeBlock from './CodeBlock.svelte';

  let {
    label,
    text,
    streaming = false,
    separated = false,
  }: {
    label?: string;
    text: string | undefined;
    streaming?: boolean;
    separated?: boolean;
  } = $props();
</script>

{#if text !== undefined}
  <section class="subagent-text-section" class:subagent-text-section-separated={separated} aria-label={label}>
    {#key streaming ? label : `${label}:${text}`}
      <CodeBlock content={text} mode="markdown" language={null} {streaming} />
    {/key}
  </section>
{/if}

<style>
  .subagent-text-section {
    min-width: 0;
    margin-top: 0.55rem;
  }

  .subagent-text-section-separated {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }
</style>
