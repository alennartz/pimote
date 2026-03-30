import { connection } from '$lib/stores/connection.svelte.js';
import type { ExtensionUiRequestEvent } from '@pimote/shared';

/**
 * Shared reactive queue for extension UI requests.
 * Both the inline select panel and the modal dialog consume from this.
 */

export interface DialogRequest {
	requestId: string;
	sessionId: string;
	method: string;
	title?: string;
	message?: string;
	options?: { label: string; value: string }[];
	placeholder?: string;
	content?: string;
	[key: string]: unknown;
}

const FIRE_AND_FORGET = new Set(['setStatus', 'setWidget', 'notify', 'setEditorText', 'setTitle']);

/** Methods rendered inline (not as a modal) */
export const INLINE_METHODS = new Set(['select', 'confirm']);

let queue = $state<DialogRequest[]>([]);
let _initialized = false;

function ensureListener() {
	if (_initialized) return;
	_initialized = true;

	connection.onEvent((event) => {
		if (event.type !== 'extension_ui_request') return;
		const req = event as ExtensionUiRequestEvent;
		if (FIRE_AND_FORGET.has(req.method)) return;
		queue = [...queue, req as unknown as DialogRequest];
	});
}

export function getExtensionUiQueue() {
	ensureListener();
	return {
		get all() { return queue; },
		get inlineCurrent(): DialogRequest | null {
			return queue.find(r => INLINE_METHODS.has(r.method)) ?? null;
		},
		get modalCurrent(): DialogRequest | null {
			return queue.find(r => !INLINE_METHODS.has(r.method)) ?? null;
		},
		sendResponse(requestId: string, sessionId: string, data: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
			connection.send({
				type: 'extension_ui_response',
				sessionId,
				requestId,
				...data,
			});
			queue = queue.filter(r => r.requestId !== requestId);
		},
	};
}
