import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import type { TObject } from 'typebox';
import { Value } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  moduleCache: false,
  alias: { '@earendil-works/pi-ai': fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/compat')) },
});
const testUiExtension = await jiti.import<(pi: ExtensionAPI) => void>(new URL('../../.pi/extensions/test-ui.ts', import.meta.url).href, { default: true });

function dialogMock() {
  return vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);
}

function emissionMock() {
  return vi.fn<(...args: unknown[]) => void>();
}

function harness() {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  const ui = {
    select: dialogMock(),
    confirm: dialogMock(),
    input: dialogMock(),
    editor: dialogMock(),
    notify: emissionMock(),
    setStatus: emissionMock(),
    setWidget: emissionMock(),
    setTitle: emissionMock(),
    setEditorText: emissionMock(),
  };
  const ctx = { ui } as unknown as ExtensionToolContext;
  testUiExtension(pi);
  const toolNamed = (name: string) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} was not registered`);
    return tool;
  };
  return {
    tools,
    ui,
    toolNamed,
    invoke: (name: string, params: Record<string, unknown>, signal?: AbortSignal) => toolNamed(name).execute('ui-call', params, signal, undefined, ctx),
  };
}

function deferred<T>() {
  const state: { resolve: (value: T) => void } = { resolve: () => {} };
  const promise = new Promise<T>((resolve) => {
    state.resolve = resolve;
  });
  return { promise, resolve: (value: T) => state.resolve(value) };
}

interface DialogCase {
  name: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  params: Record<string, unknown>;
  value: string | boolean;
  text: string;
  dismissedValue: undefined | false;
  dismissedText: string;
}

const DIALOG_CASES: readonly DialogCase[] = [
  {
    name: 'test_select',
    method: 'select',
    params: { title: 'Pick', options: ['one'] },
    value: 'one',
    text: 'Selected: one',
    dismissedValue: undefined,
    dismissedText: 'Cancelled.',
  },
  {
    name: 'test_confirm',
    method: 'confirm',
    params: { title: 'Confirm', message: 'Continue?' },
    value: true,
    text: 'Confirmed.',
    dismissedValue: false,
    dismissedText: 'Not confirmed.',
  },
  { name: 'test_input', method: 'input', params: { title: 'Input' }, value: '', text: 'Input: ', dismissedValue: undefined, dismissedText: 'Cancelled.' },
  {
    name: 'test_editor',
    method: 'editor',
    params: { title: 'Edit' },
    value: 'two\nlines',
    text: 'Editor submitted: two\nlines',
    dismissedValue: undefined,
    dismissedText: 'Cancelled.',
  },
];

interface EmissionCase {
  name: string;
  method: 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'setEditorText';
  params: Record<string, unknown>;
  args: unknown[];
  text: string;
  payload: Record<string, unknown>;
}

const EMISSION_CASES: readonly EmissionCase[] = [
  { name: 'test_notify', method: 'notify', params: { message: 'Hello' }, args: ['Hello', 'info'], text: 'Notification sent.', payload: { message: 'Hello', type: 'info' } },
  {
    name: 'test_set_status',
    method: 'setStatus',
    params: { key: 'status', text: 'Busy' },
    args: ['status', 'Busy'],
    text: 'Status update sent: status',
    payload: { key: 'status', text: 'Busy', cleared: false },
  },
  {
    name: 'test_set_widget',
    method: 'setWidget',
    params: { key: 'widget', lines: ['Hello'] },
    args: ['widget', ['Hello'], { placement: 'aboveEditor' }],
    text: 'Widget update sent: widget',
    payload: { key: 'widget', lines: ['Hello'], placement: 'aboveEditor', cleared: false },
  },
  { name: 'test_set_title', method: 'setTitle', params: { title: 'Window' }, args: ['Window'], text: 'Title update sent.', payload: { title: 'Window' } },
  { name: 'test_set_editor_text', method: 'setEditorText', params: { text: 'Draft' }, args: ['Draft'], text: 'Editor-text update sent.', payload: { text: 'Draft' } },
];

describe('test UI tool metadata', () => {
  it('keeps human dialogs model-only and non-blocking emitters directly callable', () => {
    const h = harness();
    expect(h.tools.size).toBe(9);
    for (const { name } of DIALOG_CASES) {
      const tool = h.toolNamed(name);
      expect(tool.exposure).toBe('model-only');
      expect(tool.outputSchema).toBeUndefined();
      expect(tool.description).toContain('waits for a user response or dismissal');
      expect(tool.description).toContain('normal');
    }
    for (const { name } of EMISSION_CASES) {
      const tool = h.toolNamed(name);
      expect(tool.exposure).toBe('direct');
      expect(tool.outputSchema).toBeDefined();
      expect(tool.description).toContain('without waiting for the client');
      expect(tool.description).toContain('acknowledges the send request, not client rendering');
    }
  });

  it('retains one shared named test-only routing guideline', () => {
    const h = harness();
    const guidelines = new Set<string>();
    for (const tool of h.tools.values()) {
      expect(tool.promptSnippet).toBeTruthy();
      expect(tool.promptGuidelines).toHaveLength(1);
      for (const guideline of tool.promptGuidelines!) guidelines.add(guideline);
    }
    expect([...guidelines]).toEqual(['Use these test_* tools only when the user explicitly wants to exercise Pimote extension UI bridge behavior.']);
  });

  it('documents notification and widget defaults and the PWA placement limit', () => {
    const h = harness();
    const notify = h.toolNamed('test_notify').parameters as TObject;
    expect(notify.properties.type.default).toBe('info');
    expect(notify.properties.type.description).toContain('default info');
    const widget = h.toolNamed('test_set_widget').parameters as TObject;
    expect(widget.properties.placement.default).toBe('aboveEditor');
    expect(widget.properties.placement.description).toContain('default aboveEditor');
    expect(widget.properties.placement.description).toContain('ignored by the PWA');
    expect(widget.properties.placement.description).toContain('renders widgets as cards');
  });
});

describe('test UI dialog results', () => {
  it.each(DIALOG_CASES)('$name waits for the response and returns its text', async ({ name, method, params, value, text }) => {
    const h = harness();
    const response = deferred<unknown>();
    h.ui[method].mockReturnValue(response.promise);
    const state = { settled: false };
    const pending = h.invoke(name, params).then((result) => {
      state.settled = true;
      return result;
    });
    await Promise.resolve();
    expect(state.settled).toBe(false);
    response.resolve(value);
    const result = await pending;
    expect(result.content).toEqual([{ type: 'text', text }]);
    expect(result.details).toEqual(method === 'confirm' ? { confirmed: true } : { value, cancelled: false });
    expect(result.isError).not.toBe(true);
  });

  it.each(DIALOG_CASES)('$name treats user dismissal as a normal result', async ({ name, method, params, dismissedValue, dismissedText }) => {
    const h = harness();
    h.ui[method].mockResolvedValue(dismissedValue);
    const result = await h.invoke(name, params);
    expect(result.content).toEqual([{ type: 'text', text: dismissedText }]);
    expect(result.details).toEqual(method === 'confirm' ? { confirmed: false } : { value: undefined, cancelled: true });
    expect(result.isError).not.toBe(true);
  });

  it.each(DIALOG_CASES.filter(({ method }) => method !== 'editor'))('$name omits automatic dismissal unless a timeout is supplied', async ({ name, method, params }) => {
    const h = harness();
    await h.invoke(name, params);
    expect(h.ui[method].mock.calls[0].at(-1)).toBeUndefined();
    await h.invoke(name, { ...params, timeout: 250 });
    expect(h.ui[method].mock.calls[1].at(-1)).toEqual({ timeout: 250 });
    const tool = h.toolNamed(name);
    expect((tool.parameters as TObject).properties.timeout.description).toContain('no automatic dismissal when omitted');
    expect(Value.Check(tool.parameters, { ...params, timeout: 0 })).toBe(false);
    expect(Value.Check(tool.parameters, { ...params, timeout: 1 })).toBe(true);
  });
});

describe('test UI emission results', () => {
  it.each(EMISSION_CASES)('$name returns schema-backed send metadata without waiting for rendering', async ({ name, method, params, args, text, payload }) => {
    const h = harness();
    h.ui[method].mockImplementation(() => new Promise<void>(() => {}));
    const result = await h.invoke(name, params);
    expect(h.ui[method]).toHaveBeenCalledWith(...args);
    expect(result.content).toEqual([{ type: 'text', text }]);
    expect(result.structuredContent).toStrictEqual({ ...payload, sent: true, cancelled: false });
    expect(result.details).toBeUndefined();
    expect(Value.Check(h.toolNamed(name).outputSchema!, result.structuredContent)).toBe(true);
  });

  it.each(EMISSION_CASES)('$name returns schema-backed cancellation without emitting', async ({ name, method, params }) => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.invoke(name, params, controller.signal);
    expect(h.ui[method]).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: 'text', text: 'Cancelled.' }]);
    expect(result.structuredContent).toStrictEqual({ sent: false, cancelled: true });
    expect(result.details).toBeUndefined();
    expect(Value.Check(h.toolNamed(name).outputSchema!, result.structuredContent)).toBe(true);
  });

  it.each([{ text: undefined }, { text: '' }])('clears status for omitted or empty text: $text', async ({ text }) => {
    const h = harness();
    const result = await h.invoke('test_set_status', { key: 'status', text });
    expect(h.ui.setStatus).toHaveBeenCalledWith('status', undefined);
    expect(result.content).toEqual([{ type: 'text', text: 'Status clear request sent: status' }]);
    expect(result.structuredContent).toStrictEqual({ key: 'status', cleared: true, sent: true, cancelled: false });
    expect(result.structuredContent).not.toHaveProperty('text');
    expect(result.details).toBeUndefined();
    expect(Value.Check(h.toolNamed('test_set_status').outputSchema!, result.structuredContent)).toBe(true);
  });

  it('preserves whitespace status text as a nonempty value', async () => {
    const h = harness();
    const result = await h.invoke('test_set_status', { key: 'status', text: ' ' });
    expect(h.ui.setStatus).toHaveBeenCalledWith('status', ' ');
    expect(result.structuredContent).toMatchObject({ text: ' ', cleared: false });
  });

  it.each([{ lines: undefined }, { lines: [] }])('clears a widget for omitted or empty lines: $lines', async ({ lines }) => {
    const h = harness();
    const result = await h.invoke('test_set_widget', { key: 'widget', lines });
    expect(h.ui.setWidget).toHaveBeenCalledWith('widget', undefined, { placement: 'aboveEditor' });
    expect(result.content).toEqual([{ type: 'text', text: 'Widget clear request sent: widget' }]);
    expect(result.structuredContent).toStrictEqual({ key: 'widget', placement: 'aboveEditor', cleared: true, sent: true, cancelled: false });
    expect(result.structuredContent).not.toHaveProperty('lines');
    expect(result.details).toBeUndefined();
    expect(Value.Check(h.toolNamed('test_set_widget').outputSchema!, result.structuredContent)).toBe(true);
  });

  it('preserves an explicit notification severity', async () => {
    const h = harness();
    const result = await h.invoke('test_notify', { message: 'Warning', type: 'warning' });
    expect(h.ui.notify).toHaveBeenCalledWith('Warning', 'warning');
    expect(result.structuredContent).toMatchObject({ type: 'warning' });
  });

  it('preserves explicit widget placement and a nonempty blank line', async () => {
    const h = harness();
    const result = await h.invoke('test_set_widget', { key: 'widget', lines: [''], placement: 'belowEditor' });
    expect(h.ui.setWidget).toHaveBeenCalledWith('widget', [''], { placement: 'belowEditor' });
    expect(result.structuredContent).toMatchObject({ lines: [''], placement: 'belowEditor', cleared: false });
  });
});
