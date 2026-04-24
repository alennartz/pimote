<script lang="ts">
  import type { PimoteAgentMessage, StreamingMessage } from '@pimote/shared';
  import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
  import TextBlock from './TextBlock.svelte';
  import ThinkingBlock from './ThinkingBlock.svelte';
  import ToolCall from './ToolCall.svelte';
  import StreamingCollapsible from './StreamingCollapsible.svelte';
  import TtsButton from './TtsButton.svelte';
  import User from '@lucide/svelte/icons/user';
  import Bot from '@lucide/svelte/icons/bot';
  import GitFork from '@lucide/svelte/icons/git-fork';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleSlash from '@lucide/svelte/icons/circle-slash';

  const MAX_COLLAPSED_LINES = 10;
  const SKILL_COLLAPSED_LINES = 3;

  let {
    message,
    streaming = false,
    messageKey = '',
    onfork,
  }: { message: PimoteAgentMessage | StreamingMessage; streaming?: boolean; messageKey?: string; onfork?: (entryId: string) => void } = $props();
  let userMenuOpen = $state(false);
  let customExpanded = $state(false);
  let skillExpanded = $state(false);
  let toolMenuOpen = $state(false);

  let hasSpeakableText = $derived(message.role === 'assistant' && !streaming && message.content.some((c) => c.type === 'text' && c.text));

  // An assistant turn cancelled by session.abort() (e.g. a voice-mode barge-in
  // produces one per interrupt). `aborted` comes from the wire; the server-side
  // message-mapper sets it when pi-agent-core tags the turn with
  // stopReason: 'aborted'.
  let isAbortedAssistant = $derived(message.role === 'assistant' && (message as PimoteAgentMessage).aborted === true);
  let abortedIsEmpty = $derived(
    isAbortedAssistant &&
      message.content.every(
        (c) => (c.type === 'text' && (!c.text || c.text.length === 0)) || (c.type !== 'text' && c.type !== 'tool_call' && c.type !== 'tool_result' && c.type !== 'thinking'),
      ),
  );

  let textContent = $derived(
    message.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n\n'),
  );

  function getUserText(msg: PimoteAgentMessage | StreamingMessage): string {
    return msg.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
  }

  /** Parse a skill block from user message text. Returns null if no skill block found. */
  function parseSkillBlock(text: string): { name: string; body: string; after: string } | null {
    const match = text.match(/^<skill\s+name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/skill>\s*([\s\S]*)$/);
    if (!match) return null;
    return { name: match[1], body: match[2], after: match[3].trim() };
  }

  let entryId = $derived('entryId' in message && typeof message.entryId === 'string' ? message.entryId : undefined);
  let userText = $derived(getUserText(message));
  let skillBlock = $derived(message.role === 'user' ? parseSkillBlock(userText) : null);
  let skillLines = $derived(skillBlock ? skillBlock.body.split('\n') : []);
  let skillNeedsCollapse = $derived(skillLines.length > SKILL_COLLAPSED_LINES);

  let customText = $derived(getUserText(message));
  let customLines = $derived(customText.split('\n'));
  let customNeedsCollapse = $derived(customLines.length > MAX_COLLAPSED_LINES);
</script>

