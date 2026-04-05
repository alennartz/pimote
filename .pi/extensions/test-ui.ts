import type { ExtensionAPI, ExtensionUIDialogOptions, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { StringEnum } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';

const TEST_TOOL_GUIDELINES = ['Use these test_* tools only when the user explicitly wants to exercise Pimote extension UI bridge behavior.'];

const notifyTypeSchema = StringEnum(['info', 'warning', 'error'] as const);
const widgetPlacementSchema = StringEnum(['aboveEditor', 'belowEditor'] as const);
const timeoutSchema = Type.Optional(Type.Integer({ minimum: 1, description: 'Auto-dismiss timeout in milliseconds.' }));

function dialogOptions(timeout?: number): ExtensionUIDialogOptions | undefined {
  return timeout === undefined ? undefined : { timeout };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerTool(pi: ExtensionAPI, tool: ToolDefinition<any>) {
  pi.registerTool(tool);
}

function textResult(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

const CANCELLED = textResult('Cancelled.', { cancelled: true });

const ABORTED = Symbol('aborted');

function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return Promise.race([
    promise,
    new Promise<typeof ABORTED>((resolve) => {
      signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
    }),
  ]);
}

export default function testUiExtension(pi: ExtensionAPI) {
  registerTool(pi, {
    name: 'test_select',
    label: 'Test Select',
    description: 'Exercise ctx.ui.select() through the extension UI bridge.',
    promptSnippet: 'Show a test select dialog via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    parameters: Type.Object({
      title: Type.String({ description: 'Dialog title.' }),
      options: Type.Array(Type.String(), { minItems: 1, description: 'Selectable string options.' }),
      timeout: timeoutSchema,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return CANCELLED;
      const value = await raceSignal(ctx.ui.select(params.title, params.options, dialogOptions(params.timeout)), signal);
      if (value === ABORTED) return CANCELLED;
      return textResult(value === undefined ? 'Cancelled.' : `Selected: ${value}`, {
        value,
        cancelled: value === undefined,
      });
    },
  });

  registerTool(pi, {
    name: 'test_confirm',
    label: 'Test Confirm',
    description: 'Exercise ctx.ui.confirm() through the extension UI bridge.',
    promptSnippet: 'Show a test confirm dialog via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    parameters: Type.Object({
      title: Type.String({ description: 'Dialog title.' }),
      message: Type.String({ description: 'Confirmation message.' }),
      timeout: timeoutSchema,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return CANCELLED;
      const confirmed = await raceSignal(ctx.ui.confirm(params.title, params.message, dialogOptions(params.timeout)), signal);
      if (confirmed === ABORTED) return CANCELLED;
      return textResult(confirmed ? 'Confirmed.' : 'Not confirmed.', { confirmed });
    },
  });

  registerTool(pi, {
    name: 'test_input',
    label: 'Test Input',
    description: 'Exercise ctx.ui.input() through the extension UI bridge.',
    promptSnippet: 'Show a test input dialog via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    parameters: Type.Object({
      title: Type.String({ description: 'Dialog title.' }),
      placeholder: Type.Optional(Type.String({ description: 'Optional placeholder text.' })),
      timeout: timeoutSchema,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return CANCELLED;
      const value = await raceSignal(ctx.ui.input(params.title, params.placeholder, dialogOptions(params.timeout)), signal);
      if (value === ABORTED) return CANCELLED;
      return textResult(value === undefined ? 'Cancelled.' : `Input: ${value}`, {
        value,
        cancelled: value === undefined,
      });
    },
  });

  registerTool(pi, {
    name: 'test_editor',
    label: 'Test Editor',
    description: 'Exercise ctx.ui.editor() through the extension UI bridge.',
    promptSnippet: 'Show a test multi-line editor dialog via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    parameters: Type.Object({
      title: Type.String({ description: 'Dialog title.' }),
      prefill: Type.Optional(Type.String({ description: 'Optional prefilled editor text.' })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return CANCELLED;
      const value = await raceSignal(ctx.ui.editor(params.title, params.prefill), signal);
      if (value === ABORTED) return CANCELLED;
      return textResult(value === undefined ? 'Cancelled.' : 'Editor submitted.', {
        value,
        cancelled: value === undefined,
      });
    },
  });

  registerTool(pi, {
    name: 'test_notify',
    label: 'Test Notify',
    description: 'Exercise ctx.ui.notify() through the extension UI bridge.',
    promptSnippet: 'Show a test notification via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    parameters: Type.Object({
      message: Type.String({ description: 'Notification text.' }),
      type: Type.Optional(notifyTypeSchema),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return CANCELLED;
      ctx.ui.notify(params.message, params.type);
      return textResult('Notification sent.', {
        message: params.message,
        type: params.type ?? 'info',
      });
    },
  });

  registerTool(pi, {
    name: 'test_set_status',
    label: 'Test Set Status',
    description: 'Exercise ctx.ui.setStatus() through the extension UI bridge.',
    promptSnippet: 'Set or clear a test status entry via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    parameters: Type.Object({
      key: Type.String({ description: 'Status entry key.' }),
      text: Type.Optional(Type.String({ description: 'Status text. Omit to clear.' })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return CANCELLED;
      ctx.ui.setStatus(params.key, params.text);
      return textResult(params.text === undefined ? `Cleared status: ${params.key}` : `Set status: ${params.key}`, {
        key: params.key,
        text: params.text,
      });
    },
  });

  registerTool(pi, {
    name: 'test_set_widget',
    label: 'Test Set Widget',
    description: 'Exercise ctx.ui.setWidget() with string lines through the extension UI bridge.',
    promptSnippet: 'Set or clear a test widget via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    parameters: Type.Object({
      key: Type.String({ description: 'Widget key.' }),
      lines: Type.Optional(Type.Array(Type.String(), { description: 'Widget lines. Omit or pass [] to clear.' })),
      placement: Type.Optional(widgetPlacementSchema),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return CANCELLED;
      ctx.ui.setWidget(params.key, params.lines, params.placement ? { placement: params.placement } : undefined);
      const cleared = params.lines === undefined || params.lines.length === 0;
      return textResult(cleared ? `Cleared widget: ${params.key}` : `Set widget: ${params.key}`, {
        key: params.key,
        lines: params.lines,
        placement: params.placement ?? 'aboveEditor',
      });
    },
  });

  registerTool(pi, {
    name: 'test_set_title',
    label: 'Test Set Title',
    description: 'Exercise ctx.ui.setTitle() through the extension UI bridge.',
    promptSnippet: 'Set a test window title via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    parameters: Type.Object({
      title: Type.String({ description: 'Window title.' }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return CANCELLED;
      ctx.ui.setTitle(params.title);
      return textResult('Title set.', { title: params.title });
    },
  });

  registerTool(pi, {
    name: 'test_set_editor_text',
    label: 'Test Set Editor Text',
    description: 'Exercise ctx.ui.setEditorText() through the extension UI bridge.',
    promptSnippet: 'Prefill the editor with test text via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    parameters: Type.Object({
      text: Type.String({ description: 'Editor text to inject.' }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return CANCELLED;
      ctx.ui.setEditorText(params.text);
      return textResult('Editor text set.', { text: params.text });
    },
  });
}
