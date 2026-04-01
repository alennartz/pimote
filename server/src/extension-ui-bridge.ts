import type { ExtensionUIContext, ExtensionUIDialogOptions, ExtensionWidgetOptions } from '@mariozechner/pi-coding-agent';
import type { PimoteEvent } from '@pimote/shared';
import type { ManagedSession } from './session-manager.js';
import { sendManagedEvent, waitForManagedUiResponse } from './session-manager.js';

/**
 * Creates an ExtensionUIContext implementation that bridges pi extension UI calls
 * to WebSocket messages sent to the remote client.
 *
 * Dialog methods (select, confirm, input, editor) send a request event and wait
 * for the client to respond. Fire-and-forget methods (notify, setStatus, etc.)
 * send an event without waiting. TUI-only methods are no-ops.
 *
 * The bridge references the ManagedSession directly — no closures over transient
 * handler instances. When the handler changes (reconnect), the managed session's
 * ws field is updated and the bridge automatically routes to the new connection.
 * Pending UI promises survive reconnects and are replayed to the new client.
 */
export function createExtensionUIBridge(managed: ManagedSession): ExtensionUIContext {
  function sendRequest(requestId: string, fields: Record<string, unknown>): PimoteEvent {
    const event = {
      type: 'extension_ui_request',
      sessionId: managed.id,
      requestId,
      ...fields,
    } as PimoteEvent;
    sendManagedEvent(managed, event);
    return event;
  }

  async function dialogWithTimeout<T>(requestId: string, requestEvent: PimoteEvent, opts: ExtensionUIDialogOptions | undefined, fallback: T): Promise<T> {
    const responsePromise = waitForManagedUiResponse(managed, requestId, requestEvent) as Promise<T>;

    const racers: Promise<T>[] = [responsePromise];

    if (opts?.timeout) {
      racers.push(new Promise<T>((resolve) => setTimeout(() => resolve(fallback), opts.timeout)));
    }

    if (opts?.signal) {
      if (opts.signal.aborted) return fallback;
      racers.push(
        new Promise<T>((resolve) => {
          opts.signal!.addEventListener('abort', () => resolve(fallback), { once: true });
        }),
      );
    }

    return racers.length === 1 ? responsePromise : Promise.race(racers);
  }

  const ui: ExtensionUIContext = {
    // ---- Dialog methods (send + wait for response) ----

    async select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
      const requestId = crypto.randomUUID();
      const event = sendRequest(requestId, { method: 'select', title, options });
      return dialogWithTimeout(requestId, event, opts, undefined);
    },

    async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const event = sendRequest(requestId, { method: 'confirm', title, message });
      return dialogWithTimeout(requestId, event, opts, false);
    },

    async input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
      const requestId = crypto.randomUUID();
      const event = sendRequest(requestId, { method: 'input', title, placeholder });
      return dialogWithTimeout(requestId, event, opts, undefined);
    },

    async editor(title: string, prefill?: string): Promise<string | undefined> {
      const requestId = crypto.randomUUID();
      const event = sendRequest(requestId, { method: 'editor', title, prefill });
      return waitForManagedUiResponse(managed, requestId, event) as Promise<string | undefined>;
    },

    // ---- Fire-and-forget methods ----

    notify(message: string, type?: 'info' | 'warning' | 'error'): void {
      const requestId = crypto.randomUUID();
      sendRequest(requestId, { method: 'notify', message, notifyType: type });
    },

    setStatus(key: string, text: string | undefined): void {
      const requestId = crypto.randomUUID();
      sendRequest(requestId, { method: 'setStatus', key, text });
    },

    setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
      if (Array.isArray(content) || content === undefined) {
        const requestId = crypto.randomUUID();
        sendRequest(requestId, {
          method: 'setWidget',
          key,
          lines: content,
          placement: options?.placement,
        });
      }
      // If content is a function (TUI component factory), no-op — can't bridge to web
    },

    setTitle(title: string): void {
      const requestId = crypto.randomUUID();
      sendRequest(requestId, { method: 'setTitle', title });
    },

    setEditorText(text: string): void {
      const requestId = crypto.randomUUID();
      sendRequest(requestId, { method: 'setEditorText', text });
    },

    // ---- No-op methods (TUI-only, can't bridge to web) ----

    custom() {
      return Promise.resolve(undefined as never);
    },

    setWorkingMessage(): void {
      // no-op
    },

    setFooter(): void {
      // no-op
    },

    setHeader(): void {
      // no-op
    },

    setEditorComponent(): void {
      // no-op
    },

    onTerminalInput(): () => void {
      return () => {};
    },

    getEditorText(): string {
      return '';
    },

    pasteToEditor(): void {
      // no-op
    },

    get theme() {
      return null!;
    },

    getAllThemes(): { name: string; path: string | undefined }[] {
      return [];
    },

    getTheme() {
      return undefined;
    },

    setTheme(): { success: boolean; error?: string } {
      return { success: false, error: 'UI not available' };
    },

    getToolsExpanded(): boolean {
      return false;
    },

    setToolsExpanded(): void {
      // no-op
    },
  };

  return ui;
}
