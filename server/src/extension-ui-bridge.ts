import type { ExtensionUIContext, ExtensionUIDialogOptions, ExtensionWidgetOptions } from '@mariozechner/pi-coding-agent';
import type { PimoteEvent } from '../../shared/dist/index.js';
import { UI_BRIDGE_DISABLED_IN_VOICE_MODE } from '../../shared/dist/index.js';
import type { ManagedSlot } from './session-manager.js';
import { sendSlotEvent, waitForSlotUiResponse } from './session-manager.js';
import type { PushNotificationService } from './push-notification.js';

export interface ExtensionUIBridgeOptions {
  /** Returns true while a voice call owns this session. Dialog methods then
   *  reject with `ui_bridge_disabled_in_voice_mode`, fire-and-forget methods
   *  become no-ops. Omit for non-voice tests / callers. */
  isVoiceModeActive?: () => boolean;
}

/**
 * Creates an ExtensionUIContext implementation that bridges pi extension UI calls
 * to WebSocket messages sent to the remote client.
 *
 * Dialog methods (select, confirm, input, editor) send a request event and wait
 * for the client to respond. Fire-and-forget methods (notify, setStatus, etc.)
 * send an event without waiting. TUI-only methods are no-ops.
 *
 * The bridge references the ManagedSlot directly — no closures over transient
 * handler instances. When the handler changes (reconnect), the slot's connection
 * is updated and the bridge automatically routes to the new connection.
 * Pending UI promises survive reconnects and are replayed to the new client.
 */
export function createExtensionUIBridge(slot: ManagedSlot, pushNotificationService?: PushNotificationService, options?: ExtensionUIBridgeOptions): ExtensionUIContext {
  const isVoice = () => options?.isVoiceModeActive?.() ?? false;
  function voiceDisabledError(): Error {
    return new Error(UI_BRIDGE_DISABLED_IN_VOICE_MODE);
  }
  function notifyInteraction(method: string, fields: Record<string, unknown>): void {
    if (!pushNotificationService) return;
    const projectName = slot.folderPath.split('/').pop() ?? 'Unknown';
    pushNotificationService
      .notify({
        projectName,
        folderPath: slot.folderPath,
        sessionId: slot.sessionState.id,
        sessionName: slot.session?.sessionName,
        reason: 'interaction',
        interaction: {
          method,
          title: fields.title as string,
          options: fields.options as string[] | undefined,
          message: fields.message as string | undefined,
        },
      })
      .catch((err: unknown) => console.warn('[ExtensionUIBridge] Push notification error:', (err as Error).message ?? err));
  }

  function sendRequest(requestId: string, fields: Record<string, unknown>): PimoteEvent {
    const event = {
      type: 'extension_ui_request',
      sessionId: slot.sessionState.id,
      requestId,
      ...fields,
    } as PimoteEvent;
    sendSlotEvent(slot, event);
    return event;
  }

  async function dialogWithTimeout<T>(requestId: string, requestEvent: PimoteEvent, opts: ExtensionUIDialogOptions | undefined, fallback: T): Promise<T> {
    const responsePromise = waitForSlotUiResponse(slot, requestId, requestEvent) as Promise<T>;

    const racers: Promise<T>[] = [responsePromise];

    if (opts?.timeout) {
      racers.push(new Promise<T>((resolve) => setTimeout(() => resolve(fallback), opts.timeout)));
    }

    if (opts?.signal) {
      if (opts.signal.aborted) {
        // Remove the pending entry we just created — no one will respond to it
        slot.sessionState.pendingUiResponses.delete(requestId);
        return fallback;
      }
      racers.push(
        new Promise<T>((resolve) => {
          opts.signal!.addEventListener('abort', () => resolve(fallback), { once: true });
        }),
      );
    }

    if (racers.length === 1) return responsePromise;

    const result = await Promise.race(racers);

    // If timeout or abort won the race, the pending entry is stale — the server
    // has already moved on. Remove it so it won't be replayed on reconnect.
    if (slot.sessionState.pendingUiResponses.has(requestId)) {
      slot.sessionState.pendingUiResponses.delete(requestId);
    }

    return result;
  }

  const ui: ExtensionUIContext = {
    // ---- Dialog methods (send + wait for response) ----

    async select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
      if (isVoice()) throw voiceDisabledError();
      const requestId = crypto.randomUUID();
      const event = sendRequest(requestId, { method: 'select', title, options });
      notifyInteraction('select', { title, options });
      return dialogWithTimeout(requestId, event, opts, undefined);
    },

    async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
      if (isVoice()) throw voiceDisabledError();
      const requestId = crypto.randomUUID();
      const event = sendRequest(requestId, { method: 'confirm', title, message });
      notifyInteraction('confirm', { title, message });
      return dialogWithTimeout(requestId, event, opts, false);
    },

    async input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
      if (isVoice()) throw voiceDisabledError();
      const requestId = crypto.randomUUID();
      const event = sendRequest(requestId, { method: 'input', title, placeholder });
      notifyInteraction('input', { title });
      return dialogWithTimeout(requestId, event, opts, undefined);
    },

    async editor(title: string, prefill?: string): Promise<string | undefined> {
      if (isVoice()) throw voiceDisabledError();
      const requestId = crypto.randomUUID();
      const event = sendRequest(requestId, { method: 'editor', title, prefill });
      notifyInteraction('editor', { title });
      return waitForSlotUiResponse(slot, requestId, event) as Promise<string | undefined>;
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

    setHiddenThinkingLabel(): void {
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
