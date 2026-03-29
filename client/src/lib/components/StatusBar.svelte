<script lang="ts">
	import ModelPicker from './ModelPicker.svelte';
	import ThinkingPicker from './ThinkingPicker.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
	import { connection } from '$lib/stores/connection.svelte.js';
	import { X, GitBranch } from '@lucide/svelte';

	function closeSession() {
		const id = sessionRegistry.viewedSessionId;
		if (id) {
			connection.send({ type: 'close_session', sessionId: id });
		}
	}

	let connectionLabel = $derived(
		connection.status === 'connected'
			? 'Connected'
			: connection.status === 'reconnecting'
				? 'Reconnecting…'
				: connection.status === 'connecting'
					? 'Connecting…'
					: 'Disconnected'
	);

	let connectionColor = $derived(
		connection.status === 'connected'
			? 'bg-emerald-500'
			: connection.status === 'reconnecting'
				? 'bg-amber-500'
				: 'bg-red-500'
	);

	let contextPercent = $derived(sessionRegistry.viewed?.contextUsage?.percent);
	let contextWindow = $derived(sessionRegistry.viewed?.contextUsage?.contextWindow ?? 0);

	function formatTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
		return `${n}`;
	}

	let contextDisplay = $derived(
		contextPercent != null
			? `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`
			: contextWindow > 0
				? `?/${formatTokens(contextWindow)}`
				: null
	);

	let contextColor = $derived(
		contextPercent != null && contextPercent > 90
			? 'text-red-400'
			: contextPercent != null && contextPercent > 70
				? 'text-amber-400'
				: 'text-muted-foreground'
	);
</script>

<div class="shrink-0 border-b border-border bg-muted/30 text-xs text-muted-foreground">
	<!-- Row 1: controls + status -->
	<div class="flex h-9 items-center gap-1 px-2">
		<!-- Model picker -->
		<ModelPicker />

		<Separator orientation="vertical" class="mx-0.5 h-4" />

		<!-- Thinking level picker -->
		<ThinkingPicker />

		<!-- Spacer -->
		<div class="flex-1"></div>

		<!-- Context usage (desktop only — shown in row 2 on mobile) -->
		{#if contextDisplay}
			<span class="hidden items-center gap-1 md:flex {contextColor}" title="Context window usage">
				{contextDisplay}
			</span>
		{/if}

		<!-- Git branch (desktop only — shown in row 2 on mobile) -->
		{#if sessionRegistry.viewed?.gitBranch}
			<span class="hidden items-center gap-1 text-muted-foreground md:flex" title="Git branch">
				<GitBranch class="size-3" />
				<span class="max-w-[8rem] truncate">{sessionRegistry.viewed.gitBranch}</span>
			</span>

			<Separator orientation="vertical" class="mx-0.5 hidden h-4 md:block" />
		{/if}

		<!-- Streaming indicator -->
		{#if sessionRegistry.viewed?.isStreaming}
			<Badge variant="secondary" class="gap-1.5 text-xs">
				<span class="relative flex size-2">
					<span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
					<span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
				</span>
				Streaming
			</Badge>
		{/if}

		<!-- Compacting indicator -->
		{#if sessionRegistry.viewed?.isCompacting}
			<Badge variant="secondary" class="gap-1 text-xs">
				<span class="relative flex size-2">
					<span class="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
					<span class="relative inline-flex size-2 rounded-full bg-amber-500"></span>
				</span>
				Compacting…
			</Badge>
		{/if}

		<!-- Connection status -->
		<div class="flex items-center gap-1.5" title={connectionLabel}>
			<span class="relative flex size-2">
				<span class="relative inline-flex size-2 rounded-full {connectionColor}"></span>
			</span>
			<span class="hidden text-xs sm:inline">{connectionLabel}</span>
		</div>

		<Separator orientation="vertical" class="mx-0.5 h-4" />

		<!-- Close session -->
		<button
			onclick={closeSession}
			class="flex items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
			title="Close session"
		>
			<X class="size-3.5" />
		</button>
	</div>

	<!-- Row 2: git branch + context usage (mobile only) -->
	{#if sessionRegistry.viewed?.gitBranch || contextDisplay}
		<div class="flex h-7 items-center gap-2 border-t border-border/50 px-2 md:hidden">
			{#if sessionRegistry.viewed?.gitBranch}
				<span class="flex items-center gap-1 text-muted-foreground" title="Git branch">
					<GitBranch class="size-3" />
					<span class="max-w-[10rem] truncate">{sessionRegistry.viewed.gitBranch}</span>
				</span>
			{/if}

			{#if sessionRegistry.viewed?.gitBranch && contextDisplay}
				<Separator orientation="vertical" class="mx-0.5 h-3" />
			{/if}

			{#if contextDisplay}
				<span class="flex items-center gap-1 {contextColor}" title="Context window usage">
					{contextDisplay}
				</span>
			{/if}
		</div>
	{/if}
</div>
