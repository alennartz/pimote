<script lang="ts">
  /**
   * Renders an edit tool's `{ oldText, newText }[]` as a `<pre><code>`
   * block styled identically to what highlight.js produces for the
   * `diff` language. The key advantage over routing through
   * streaming-markdown + hljs-on-close is that each `-`/`+` line gets
   * its background color the instant it arrives — no waiting for a
   * closing code fence.
   *
   * Visual parity with hljs: emits `<pre><code class="hljs language-diff">`
   * with one `<span class="hljs-deletion">` or `<span class="hljs-addition">`
   * per line, lines separated by `\n` text nodes. The existing rules in
   * `$lib/highlight-theme.css` style those classes.
   *
   * Multiple edits render as separate `<pre>` blocks stacked with a gap,
   * matching the previous two-block-with-blank-line layout.
   */
  import { buildEditLines, type EditEntry } from '$lib/edit-diff.js';
  import '$lib/highlight-theme.css';

  let { entries }: { entries: ReadonlyArray<EditEntry> } = $props();
</script>

{#each entries as entry, i (i)}
  {#if i > 0}
    <div class="edit-diff-gap"></div>
  {/if}
  {@const lines = buildEditLines(entry)}
  <pre class="edit-diff"><code class="hljs language-diff"
      >{#each lines as line, j (j)}<span class={`hljs-${line.kind}`}>{line.text}</span>{#if j < lines.length - 1}{/if}{/each}</code
    ></pre>
{/each}

<style>
  .edit-diff {
    margin: 0;
    border-radius: 8px;
    overflow: hidden;
    background: oklch(0.16 0.03 258);
    border: 1px solid var(--border);
    padding: 12px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .edit-diff code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: 0.875em;
    font-family: var(--font-mono);
    line-height: 1.5;
    white-space: pre;
    display: block;
  }

  .edit-diff-gap {
    height: 0.75em;
  }
</style>
