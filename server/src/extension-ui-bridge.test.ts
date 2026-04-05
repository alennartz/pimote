import { describe, it, expect, beforeEach } from 'vitest';
import { createExtensionUIBridge } from './extension-ui-bridge.js';
import type { PimoteEvent, ExtensionUiRequestEvent } from '@pimote/shared';
import type { ManagedSlot, EventSocket, ClientConnection } from './session-manager.js';
import type { PushNotificationService, PushNotificationPayload } from './push-notification.js';

/** Create a mock ManagedSlot with a recording WebSocket. */
function createMockSlot(): { slot: ManagedSlot; sent: PimoteEvent[] } {
  const sent: PimoteEvent[] = [];
  const ws: EventSocket = {
    readyState: 1, // OPEN
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  };

  const connection: ClientConnection = {
    ws,
    connectedClientId: 'test-client',
    onSessionReset: null,
  };

  const slot = {
    runtime: {} as any,
    folderPath: '/test',
    eventBusRef: { current: null },
    connection,
    sessionState: {
      id: 'test-session',
      eventBuffer: {} as any,
      status: 'idle' as const,
      needsAttention: false,
      lastActivity: Date.now(),
      unsubscribe: () => {},
      pendingUiResponses: new Map(),
      extensionsBound: false,
      panelState: new Map(),
      panelListenerUnsubs: [],
      panelThrottleTimer: null,
    },
    get session() {
      return this.runtime.session;
    },
  } satisfies ManagedSlot;

  return { slot, sent };
}

/** Resolve a pending UI response by requestId. */
function resolveUi(slot: ManagedSlot, requestId: string, value: unknown): void {
  const pending = slot.sessionState.pendingUiResponses.get(requestId);
  if (pending) {
    slot.sessionState.pendingUiResponses.delete(requestId);
    pending.resolve(value);
  }
}

function createMockPushService(): PushNotificationService & { notified: PushNotificationPayload[] } {
  const notified: PushNotificationPayload[] = [];
  return {
    notified,
    async notify(payload: PushNotificationPayload) {
      notified.push(payload);
    },
    async initialize() {},
    async addSubscription() {},
    async removeSubscription() {},
    getSubscriptions: () => [],
  } as unknown as PushNotificationService & { notified: PushNotificationPayload[] };
}

