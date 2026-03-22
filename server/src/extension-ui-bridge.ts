import type { ExtensionUIContext, ExtensionUIDialogOptions } from '@mariozechner/pi-coding-agent';
import type { PimoteEvent } from '@pimote/shared';

/**
 * Creates an ExtensionUIContext implementation that bridges pi extension UI calls
 * to WebSocket messages sent to the remote client.
 *
 * Dialog methods (select, confirm, input, editor) send a request event and wait
 * for the client to respond. Fire-and-forget methods (notify, setStatus, etc.)
 * send an event without waiting. TUI-only methods are no-ops.
 */
export function createExtensionUIBridge(
  sendToClient: (msg: PimoteEvent) => void,
  waitForResponse: (requestId: string) => Promise<any>,
): ExtensionUIContext {

  function sendRequest(sessionId: string, requestId: string, fields: Record<string, unknown>): void {
    sendToClient({
      type: 'extension_ui_request',
      sessionId,
      requestId,
      ...fields,
    } as PimoteEvent);
  }

  async function dialogWithTimeout<T>(
    requestId: string,
    opts: ExtensionUIDialogOptions | undefined,
    fallback: T,
  ): Promise<T> {
    const responsePromise = waitForResponse(requestId);
    if (opts?.timeout) {
      const timer = new Promise<T>((resolve) => setTimeout(() => resolve(fallback), opts.timeout));
      return Promise.race([responsePromise, timer]);
    }
    return responsePromise;
  }

  // We use a fixed sessionId placeholder — the actual sessionId is set by the
  // caller's infrastructure when the event is dispatched. The bridge itself
  // doesn't know the session ID; the sendToClient callback is expected to
  // enrich events with the correct sessionId when needed.
  const SESSION_ID = '';

  const ui: ExtensionUIContext = {
    // ---- Dialog methods (send + wait for response) ----

    async select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
      const requestId = crypto.randomUUID();
      sendRequest(SESSION_ID, requestId, { method: 'select', title, options });
      return dialogWithTimeout(requestId, opts, undefined);
    },

    async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
      const requestId = crypto.randomUUID();
      sendRequest(SESSION_ID, requestId, { method: 'confirm', title, message });
      return dialogWithTimeout(requestId, opts, false);
    },

    async input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
      const requestId = crypto.randomUUID();
      sendRequest(SESSION_ID, requestId, { method: 'input', title, placeholder });
      return dialogWithTimeout(requestId, opts, undefined);
    },

    async editor(title: string, prefill?: string): Promise<string | undefined> {
      const requestId = crypto.randomUUID();
      sendRequest(SESSION_ID, requestId, { method: 'editor', title, prefill });
      return waitForResponse(requestId);
    },

    // ---- Fire-and-forget methods ----

    notify(message: string, type?: 'info' | 'warning' | 'error'): void {
      const requestId = crypto.randomUUID();
      sendRequest(SESSION_ID, requestId, { method: 'notify', message, notifyType: type });
    },

    setStatus(key: string, text: string | undefined): void {
      const requestId = crypto.randomUUID();
      sendRequest(SESSION_ID, requestId, { method: 'setStatus', key, text });
    },

    setWidget(key: string, content: any, options?: any): void {
      if (Array.isArray(content) || content === undefined) {
        const requestId = crypto.randomUUID();
        sendRequest(SESSION_ID, requestId, {
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
      sendRequest(SESSION_ID, requestId, { method: 'setTitle', title });
    },

    setEditorText(text: string): void {
      const requestId = crypto.randomUUID();
      sendRequest(SESSION_ID, requestId, { method: 'setEditorText', text });
    },

    // ---- No-op methods (TUI-only, can't bridge to web) ----

    custom(): Promise<any> {
      return Promise.resolve(undefined as any);
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

    get theme(): any {
      return null;
    },

    getAllThemes(): { name: string; path: string | undefined }[] {
      return [];
    },

    getTheme(): any {
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
