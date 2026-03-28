<script lang="ts">
	import type { SessionInfo } from '@pimote/shared';
	import { connection } from '$lib/stores/connection.svelte.js';
	import { sessionRegistry, switchToSession } from '$lib/stores/session-registry.svelte.js';

	interface Props {
		session: SessionInfo;
		folderPath: string;
	}

	let { session, folderPath }: Props = $props();

	function formatRelativeTime(dateStr: string): string {
		const date = new Date(dateStr);
		const now = Date.now();
		const diffMs = now - date.getTime();
		const diffSec = Math.floor(diffMs / 1000);
		const diffMin = Math.floor(diffSec / 60);
		const diffHr = Math.floor(diffMin / 60);
		const diffDay = Math.floor(diffHr / 24);

		if (diffSec < 60) return 'just now';
		if (diffMin < 60) return `${diffMin}m ago`;
		if (diffHr < 24) return `${diffHr}h ago`;
		if (diffDay < 30) return `${diffDay}d ago`;
		return date.toLocaleDateString();
	}

	function displayName(): string {
		if (session.name) return session.name;
		if (session.firstMessage) {
			return session.firstMessage.length > 60
				? session.firstMessage.slice(0, 60) + '…'
				: session.firstMessage;
		}
		return `Session ${session.id.slice(0, 8)}`;
	}

	async function openSession() {
		try {
			await connection.send({
				type: 'open_session',
				folderPath,
				sessionPath: session.path,
			});
		} catch (e) {
			console.error('Failed to open session:', e);
		}
	}
</script>

<button
	class="w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-sidebar-accent"
	onclick={openSession}
>
	<div class="truncate text-sm font-medium text-sidebar-foreground">
		{displayName()}
	</div>
	<div class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
		<span>{session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}</span>
		<span>·</span>
		<span>{formatRelativeTime(session.modified)}</span>
	</div>
</button>