describe('createExtensionUIBridge', () => {
  let slot: ManagedSlot;
  let sent: PimoteEvent[];

  beforeEach(() => {
    const mock = createMockSlot();
    slot = mock.slot;
    sent = mock.sent;
  });

  describe('select()', () => {
    it('should send extension_ui_request with correct fields and resolve with response', async () => {
      const ui = createExtensionUIBridge(slot);
      const promise = ui.select('Pick one', ['option-a', 'option-b', 'option-c']);

      expect(sent).toHaveLength(1);
      const event = sent[0] as ExtensionUiRequestEvent;
      expect(event.type).toBe('extension_ui_request');
      expect(event.method).toBe('select');
      expect(event.title).toBe('Pick one');
      expect(event.options).toEqual(['option-a', 'option-b', 'option-c']);
      expect(event.sessionId).toBe('test-session');
      expect(typeof event.requestId).toBe('string');
      expect(event.requestId.length).toBeGreaterThan(0);

      // Pending promise should exist
      expect(slot.sessionState.pendingUiResponses.has(event.requestId)).toBe(true);

      // Resolve it
      resolveUi(slot, event.requestId, 'option-b');
      const result = await promise;
      expect(result).toBe('option-b');
    });
  });

  describe('confirm()', () => {
    it('should send confirm request and resolve with boolean', async () => {
      const ui = createExtensionUIBridge(slot);
      const promise = ui.confirm('Are you sure?', 'This action is irreversible');

      const event = sent[0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('confirm');
      expect(event.title).toBe('Are you sure?');
      expect(event.message).toBe('This action is irreversible');

      resolveUi(slot, event.requestId, true);
      expect(await promise).toBe(true);
    });
  });

  describe('input()', () => {
    it('should send input request and resolve with string', async () => {
      const ui = createExtensionUIBridge(slot);
      const promise = ui.input('Enter name', 'placeholder text');

      const event = sent[0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('input');
      expect(event.title).toBe('Enter name');
      expect(event.placeholder).toBe('placeholder text');

      resolveUi(slot, event.requestId, 'user typed this');
      expect(await promise).toBe('user typed this');
    });
  });

  describe('editor()', () => {
    it('should send editor request and resolve with string', async () => {
      const ui = createExtensionUIBridge(slot);
      const promise = ui.editor('Edit text', 'initial content');

      const event = sent[0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('editor');
      expect(event.title).toBe('Edit text');
      expect(event.prefill).toBe('initial content');

      resolveUi(slot, event.requestId, 'edited content');
      expect(await promise).toBe('edited content');
    });
  });

  describe('timeout handling', () => {
    it('should resolve to undefined when select times out', async () => {
      const ui = createExtensionUIBridge(slot);
      const result = await ui.select('Pick one', ['a', 'b'], { timeout: 50 });
      expect(result).toBeUndefined();
    });

    it('should resolve to false when confirm times out', async () => {
      const ui = createExtensionUIBridge(slot);
      const result = await ui.confirm('Sure?', 'Really?', { timeout: 50 });
      expect(result).toBe(false);
    });

    it('should resolve to undefined when input times out', async () => {
      const ui = createExtensionUIBridge(slot);
      const result = await ui.input('Name?', 'placeholder', { timeout: 50 });
      expect(result).toBeUndefined();
    });

    it('should resolve with value if response arrives before timeout', async () => {
      const ui = createExtensionUIBridge(slot);
      const promise = ui.select('Pick one', ['a', 'b'], { timeout: 5000 });

      const event = sent[0] as ExtensionUiRequestEvent;
      resolveUi(slot, event.requestId, 'fast-response');
      expect(await promise).toBe('fast-response');
    });
  });

  describe('abort signal handling', () => {
    it('should resolve to undefined immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const ui = createExtensionUIBridge(slot);
      const result = await ui.select('Pick one', ['a', 'b'], { signal: controller.signal });
      expect(result).toBeUndefined();
    });

    it('should resolve to false immediately when confirm signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const ui = createExtensionUIBridge(slot);
      const result = await ui.confirm('Sure?', 'Really?', { signal: controller.signal });
      expect(result).toBe(false);
    });

    it('should resolve to undefined when select signal is aborted after call', async () => {
      const controller = new AbortController();

      const ui = createExtensionUIBridge(slot);
      const promise = ui.select('Pick one', ['a', 'b'], { signal: controller.signal });

      controller.abort();
      expect(await promise).toBeUndefined();
    });

    it('should resolve to false when confirm signal is aborted after call', async () => {
      const controller = new AbortController();

      const ui = createExtensionUIBridge(slot);
      const promise = ui.confirm('Sure?', 'Really?', { signal: controller.signal });

      controller.abort();
      expect(await promise).toBe(false);
    });

    it('should resolve to undefined when input signal is aborted after call', async () => {
      const controller = new AbortController();

      const ui = createExtensionUIBridge(slot);
      const promise = ui.input('Name?', 'placeholder', { signal: controller.signal });

      controller.abort();
      expect(await promise).toBeUndefined();
    });

    it('should resolve with value if response arrives before abort', async () => {
      const controller = new AbortController();

      const ui = createExtensionUIBridge(slot);
      const promise = ui.select('Pick one', ['a', 'b'], { signal: controller.signal });

      const event = sent[0] as ExtensionUiRequestEvent;
      resolveUi(slot, event.requestId, 'fast-response');
      expect(await promise).toBe('fast-response');
    });
  });

  describe('fire-and-forget methods', () => {
    it('notify() should send event without waiting', () => {
      const ui = createExtensionUIBridge(slot);
      ui.notify('Something happened', 'warning');

      expect(sent).toHaveLength(1);
      const event = sent[0] as ExtensionUiRequestEvent;
      expect(event.type).toBe('extension_ui_request');
      expect(event.method).toBe('notify');
      expect(event.message).toBe('Something happened');
      expect(event.notifyType).toBe('warning');
    });

    it('setStatus() should send event without waiting', () => {
      const ui = createExtensionUIBridge(slot);
      ui.setStatus('my-ext', 'Loading...');

      const event = sent[0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('setStatus');
      expect(event.key).toBe('my-ext');
      expect(event.text).toBe('Loading...');
    });

    it('setWidget() should send event for string array content', () => {
      const ui = createExtensionUIBridge(slot);
      ui.setWidget('my-widget', ['line 1', 'line 2'], { placement: 'belowEditor' });

      const event = sent[0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('setWidget');
      expect(event.key).toBe('my-widget');
      expect(event.lines).toEqual(['line 1', 'line 2']);
      expect(event.placement).toBe('belowEditor');
    });

    it('setWidget() should no-op for function content', () => {
      const ui = createExtensionUIBridge(slot);
      ui.setWidget('my-widget', (() => {}) as any);

      expect(sent).toHaveLength(0);
    });

    it('setWidget() should send event for undefined content (clear)', () => {
      const ui = createExtensionUIBridge(slot);
      ui.setWidget('my-widget', undefined);

      const event = sent[0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('setWidget');
      expect(event.key).toBe('my-widget');
      expect(event.lines).toBeUndefined();
    });

    it('setTitle() should send event without waiting', () => {
      const ui = createExtensionUIBridge(slot);
      ui.setTitle('My Session');

      const event = sent[0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('setTitle');
      expect(event.title).toBe('My Session');
    });

    it('setEditorText() should send event without waiting', () => {
      const ui = createExtensionUIBridge(slot);
      ui.setEditorText('some text');

      const event = sent[0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('setEditorText');
      expect(event.text).toBe('some text');
    });
  });

  describe('no-op methods', () => {
    it('custom() should resolve to undefined', async () => {
      const ui = createExtensionUIBridge(slot);
      const result = await ui.custom((() => ({})) as any);
      expect(result).toBeUndefined();
    });

    it('onTerminalInput() should return an unsubscribe function', () => {
      const ui = createExtensionUIBridge(slot);
      const unsub = ui.onTerminalInput(() => undefined);
      expect(typeof unsub).toBe('function');
      unsub(); // should not throw
    });

    it('getEditorText() should return empty string', () => {
      const ui = createExtensionUIBridge(slot);
      expect(ui.getEditorText()).toBe('');
    });

    it('theme should be null', () => {
      const ui = createExtensionUIBridge(slot);
      expect(ui.theme).toBeNull();
    });

    it('getAllThemes() should return empty array', () => {
      const ui = createExtensionUIBridge(slot);
      expect(ui.getAllThemes()).toEqual([]);
    });

    it('getTheme() should return undefined', () => {
      const ui = createExtensionUIBridge(slot);
      expect(ui.getTheme('anything')).toBeUndefined();
    });

    it('setTheme() should return failure', () => {
      const ui = createExtensionUIBridge(slot);
      const result = ui.setTheme('dark');
      expect(result).toEqual({ success: false, error: 'UI not available' });
    });

    it('getToolsExpanded() should return false', () => {
      const ui = createExtensionUIBridge(slot);
      expect(ui.getToolsExpanded()).toBe(false);
    });

    it('no-op methods should not throw', () => {
      const ui = createExtensionUIBridge(slot);
      expect(() => ui.setWorkingMessage('test')).not.toThrow();
      expect(() => ui.setFooter(undefined)).not.toThrow();
      expect(() => ui.setHeader(undefined)).not.toThrow();
      expect(() => ui.setEditorComponent(undefined)).not.toThrow();
      expect(() => ui.pasteToEditor('test')).not.toThrow();
      expect(() => ui.setToolsExpanded(true)).not.toThrow();
    });
  });

  describe('push notifications for interactions', () => {
    it('select() triggers push notification with correct payload', async () => {
      const pushService = createMockPushService();
      const ui = createExtensionUIBridge(slot, pushService);
      const promise = ui.select('Pick one', ['a', 'b']);

      expect(pushService.notified).toHaveLength(1);
      expect(pushService.notified[0].reason).toBe('interaction');
      expect(pushService.notified[0].interaction).toEqual({
        method: 'select',
        title: 'Pick one',
        options: ['a', 'b'],
        message: undefined,
      });
      expect(pushService.notified[0].sessionId).toBe('test-session');
      expect(pushService.notified[0].folderPath).toBe('/test');
      expect(pushService.notified[0].projectName).toBe('test');

      // Resolve to avoid dangling promise
      const event = sent[0] as ExtensionUiRequestEvent;
      resolveUi(slot, event.requestId, 'a');
      await promise;
    });

    it('confirm() triggers push notification', async () => {
      const pushService = createMockPushService();
      const ui = createExtensionUIBridge(slot, pushService);
      const promise = ui.confirm('Sure?', 'This is dangerous');

      expect(pushService.notified).toHaveLength(1);
      expect(pushService.notified[0].interaction).toEqual({
        method: 'confirm',
        title: 'Sure?',
        options: undefined,
        message: 'This is dangerous',
      });

      const event = sent[0] as ExtensionUiRequestEvent;
      resolveUi(slot, event.requestId, true);
      await promise;
    });

    it('input() triggers push notification', async () => {
      const pushService = createMockPushService();
      const ui = createExtensionUIBridge(slot, pushService);
      const promise = ui.input('Enter name');

      expect(pushService.notified).toHaveLength(1);
      expect(pushService.notified[0].interaction).toEqual({
        method: 'input',
        title: 'Enter name',
        options: undefined,
        message: undefined,
      });

      const event = sent[0] as ExtensionUiRequestEvent;
      resolveUi(slot, event.requestId, 'typed');
      await promise;
    });

    it('editor() triggers push notification', async () => {
      const pushService = createMockPushService();
      const ui = createExtensionUIBridge(slot, pushService);
      const promise = ui.editor('Edit text');

      expect(pushService.notified).toHaveLength(1);
      expect(pushService.notified[0].interaction).toEqual({
        method: 'editor',
        title: 'Edit text',
        options: undefined,
        message: undefined,
      });

      const event = sent[0] as ExtensionUiRequestEvent;
      resolveUi(slot, event.requestId, 'edited');
      await promise;
    });

    it('does not send push notification when pushNotificationService is undefined', async () => {
      const ui = createExtensionUIBridge(slot);
      const promise = ui.select('Pick one', ['a', 'b']);

      // No error should occur — just no push sent
      const event = sent[0] as ExtensionUiRequestEvent;
      resolveUi(slot, event.requestId, 'a');
      await promise;
    });
  });

  describe('disconnected state', () => {
    it('should not throw when connection is null (disconnected)', () => {
      slot.connection = null;
      const ui = createExtensionUIBridge(slot);

      // Fire-and-forget should silently no-op
      expect(() => ui.notify('test')).not.toThrow();
      expect(sent).toHaveLength(0);
    });

    it('should create pending promise even when disconnected (for replay on reconnect)', async () => {
      slot.connection = null;
      const ui = createExtensionUIBridge(slot);

      const promise = ui.select('Pick one', ['a', 'b']);

      // Event not sent (connection is null), but pending promise exists for replay
      expect(sent).toHaveLength(0);
      expect(slot.sessionState.pendingUiResponses.size).toBe(1);

      // Resolve it (simulating reconnect + replay + user response)
      const [requestId] = [...slot.sessionState.pendingUiResponses.keys()];
      const pending = slot.sessionState.pendingUiResponses.get(requestId!)!;
      pending.resolve('a');
      slot.sessionState.pendingUiResponses.delete(requestId!);

      expect(await promise).toBe('a');
    });

    it('stores request event metadata for replay', () => {
      slot.connection = null;
      const ui = createExtensionUIBridge(slot);

      ui.select('Pick one', ['a', 'b']);

      const [, entry] = [...slot.sessionState.pendingUiResponses.entries()][0]!;
      expect(entry.event).toBeDefined();
      expect((entry.event as any).method).toBe('select');
      expect((entry.event as any).title).toBe('Pick one');
    });
  });
});
