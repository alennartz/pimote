<script lang="ts">
	import { connection } from '$lib/stores/connection.svelte.js';
	import Bell from '@lucide/svelte/icons/bell';
	import X from '@lucide/svelte/icons/x';
	import { onMount } from 'svelte';

	let show = $state(false);
	let error = $state('');
	let enabling = $state(false);

	onMount(() => {
		// Show banner if push is supported but not yet subscribed
		if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
		if (localStorage.getItem('pimote-push-dismissed')) return;

		// Show if permission not yet granted, OR if granted but we might need to
		// re-subscribe (e.g. subscription was lost)
		if (Notification.permission === 'denied') return;

		if (Notification.permission === 'default') {
			show = true;
			return;
		}

		// Permission is 'granted' — check if we actually have a subscription
		navigator.serviceWorker.ready.then(async (reg) => {
			const existing = await reg.pushManager.getSubscription();
			if (!existing) {
				show = true; // granted but no subscription — need to re-subscribe
			}
		}).catch(() => {});
	});

	async function enableNotifications() {
		error = '';
		enabling = true;
		try {
			const reg = await navigator.serviceWorker.ready;

			// Fetch VAPID public key from server
			const res = await fetch('/api/vapid-key');
			const { publicKey } = await res.json();
			if (!publicKey) {
				error = 'Server returned no VAPID key. Push notifications are not configured.';
				return;
			}

			// subscribe() handles permission prompting internally — more reliable
			// on Android PWAs than calling Notification.requestPermission() first
			let subscription: PushSubscription;
			try {
				subscription = await reg.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: urlBase64ToUint8Array(publicKey),
				});
			} catch (err) {
				const msg = (err as Error).message ?? String(err);
				if (Notification.permission === 'denied') {
					error = 'Notification permission was denied. Enable notifications for this app in your system settings, then try again.';
				} else {
					error = `Push subscription failed: ${msg}`;
				}
				console.error('[pimote] pushManager.subscribe() failed:', err, 'Notification.permission:', Notification.permission);
				return;
			}

			const sub = subscription.toJSON();
			if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
				error = 'Push subscription returned incomplete data.';
				console.error('[pimote] Incomplete subscription:', JSON.stringify(sub));
				return;
			}

			await connection.send({
				type: 'register_push',
				subscription: {
					endpoint: sub.endpoint,
					keys: {
						p256dh: sub.keys.p256dh,
						auth: sub.keys.auth,
					},
				},
			});

			console.log('[pimote] Push notifications enabled successfully');
			show = false;
		} catch (err) {
			error = `Notification setup failed: ${(err as Error).message ?? err}`;
			console.error('[pimote] Failed to setup push notifications:', err);
		} finally {
			enabling = false;
		}
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
	<div class="flex flex-col border-b border-border bg-muted/50">
		<div class="flex items-center gap-3 px-4 py-3">
			<Bell class="size-4 shrink-0 text-muted-foreground" />
			<span class="flex-1 text-sm text-foreground"
				>Enable notifications to know when sessions finish.</span
			>
			<button
				class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-50"
				onclick={enableNotifications}
				disabled={enabling}
			>
				{enabling ? 'Enabling…' : 'Enable'}
			</button>
			<button
				class="rounded-md p-1 text-muted-foreground hover:text-foreground"
				onclick={dismiss}
				title="Dismiss"
			>
				<X class="size-4" />
			</button>
		</div>
		{#if error}
			<div class="px-4 pb-3 text-xs text-destructive">{error}</div>
		{/if}
	</div>
{/if}
