<script lang="ts">
  import type { PimoteAgentMessage, StreamingMessage } from '@pimote/shared';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import TextBlock from './TextBlock.svelte';
  import ThinkingBlock from './ThinkingBlock.svelte';
  import ToolCall from './ToolCall.svelte';
  import StreamingCollapsible from './StreamingCollapsible.svelte';
  import User from '@lucide/svelte/icons/user';
  import Bot from '@lucide/svelte/icons/bot';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  const MAX_COLLAPSED_LINES = 10;

  let { message, streaming = false }: { message: PimoteAgentMessage | StreamingMessage; streaming?: boolean } = $props();
  let customExpanded = $state(false);

  function getUserText(msg: PimoteAgentMessage | StreamingMessage): string {
    return msg.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
  }

  let customText = $derived(getUserText(message));
  let customLines = $derived(customText.split('\n'));
  let customNeedsCollapse = $derived(customLines.length > MAX_COLLAPSED_LINES);
</script>

{#if message.role === 'toolResult'}
  <!-- Tool results are displayed inline with their tool calls — skip standalone rendering -->
{:else if message.role === 'user'}
  <div class="message user-message">
    <div class="message-icon user-icon">
      <User size={16} />
    </div>
    <div class="message-body user-body">
      <div class="user-text">{getUserText(message)}</div>
    </div>
  </div>
{:else if message.role === 'assistant'}
  {@const toolExecs = sessionRegistry.viewed?.toolExecutions ?? {}}
  <div class="message assistant-message">
    <div class="message-icon assistant-icon">
      <Bot size={16} />
    </div>
    <div class="message-body">
      {#each message.content as block, i (i)}
        {@const blockStreaming = block.streaming ?? false}
        {#if block.type === 'text'}
          <TextBlock text={block.text ?? ''} streaming={blockStreaming} />
        {:else if block.type === 'thinking'}
          <ThinkingBlock text={block.text ?? ''} streaming={blockStreaming} />
        {:else if block.type === 'tool_call'}
          {@const exec = block.toolCallId ? toolExecs[block.toolCallId] : undefined}
          <ToolCall
            content={block}
            streaming={blockStreaming}
            inProgress={exec?.status === 'running'}
            partialResult={exec?.partialResult ?? ''}
            result={exec?.status === 'completed' ? exec.result : undefined}
          />
        {:else if block.type === 'tool_result'}
          <ToolCall content={block} />
        {/if}
      {/each}
    </div>
  </div>
{:else if message.role === 'custom'}
  <!-- Custom message (extension-injected, e.g. subagent results) -->
  <div class="message custom-message">
    <div class="custom-body">
      {#if streaming}
        <div class="custom-header">
          <span class="custom-label">[custom]</span>
        </div>
        <div class="custom-content">
          <StreamingCollapsible text={customText} {streaming} accent="purple" />
        </div>
      {:else}
        <button class="custom-header" onclick={() => (customExpanded = !customExpanded)}>
          {#if customNeedsCollapse}
            {#if customExpanded}
              <ChevronDown size={14} />
            {:else}
              <ChevronRight size={14} />
            {/if}
          {/if}
          <span class="custom-label">[{'customType' in message ? (message.customType ?? 'custom') : 'custom'}]</span>
          {#if customNeedsCollapse}
            <span class="custom-line-count">{customLines.length} lines</span>
          {/if}
        </button>
        <div class="custom-content">
          <div
            class="custom-text-container"
            class:custom-text-collapsed={customNeedsCollapse && !customExpanded}
            class:custom-text-expanded={customNeedsCollapse && customExpanded}
          >
            <TextBlock text={customText} />
          </div>
          {#if customNeedsCollapse && !customExpanded}
            <button class="custom-toggle" onclick={() => (customExpanded = true)}> Show more… </button>
          {:else if customNeedsCollapse && customExpanded}
            <button class="custom-toggle" onclick={() => (customExpanded = false)}> Show less </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{:else}
  <!-- System or other role messages -->
  <div class="message system-message">
    <div class="message-body">
      <div class="system-text">{getUserText(message)}</div>
    </div>
  </div>
{/if}

<style>
  .message {
    display: flex;
    gap: 10px;
    padding: 12px 0;
  }

  .message-icon {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 2px;
  }

  .user-icon {
    background: oklch(0.35 0.08 250);
    color: oklch(0.85 0.05 250);
  }

  .assistant-icon {
    background: oklch(0.28 0.04 260);
    color: var(--foreground);
  }

  .message-body {
    flex: 1;
    min-width: 0;
    font-size: 0.9rem;
  }

  .user-body {
    background: oklch(0.22 0.04 260);
    padding: 10px 14px;
    border-radius: 12px;
    border-top-left-radius: 4px;
  }

  .user-text {
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.5;
  }

  .system-message {
    justify-content: center;
    padding: 8px 0;
  }

  .system-message .message-body {
    text-align: center;
  }

  .system-text {
    font-size: 0.8rem;
    color: var(--muted-foreground);
    font-style: italic;
  }

  .custom-message {
    flex-direction: column;
    gap: 0;
    padding: 8px 0;
  }

  .custom-body {
    border-left: 3px solid oklch(0.55 0.1 280);
    background: oklch(0.2 0.02 270 / 0.5);
    border-radius: 4px;
    overflow: hidden;
  }

  .custom-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    cursor: pointer;
    color: oklch(0.7 0.1 280);
    font-size: 0.75rem;
    font-weight: 600;
    text-align: left;
  }

  .custom-header:hover {
    background: oklch(0.25 0.02 270 / 0.5);
  }

  .custom-label {
    font-family: var(--font-mono, monospace);
  }

  .custom-line-count {
    color: var(--muted-foreground);
    font-weight: 400;
  }

  .custom-content {
    padding: 0 10px 8px;
    font-size: 0.85rem;
  }

  .custom-text-container {
    position: relative;
  }

  .custom-text-collapsed {
    max-height: 200px;
    overflow: hidden;
  }

  .custom-text-collapsed::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 48px;
    pointer-events: none;
    background: linear-gradient(to bottom, oklch(0.2 0.02 270 / 0), oklch(0.2 0.02 270 / 0.95));
  }

  .custom-text-expanded {
    max-height: 500px;
    overflow-y: auto;
  }

  .custom-toggle {
    display: inline-block;
    margin-top: 4px;
    padding: 0;
    background: none;
    border: none;
    color: oklch(0.65 0.1 280);
    font-size: 0.75rem;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .custom-toggle:hover {
    color: oklch(0.75 0.1 280);
  }
</style>