{#if message.role === 'toolResult'}
  <!-- Tool results are displayed inline with their tool calls — skip standalone rendering -->
{:else if message.role === 'user'}
  <div class="message user-message">
    {#if entryId}
      <div class="user-icon-col">
        <button class="message-icon user-icon" onclick={() => (userMenuOpen = !userMenuOpen)}>
          <User size={16} />
        </button>
        {#if userMenuOpen}
          <div class="tool-menu">
            <button
              class="fork-btn"
              onclick={() => {
                onfork?.(entryId!);
                userMenuOpen = false;
              }}
              title="Fork from this message"
            >
              <GitFork size={16} />
            </button>
          </div>
        {/if}
      </div>
    {:else}
      <div class="message-icon user-icon">
        <User size={16} />
      </div>
    {/if}
    <div class="message-body">
      {#if skillBlock}
        <!-- Skill-expanded user message: collapsible skill block + optional user text -->
        <div class="skill-body">
          <button class="skill-header" onclick={() => (skillExpanded = !skillExpanded)}>
            {#if skillNeedsCollapse}
              {#if skillExpanded}
                <ChevronDown size={14} />
              {:else}
                <ChevronRight size={14} />
              {/if}
            {/if}
            <span class="skill-label">[skill: {skillBlock.name}]</span>
            {#if skillNeedsCollapse}
              <span class="skill-line-count">{skillLines.length} lines</span>
            {/if}
          </button>
          <div class="skill-content">
            <div class="skill-text-container" class:skill-text-collapsed={skillNeedsCollapse && !skillExpanded} class:skill-text-expanded={skillNeedsCollapse && skillExpanded}>
              <TextBlock text={skillBlock.body} />
            </div>
            {#if skillNeedsCollapse && !skillExpanded}
              <button class="skill-toggle" onclick={() => (skillExpanded = true)}>Show more…</button>
            {:else if skillNeedsCollapse && skillExpanded}
              <button class="skill-toggle" onclick={() => (skillExpanded = false)}>Show less</button>
            {/if}
          </div>
        </div>
        {#if skillBlock.after}
          <div class="user-body skill-after">
            <div class="user-text">{skillBlock.after}</div>
          </div>
        {/if}
      {:else}
        <div class="user-body">
          <div class="user-text">{userText}</div>
        </div>
      {/if}
    </div>
  </div>
{:else if message.role === 'assistant'}
  {@const toolExecs = sessionRegistry.viewed?.toolExecutions ?? {}}
  {#if abortedIsEmpty}
    <!-- Empty aborted turn — compact "interrupted" indicator instead of a blank assistant bubble. -->
    <div class="message aborted-indicator text-muted-foreground flex items-center gap-2 px-2 py-1 text-xs italic">
      <CircleSlash size={12} />
      <span>interrupted</span>
    </div>
  {:else}
    <div class="message assistant-message {isAbortedAssistant ? 'aborted' : ''}">
      <div class="assistant-icon-col">
        {#if hasSpeakableText}
          <button class="message-icon assistant-icon" onclick={() => (toolMenuOpen = !toolMenuOpen)}>
            <Bot size={16} />
          </button>
          {#if toolMenuOpen}
            <div class="tool-menu">
              <TtsButton {messageKey} {textContent} />
            </div>
          {/if}
        {:else}
          <div class="message-icon assistant-icon">
            <Bot size={16} />
          </div>
        {/if}
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
              isError={exec?.isError}
            />
          {:else if block.type === 'tool_result'}
            <ToolCall content={block} />
          {/if}
        {/each}
        {#if isAbortedAssistant}
          <div class="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs italic opacity-70">
            <CircleSlash size={12} />
            <span>interrupted</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}
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
  }

  .user-icon {
    margin-top: 2px;
    background: oklch(0.35 0.08 250);
    color: oklch(0.85 0.05 250);
  }

  button.user-icon {
    border: none;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  button.user-icon:active {
    background: oklch(0.42 0.08 250);
  }

  .user-icon-col {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
  }

  .fork-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: oklch(0.28 0.04 260);
    color: var(--foreground);
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .fork-btn:hover {
    background: oklch(0.35 0.04 260);
  }

  .assistant-icon {
    background: oklch(0.28 0.04 260);
    color: var(--foreground);
  }

  button.assistant-icon {
    border: none;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  button.assistant-icon:active {
    background: oklch(0.35 0.04 260);
  }

  .assistant-icon-col {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
  }

  .tool-menu {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
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

  /* ---- Skill block (inside user messages) ---- */

  .skill-body {
    border-left: 3px solid oklch(0.55 0.12 170);
    background: oklch(0.2 0.02 170 / 0.5);
    border-radius: 4px;
    overflow: hidden;
  }

  .skill-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    cursor: pointer;
    color: oklch(0.7 0.12 170);
    font-size: 0.75rem;
    font-weight: 600;
    text-align: left;
  }

  .skill-header:hover {
    background: oklch(0.25 0.02 170 / 0.5);
  }

  .skill-label {
    font-family: var(--font-mono, monospace);
  }

  .skill-line-count {
    color: var(--muted-foreground);
    font-weight: 400;
  }

  .skill-content {
    padding: 0 10px 8px;
    font-size: 0.85rem;
  }

  .skill-text-container {
    position: relative;
  }

  .skill-text-collapsed {
    max-height: 65px;
    overflow: hidden;
  }

  .skill-text-collapsed::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 32px;
    pointer-events: none;
    background: linear-gradient(to bottom, oklch(0.2 0.02 170 / 0), oklch(0.2 0.02 170 / 0.95));
  }

  .skill-text-expanded {
    max-height: 500px;
    overflow-y: auto;
  }

  .skill-toggle {
    display: inline-block;
    margin-top: 4px;
    padding: 0;
    background: none;
    border: none;
    color: oklch(0.65 0.12 170);
    font-size: 0.75rem;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .skill-toggle:hover {
    color: oklch(0.75 0.12 170);
  }

  .skill-after {
    margin-top: 6px;
  }

  /* ---- Custom messages ---- */

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
