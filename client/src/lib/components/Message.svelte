<script lang="ts">
	import type { PimoteAgentMessage } from '@pimote/shared';
	import TextBlock from './TextBlock.svelte';
	import ThinkingBlock from './ThinkingBlock.svelte';
	import ToolCall from './ToolCall.svelte';
	import User from '@lucide/svelte/icons/user';
	import Bot from '@lucide/svelte/icons/bot';

	let { message }: { message: PimoteAgentMessage } = $props();

	function getUserText(msg: PimoteAgentMessage): string {
		return msg.content
			.filter((c) => c.type === 'text' && c.text)
			.map((c) => c.text!)
			.join('\n');
	}
</script>

{#if message.role === 'user'}
	<div class="message user-message">
		<div class="message-icon user-icon">
			<User size={16} />
		</div>
		<div class="message-body user-body">
			<div class="user-text">{getUserText(message)}</div>
		</div>
	</div>
{:else if message.role === 'assistant'}
	<div class="message assistant-message">
		<div class="message-icon assistant-icon">
			<Bot size={16} />
		</div>
		<div class="message-body">
			{#each message.content as block}
				{#if block.type === 'text' && block.text}
					<TextBlock text={block.text} />
				{:else if block.type === 'thinking' && block.text}
					<ThinkingBlock text={block.text} />
				{:else if block.type === 'tool_call'}
					<ToolCall content={block} />
				{:else if block.type === 'tool_result'}
					<ToolCall content={block} />
				{/if}
			{/each}
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
</style>
