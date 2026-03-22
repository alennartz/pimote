import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtensionUIBridge } from './extension-ui-bridge.js';
import type { PimoteEvent, ExtensionUiRequestEvent } from '@pimote/shared';

describe('createExtensionUIBridge', () => {
  let sendToClient: ReturnType<typeof vi.fn<(msg: PimoteEvent) => void>>;
  let waitForResponse: ReturnType<typeof vi.fn<(requestId: string) => Promise<any>>>;

  beforeEach(() => {
    sendToClient = vi.fn();
    waitForResponse = vi.fn();
  });

  describe('select()', () => {
    it('should send extension_ui_request with correct fields and resolve with response', async () => {
      waitForResponse.mockResolvedValue('option-b');

      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const result = await ui.select('Pick one', ['option-a', 'option-b', 'option-c']);

      expect(sendToClient).toHaveBeenCalledOnce();
      const event = sendToClient.mock.calls[0][0] as ExtensionUiRequestEvent;
      expect(event.type).toBe('extension_ui_request');
      expect(event.method).toBe('select');
      expect(event.title).toBe('Pick one');
      expect(event.options).toEqual(['option-a', 'option-b', 'option-c']);
      expect(typeof event.requestId).toBe('string');
      expect(event.requestId.length).toBeGreaterThan(0);

      expect(waitForResponse).toHaveBeenCalledWith(event.requestId);
      expect(result).toBe('option-b');
    });
  });

  describe('confirm()', () => {
    it('should send confirm request and resolve with boolean', async () => {
      waitForResponse.mockResolvedValue(true);

      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const result = await ui.confirm('Are you sure?', 'This action is irreversible');

      const event = sendToClient.mock.calls[0][0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('confirm');
      expect(event.title).toBe('Are you sure?');
      expect(event.message).toBe('This action is irreversible');

      expect(result).toBe(true);
    });
  });

  describe('input()', () => {
    it('should send input request and resolve with string', async () => {
      waitForResponse.mockResolvedValue('user typed this');

      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const result = await ui.input('Enter name', 'placeholder text');

      const event = sendToClient.mock.calls[0][0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('input');
      expect(event.title).toBe('Enter name');
      expect(event.placeholder).toBe('placeholder text');

      expect(result).toBe('user typed this');
    });
  });

  describe('editor()', () => {
    it('should send editor request and resolve with string', async () => {
      waitForResponse.mockResolvedValue('edited content');

      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const result = await ui.editor('Edit text', 'initial content');

      const event = sendToClient.mock.calls[0][0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('editor');
      expect(event.title).toBe('Edit text');
      expect(event.prefill).toBe('initial content');

      expect(result).toBe('edited content');
    });
  });

  describe('timeout handling', () => {
    it('should resolve to undefined when select times out', async () => {
      // waitForResponse never resolves
      waitForResponse.mockReturnValue(new Promise(() => {}));

      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const result = await ui.select('Pick one', ['a', 'b'], { timeout: 50 });

      expect(result).toBeUndefined();
    });

    it('should resolve to false when confirm times out', async () => {
      waitForResponse.mockReturnValue(new Promise(() => {}));

      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const result = await ui.confirm('Sure?', 'Really?', { timeout: 50 });

      expect(result).toBe(false);
    });

    it('should resolve to undefined when input times out', async () => {
      waitForResponse.mockReturnValue(new Promise(() => {}));

      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const result = await ui.input('Name?', 'placeholder', { timeout: 50 });

      expect(result).toBeUndefined();
    });

    it('should resolve with value if response arrives before timeout', async () => {
      waitForResponse.mockResolvedValue('fast-response');

      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const result = await ui.select('Pick one', ['a', 'b'], { timeout: 5000 });

      expect(result).toBe('fast-response');
    });
  });

  describe('fire-and-forget methods', () => {
    it('notify() should send event without waiting', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      ui.notify('Something happened', 'warning');

      expect(sendToClient).toHaveBeenCalledOnce();
      const event = sendToClient.mock.calls[0][0] as ExtensionUiRequestEvent;
      expect(event.type).toBe('extension_ui_request');
      expect(event.method).toBe('notify');
      expect(event.message).toBe('Something happened');
      expect(event.notifyType).toBe('warning');

      expect(waitForResponse).not.toHaveBeenCalled();
    });

    it('setStatus() should send event without waiting', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      ui.setStatus('my-ext', 'Loading...');

      const event = sendToClient.mock.calls[0][0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('setStatus');
      expect(event.key).toBe('my-ext');
      expect(event.text).toBe('Loading...');
      expect(waitForResponse).not.toHaveBeenCalled();
    });

    it('setWidget() should send event for string array content', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      ui.setWidget('my-widget', ['line 1', 'line 2'], { placement: 'belowEditor' });

      const event = sendToClient.mock.calls[0][0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('setWidget');
      expect(event.key).toBe('my-widget');
      expect(event.lines).toEqual(['line 1', 'line 2']);
      expect(event.placement).toBe('belowEditor');
      expect(waitForResponse).not.toHaveBeenCalled();
    });

    it('setWidget() should no-op for function content', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      ui.setWidget('my-widget', (() => {}) as any);

      expect(sendToClient).not.toHaveBeenCalled();
    });

    it('setWidget() should send event for undefined content (clear)', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      ui.setWidget('my-widget', undefined);

      const event = sendToClient.mock.calls[0][0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('setWidget');
      expect(event.key).toBe('my-widget');
      expect(event.lines).toBeUndefined();
    });

    it('setTitle() should send event without waiting', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      ui.setTitle('My Session');

      const event = sendToClient.mock.calls[0][0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('setTitle');
      expect(event.title).toBe('My Session');
      expect(waitForResponse).not.toHaveBeenCalled();
    });

    it('setEditorText() should send event without waiting', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      ui.setEditorText('some text');

      const event = sendToClient.mock.calls[0][0] as ExtensionUiRequestEvent;
      expect(event.method).toBe('setEditorText');
      expect(event.text).toBe('some text');
      expect(waitForResponse).not.toHaveBeenCalled();
    });
  });

  describe('no-op methods', () => {
    it('custom() should resolve to undefined', async () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const result = await ui.custom((() => ({})) as any);
      expect(result).toBeUndefined();
    });

    it('onTerminalInput() should return an unsubscribe function', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const unsub = ui.onTerminalInput(() => undefined);
      expect(typeof unsub).toBe('function');
      unsub(); // should not throw
    });

    it('getEditorText() should return empty string', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      expect(ui.getEditorText()).toBe('');
    });

    it('theme should be null', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      expect(ui.theme).toBeNull();
    });

    it('getAllThemes() should return empty array', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      expect(ui.getAllThemes()).toEqual([]);
    });

    it('getTheme() should return undefined', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      expect(ui.getTheme('anything')).toBeUndefined();
    });

    it('setTheme() should return failure', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      const result = ui.setTheme('dark');
      expect(result).toEqual({ success: false, error: 'UI not available' });
    });

    it('getToolsExpanded() should return false', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      expect(ui.getToolsExpanded()).toBe(false);
    });

    it('no-op methods should not throw', () => {
      const ui = createExtensionUIBridge(sendToClient, waitForResponse);
      expect(() => ui.setWorkingMessage('test')).not.toThrow();
      expect(() => ui.setFooter(undefined)).not.toThrow();
      expect(() => ui.setHeader(undefined)).not.toThrow();
      expect(() => ui.setEditorComponent(undefined)).not.toThrow();
      expect(() => ui.pasteToEditor('test')).not.toThrow();
      expect(() => ui.setToolsExpanded(true)).not.toThrow();
    });
  });
});
