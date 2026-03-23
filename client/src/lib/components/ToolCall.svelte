<script lang="ts">
	import type { PimoteMessageContent } from '@pimote/shared';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Wrench from '@lucide/svelte/icons/wrench';
	import CheckCircle from '@lucide/svelte/icons/check-circle-2';
	import Loader2 from '@lucide/svelte/icons/loader-2';

	let {
		content,
		inProgress = false,
		partialResult = '',
	}: {
		content: PimoteMessageContent;
		inProgress?: boolean;
		partialResult?: string;
	} = $props();

	let expanded = $state(false);

	let toolName = $derived(content.toolName ?? 'unknown');
	let isResult = $derived(content.type === 'tool_result');

	function formatData(data: unknown): string {
		if (data === undefined || data === null) return '';
		if (typeof data === 'string') return data;
		try {
			return JSON.stringify(data, null, 2);
		} catch {
			return String(data);
		}
	}

	let argsText = $derived(formatData(content.args));
	let resultText = $derived(isResult ? formatData(content.result) : partialResult);
</script>

<div class="tool-block" class:tool-result={isResult} class:in-progress={inProgress}>
	<button class="tool-header" onclick={() => (expanded = !expanded)}>
		<ChevronRight
			class="shrink-0 transition-transform duration-150 {expanded ? 'rotate-90' : ''}"
			size={14}
		/>
		{#if inProgress}
			<Loader2 size={14} class="shrink-0 animate-spin" />
		{:else if isResult}
			<CheckCircle size={14} class="shrink-0" />
		{:else}
			<Wrench size={14} class="shrink-0" />
		{/if}
		<span class="tool-name">{toolName}</span>
		{#if inProgress}
			<span class="tool-status">running…</span>
		{:else if isResult}
			<span class="tool-status">completed</span>
		{/if}
	</button>

	{#if expanded}
		<div class="tool-content">
			{#if content.type === 'tool_call' && argsText}
				<div class="tool-section">
					<div class="tool-section-label">Arguments</div>
					<pre class="tool-data">{argsText}</pre>
				</div>
			{/if}

			{#if isResult && resultText}
				<div class="tool-section">
					<div class="tool-section-label">Result</div>
					<pre class="tool-data">{resultText}</pre>
				</div>
			{/if}

			{#if inProgress && partialResult}
				<div class="tool-section">
					<div class="tool-section-label">Output (streaming)</div>
					<pre class="tool-data">{partialResult}</pre>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.tool-block {
		margin: 0.25em 0;
		border-radius: 6px;
		border: 1px solid var(--border);
		overflow: hidden;
	}

	.tool-header {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 10px;
		background: oklch(0.18 0.025 258);
		color: var(--muted-foreground);
		font-size: 0.8rem;
		cursor: pointer;
		border: none;
		text-align: left;
		transition: background-color 0.15s;
	}

	.tool-header:hover {
		background: oklch(0.22 0.03 258);
	}

	.tool-name {
		font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
		font-weight: 500;
		color: var(--foreground);
	}

	.tool-status {
		margin-left: auto;
		font-size: 0.75rem;
		font-style: italic;
		opacity: 0.7;
	}

	.tool-content {
		border-top: 1px solid var(--border);
		background: oklch(0.15 0.02 258);
	}

	.tool-section {
		padding: 6px 12px;
	}

	.tool-section + .tool-section {
		border-top: 1px solid var(--border);
	}

	.tool-section-label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-foreground);
		margin-bottom: 4px;
		font-weight: 500;
	}

	.tool-data {
		margin: 0;
		white-space: pre-wrap;
		word-wrap: break-word;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--foreground);
		font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
		max-height: 300px;
		overflow-y: auto;
	}

	.in-progress .tool-header {
		background: oklch(0.18 0.035 258);
	}

	.tool-result .tool-header :global(svg) {
		color: var(--status-connected, oklch(0.623 0.169 149.2));
	}
</style>
