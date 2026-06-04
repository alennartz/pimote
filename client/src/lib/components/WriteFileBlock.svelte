<script lang="ts">
  /**
   * Renders a `write` tool's file body inside collapsible, copyable chrome, in
   * one of two modes:
   *
   *   - `code`     — syntax-highlighted `<pre><code>` via `code-highlight.ts`
   *                  (throttled while `streaming`, flushed when it ends).
   *   - `markdown` — rendered through `TextBlock` (which inherits incremental
   *                  fenced-code highlighting for free).
   *
   * Owns the collapse + copy chrome and the auto-expand-while-streaming /
   * auto-collapse-on-completion behavior for both modes. In both modes the
   * copy button copies `content` verbatim (raw source, never rendered text),
   * and a show-more/collapse wrapper bounds long files.
   *
   * Interface stub — implementation lands in a later phase.
   */
  let {
    content,
    mode,
    language,
    streaming = false,
  }: {
    /** File body (streaming or finalized). */
    content: string;
    /** Render strategy. */
    mode: 'code' | 'markdown';
    /** hljs language id used in 'code' mode. */
    language: string | null;
    /** Drives throttled highlight + auto-scroll while true. */
    streaming?: boolean;
  } = $props();
</script>

<!-- Interface stub: real chrome (collapse + copy + render) lands in implementation. -->
<div class="write-file-block" data-mode={mode} data-streaming={streaming} data-language={language}>{content}</div>
