<script lang="ts">
  import TextBlock from './TextBlock.svelte';

  let { value, streaming = false }: { value: unknown; streaming?: boolean } = $props();

  function fieldLabel(field: string): string {
    if (field === 'cwd') return 'Working directory';
    const words = field
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .replace(/\bids?\b/g, (word) => (word === 'ids' ? 'IDs' : 'ID'));
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function isMetadata(field: string): boolean {
    return (
      /^(id|ids|path|paths|to|from|agent|agents|state|phase|status|model|provider|persona|cwd|channels|incarnation|thinkingLevel|reason|source|kind|type|name)$/.test(field) ||
      /(Id|Ids|Path|Paths)$/.test(field)
    );
  }

  function isPath(value: unknown, field: string): value is readonly string[] {
    return /^(path|to|from|agent|parentPath)$/.test(field) && Array.isArray(value) && value.every((part) => typeof part === 'string');
  }

  function itemField(field: string): string {
    return /^(agents|paths|waitingFor)$/.test(field) || field.endsWith('Paths') ? 'path' : field;
  }
</script>

{#snippet renderValue(data: unknown, field: string)}
  {#if data === null || data === undefined}
    <span class="data-empty">None</span>
  {:else if isPath(data, field)}
    <span class="data-metadata">{data.length > 0 ? data.join('/') : 'root'}</span>
  {:else if Array.isArray(data)}
    {#if data.length === 0}
      <span class="data-empty">None</span>
    {:else}
      <ul class="data-list" role="list">
        {#each data as item, index (index)}
          <li>{@render renderValue(item, itemField(field))}</li>
        {/each}
      </ul>
    {/if}
  {:else if typeof data === 'object'}
    {@const entries = Object.entries(data)}
    {#if entries.length === 0}
      <span class="data-empty">None</span>
    {:else}
      <dl class="data-fields">
        {#each entries as [key, item] (key)}
          <div class="data-field">
            <dt>{fieldLabel(key)}</dt>
            <dd aria-label={fieldLabel(key)}>{@render renderValue(item, key)}</dd>
          </div>
        {/each}
      </dl>
    {/if}
  {:else if typeof data === 'string' && !isMetadata(field)}
    {#if data.length === 0}
      <span class="data-empty">Empty</span>
    {:else}
      {#key streaming ? null : data}
        <TextBlock text={data} {streaming} />
      {/key}
    {/if}
  {:else}
    <span class="data-metadata">{String(data) || 'Empty'}</span>
  {/if}
{/snippet}

{@render renderValue(value, '')}

<style>
  .data-fields,
  .data-list {
    min-width: 0;
    margin: 0;
  }

  .data-field + .data-field {
    margin-top: 0.65rem;
  }

  .data-field dt {
    margin-bottom: 0.15rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .data-field dd {
    min-width: 0;
    margin: 0;
  }

  .data-list {
    padding-left: 0.65rem;
    border-left: 1px solid var(--border);
    list-style: none;
  }

  .data-list li + li {
    margin-top: 0.65rem;
    padding-top: 0.65rem;
    border-top: 1px solid var(--border);
  }

  .data-metadata,
  .data-empty {
    font-size: 0.8rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .data-empty {
    color: var(--muted-foreground);
  }
</style>
