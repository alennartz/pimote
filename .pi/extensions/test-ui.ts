import type { ExtensionAPI, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent';
import { StringEnum, type JsonValue } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

const TEST_TOOL_GUIDELINES = ['Use these test_* tools only when the user explicitly wants to exercise Pimote extension UI bridge behavior.'];

const notifyTypeSchema = StringEnum(['info', 'warning', 'error'] as const);
const widgetPlacementSchema = StringEnum(['aboveEditor', 'belowEditor'] as const);
const timeoutSchema = Type.Optional(Type.Integer({ minimum: 1, description: 'Auto-dismiss timeout in milliseconds, with no automatic dismissal when omitted.' }));
const EMISSION_STATE_FIELDS = { sent: Type.Boolean(), cancelled: Type.Boolean() };

function dialogOptions(timeout?: number): ExtensionUIDialogOptions | undefined {
  return timeout === undefined ? undefined : { timeout };
}

function textResult(text: string, details: Record<string, unknown> | undefined) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

function emissionResult(text: string, payload: Record<string, JsonValue>, sent = true) {
  return { ...textResult(text, undefined), structuredContent: { ...payload, sent, cancelled: !sent } };
}

const CANCELLED = textResult('Cancelled.', { cancelled: true });
const EMISSION_CANCELLED = emissionResult('Cancelled.', {}, false);

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
  pi.registerTool({
    name: 'test_select',
    label: 'Test Select',
    description: 'Opens a selection dialog and waits for a user response or dismissal. Returns "Selected: <value>" or "Cancelled.", with dismissal treated as a normal result.',
    promptSnippet: 'Show a test select dialog via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    exposure: 'model-only',
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

  pi.registerTool({
    name: 'test_confirm',
    label: 'Test Confirm',
    description:
      'Opens a confirmation dialog and waits for a user response or dismissal. Returns "Confirmed." for approval or "Not confirmed." for rejection and normal dismissal. Interruption returns "Cancelled.".',
    promptSnippet: 'Show a test confirm dialog via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    exposure: 'model-only',
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

  pi.registerTool({
    name: 'test_input',
    label: 'Test Input',
    description: 'Opens a text-input dialog and waits for a user response or dismissal. Returns "Input: <value>" or "Cancelled.", with dismissal treated as a normal result.',
    promptSnippet: 'Show a test input dialog via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    exposure: 'model-only',
    parameters: Type.Object({
      title: Type.String({ description: 'Dialog title.' }),
      placeholder: Type.Optional(Type.String({ description: 'Placeholder text, default no placeholder.' })),
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

  pi.registerTool({
    name: 'test_editor',
    label: 'Test Editor',
    description:
      'Opens a multi-line editor and waits for a user response or dismissal. Returns "Editor submitted: <value>" or "Cancelled.", with dismissal treated as a normal result.',
    promptSnippet: 'Show a test multi-line editor dialog via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    exposure: 'model-only',
    parameters: Type.Object({
      title: Type.String({ description: 'Dialog title.' }),
      prefill: Type.Optional(Type.String({ description: 'Initial editor text, default empty.' })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return CANCELLED;
      const value = await raceSignal(ctx.ui.editor(params.title, params.prefill), signal);
      if (value === ABORTED) return CANCELLED;
      return textResult(value === undefined ? 'Cancelled.' : `Editor submitted: ${value}`, {
        value,
        cancelled: value === undefined,
      });
    },
  });

  pi.registerTool({
    name: 'test_notify',
    label: 'Test Notify',
    description:
      'Sends a notification request without waiting for the client. Returns {sent,cancelled,message?,type?}, where sent acknowledges the send request, not client rendering.',
    promptSnippet: 'Show a test notification via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    exposure: 'direct',
    parameters: Type.Object({
      message: Type.String({ description: 'Notification text.' }),
      type: Type.Optional({ ...notifyTypeSchema, description: 'Notification severity, default info.', default: 'info' }),
    }),
    outputSchema: Type.Object({
      ...EMISSION_STATE_FIELDS,
      message: Type.Optional(Type.String()),
      type: Type.Optional(notifyTypeSchema),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return EMISSION_CANCELLED;
      const type = params.type ?? 'info';
      ctx.ui.notify(params.message, type);
      return emissionResult('Notification sent.', { message: params.message, type });
    },
  });

  pi.registerTool({
    name: 'test_set_status',
    label: 'Test Set Status',
    description:
      'Sends a status-entry update without waiting for the client. Returns {sent,cancelled,key?,text?,cleared?}, where sent acknowledges the send request, not client rendering.',
    promptSnippet: 'Set or clear a test status entry via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    exposure: 'direct',
    parameters: Type.Object({
      key: Type.String({ description: 'Status entry key.' }),
      text: Type.Optional(Type.String({ description: 'Status text, with omission or an empty string clearing the entry.' })),
    }),
    outputSchema: Type.Object({
      ...EMISSION_STATE_FIELDS,
      key: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      cleared: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return EMISSION_CANCELLED;
      const text = params.text || undefined;
      const cleared = text === undefined;
      ctx.ui.setStatus(params.key, text);
      const payload: Record<string, JsonValue> = text === undefined ? { key: params.key, cleared } : { key: params.key, text, cleared };
      return emissionResult(cleared ? `Status clear request sent: ${params.key}` : `Status update sent: ${params.key}`, payload);
    },
  });

  pi.registerTool({
    name: 'test_set_widget',
    label: 'Test Set Widget',
    description:
      'Sends a string-line widget update without waiting for the client. Returns {sent,cancelled,key?,lines?,placement?,cleared?}, where sent acknowledges the send request, not client rendering.',
    promptSnippet: 'Set or clear a test widget via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    exposure: 'direct',
    parameters: Type.Object({
      key: Type.String({ description: 'Widget key.' }),
      lines: Type.Optional(Type.Array(Type.String(), { description: 'Widget lines, with omission or [] clearing the widget.' })),
      placement: Type.Optional({
        ...widgetPlacementSchema,
        description: 'Terminal placement, aboveEditor or belowEditor (default aboveEditor), ignored by the PWA, which renders widgets as cards.',
        default: 'aboveEditor',
      }),
    }),
    outputSchema: Type.Object({
      ...EMISSION_STATE_FIELDS,
      key: Type.Optional(Type.String()),
      lines: Type.Optional(Type.Array(Type.String())),
      placement: Type.Optional(widgetPlacementSchema),
      cleared: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return EMISSION_CANCELLED;
      const lines = params.lines?.length ? params.lines : undefined;
      const placement = params.placement ?? 'aboveEditor';
      const cleared = lines === undefined;
      ctx.ui.setWidget(params.key, lines, { placement });
      const payload: Record<string, JsonValue> = lines === undefined ? { key: params.key, placement, cleared } : { key: params.key, lines, placement, cleared };
      return emissionResult(cleared ? `Widget clear request sent: ${params.key}` : `Widget update sent: ${params.key}`, payload);
    },
  });

  pi.registerTool({
    name: 'test_set_title',
    label: 'Test Set Title',
    description: 'Sends a window-title update without waiting for the client. Returns {sent,cancelled,title?}, where sent acknowledges the send request, not client rendering.',
    promptSnippet: 'Set a test window title via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    exposure: 'direct',
    parameters: Type.Object({
      title: Type.String({ description: 'Window title.' }),
    }),
    outputSchema: Type.Object({ ...EMISSION_STATE_FIELDS, title: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return EMISSION_CANCELLED;
      ctx.ui.setTitle(params.title);
      return emissionResult('Title update sent.', { title: params.title });
    },
  });

  pi.registerTool({
    name: 'test_set_editor_text',
    label: 'Test Set Editor Text',
    description: 'Sends an editor-text update without waiting for the client. Returns {sent,cancelled,text?}, where sent acknowledges the send request, not client rendering.',
    promptSnippet: 'Prefill the editor with test text via the extension UI bridge',
    promptGuidelines: TEST_TOOL_GUIDELINES,
    exposure: 'direct',
    parameters: Type.Object({
      text: Type.String({ description: 'Editor text to inject.' }),
    }),
    outputSchema: Type.Object({ ...EMISSION_STATE_FIELDS, text: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return EMISSION_CANCELLED;
      ctx.ui.setEditorText(params.text);
      return emissionResult('Editor-text update sent.', { text: params.text });
    },
  });
}
