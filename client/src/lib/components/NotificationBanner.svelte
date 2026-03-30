<script lang="ts">
	import { connection } from '$lib/stores/connection.svelte.js';
	import Bell from '@lucide/svelte/icons/bell';
	import X from '@lucide/svelte/icons/x';
	import { onMount } from 'svelte';

	let show = $state(false);

	onMount(() => {
		if (
			'Notification' in window &&
			Notification.permission === 'default' &&
			!localStorage.getItem('pimote-push-dismissed')
		) {
			show = true;
		}
	});

	async function enableNotifications() {
		try {
			const permission = await Notification.requestPermission();
			if (permission === 'granted') {
				const reg = await navigator.serviceWorker.ready;
				// Fetch VAPID public key from server
				const res = await fetch('/api/vapid-key');
				const { publicKey } = await res.json();

				if (publicKey) {
					const subscription = await reg.pushManager.subscribe({
						userVisibleOnly: true,
						applicationServerKey: urlBase64ToUint8Array(publicKey),
					});

					const sub = subscription.toJSON();
					await connection.send({
						type: 'register_push',
						subscription: {
							endpoint: sub.endpoint!,
							keys: {
								p256dh: sub.keys!.p256dh!,
								auth: sub.keys!.auth!,
							},
						},
					});
				}
			}
		} catch (err) {
			console.error('[pimote] Failed to setup push notifications:', err);
		}
		show = false;
	}

	function dismiss() {
		localStorage.setItem('pimote-push-dismissed', 'true');
		show = false;
	}

	// Convert VAPID key from base64 URL to ArrayBuffer
	function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
		const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
		const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
		const rawData = atob(base64);
		const outputArray = new Uint8Array(rawData.length);
		for (let i = 0; i < rawData.length; ++i) {
			outputArray[i] = rawData.charCodeAt(i);
		}
		return outputArray.buffer as ArrayBuffer;
	}
</script>

{#if show}
	<div class="flex items-center gap-3 border-b border-border bg-muted/50 px-4 py-3">
		<Bell class="size-4 shrink-0 text-muted-foreground" />
		<span class="flex-1 text-sm text-foreground"
			>Enable notifications to know when sessions finish.</span
		>
		<button
			class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/80"
			onclick={enableNotifications}
		>
			Enable
		</button>
		<button
			class="rounded-md p-1 text-muted-foreground hover:text-foreground"
			onclick={dismiss}
			title="Dismiss"
		>
			<X class="size-4" />
		</button>
	</div>
{/if}
