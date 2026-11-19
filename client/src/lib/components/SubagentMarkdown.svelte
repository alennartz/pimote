<script lang="ts">
  import CodeBlock from './CodeBlock.svelte';

  let {
    label,
    text,
    streaming = false,
  }: {
    label?: string;
    text: string | undefined;
    streaming?: boolean;
  } = $props();
</script>

{#if text !== undefined}
  <section class="subagent-text-section" aria-label={label}>
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
</style>
