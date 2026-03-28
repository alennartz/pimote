<script lang="ts">
	import { tick, onMount } from 'svelte';
	import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
	import Message from './Message.svelte';
	import TextBlock from './TextBlock.svelte';
	import ThinkingBlock from './ThinkingBlock.svelte';
	import ToolCall from './ToolCall.svelte';
	import StreamingIndicator from './StreamingIndicator.svelte';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';

	let scrollContainer: HTMLDivElement | undefined = $state();
	let userScrolledUp = $state(false);
	let autoScrollEnabled = $state(true);

	// Track whether user has scrolled away from bottom
	function onScroll() {
		if (!scrollContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
		// Consider "at bottom" if within 80px
		const atBottom = distanceFromBottom < 80;
		userScrolledUp = !atBottom;
		if (atBottom) {
			autoScrollEnabled = true;
		}
	}

	// Auto-scroll when new content arrives
	$effect(() => {
		// Access reactive deps to trigger on changes
		sessionRegistry.viewed?.messages;
		sessionRegistry.viewed?.streamingText;
		sessionRegistry.viewed?.streamingThinking;
		sessionRegistry.viewed?.activeToolCalls;

		if (autoScrollEnabled && scrollContainer) {
			tick().then(() => {
				if (scrollContainer && autoScrollEnabled) {
					scrollContainer.scrollTop = scrollContainer.scrollHeight;
				}
			});
		}
	});

	function scrollToBottom() {
		if (scrollContainer) {
			autoScrollEnabled = true;
			scrollContainer.scrollTop = scrollContainer.scrollHeight;
		}
	}

	// Derived: do we have any streaming content to show?
	let hasStreamingContent = $derived(
		(sessionRegistry.viewed?.isStreaming ?? false) &&
			((sessionRegistry.viewed?.streamingText ?? '').length > 0 ||
				(sessionRegistry.viewed?.streamingThinking ?? '').length > 0 ||
				Object.keys(sessionRegistry.viewed?.activeToolCalls ?? {}).length > 0)
	);

	let activeToolEntries = $derived(Object.entries(sessionRegistry.viewed?.activeToolCalls ?? {}));
</script>

<div class="message-list-wrapper">
	<div class="message-list" bind:this={scrollContainer} onscroll={onScroll}>
		<div class="message-list-inner">
			{#if (sessionRegistry.viewed?.messages ?? []).length === 0 && !sessionRegistry.viewed?.isStreaming}
				<div class="empty-state">
					<p>No messages yet</p>
				</div>
			{/if}

			{#each sessionRegistry.viewed?.messages ?? [] as message, i (i)}
				<Message {message} />
			{/each}

			<!-- Streaming content (in-progress) -->
			{#if hasStreamingContent}
				<div class="message assistant-message streaming">
					<div class="streaming-body">
						{#if sessionRegistry.viewed?.streamingThinking}
							<ThinkingBlock text={sessionRegistry.viewed.streamingThinking} streaming={true} />
						{/if}

						{#each activeToolEntries as [toolCallId, tool] (toolCallId)}
							<ToolCall
								content={{
									type: 'tool_call',
									toolCallId,
									toolName: tool.name,
									args: tool.args,
								}}
								inProgress={true}
								partialResult={tool.partialResult}
							/>
						{/each}

						{#if sessionRegistry.viewed?.streamingText}
							<TextBlock text={sessionRegistry.viewed.streamingText} streaming={true} />
						{/if}
					</div>
				</div>
			{/if}

			<!-- Streaming indicator (agent is working but no content yet) -->
			{#if sessionRegistry.viewed?.isStreaming && !hasStreamingContent}
				<div class="streaming-indicator-row">
					<StreamingIndicator />
				</div>
			{/if}
		</div>
	</div>

	<!-- Scroll to bottom button -->
	{#if userScrolledUp}
		<button class="scroll-to-bottom" onclick={scrollToBottom}>
			<ArrowDown size={18} />
		</button>
	{/if}
</div>

<style>
	.message-list-wrapper {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.message-list {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		scroll-behavior: auto;
	}

	.message-list-inner {
		max-width: 768px;
		margin: 0 auto;
		padding: 16px 16px 24px;
	}

	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 48px 16px;
		color: var(--muted-foreground);
		font-size: 0.9rem;
	}

	.streaming {
		display: flex;
		gap: 10px;
		padding: 12px 0;
	}

	.streaming-body {
		flex: 1;
		min-width: 0;
		font-size: 0.9rem;
		/* Give left margin to align with assistant message bodies (icon width + gap) */
		margin-left: 38px;
	}

	.streaming-indicator-row {
		padding: 4px 0 4px 38px;
	}

	.scroll-to-bottom {
		position: absolute;
		bottom: 16px;
		left: 50%;
		transform: translateX(-50%);
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--secondary);
		color: var(--secondary-foreground);
		border: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		box-shadow: 0 2px 8px oklch(0 0 0 / 0.3);
		transition:
			background-color 0.15s,
			transform 0.15s;
		z-index: 10;
	}

	.scroll-to-bottom:hover {
		background: var(--accent);
		transform: translateX(-50%) scale(1.05);
	}

	.scroll-to-bottom:active {
		transform: translateX(-50%) scale(0.95);
	}
</style>
