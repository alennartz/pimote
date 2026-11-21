import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { nullable, opt, str } from '@earendil-works/pi-schema';
import { Type } from 'typebox';
import type { ThemeDiagnostic, UserSummary } from '../../../shared/dist/index.js';
import { jsonToolResult, errorToolResult, type JsonToolResult } from '../tool-result.js';
import { toolObject } from '../tool-parameters.js';
import type { ManagerThemeAssignment, ManagerThemeDemoBundle, ManagerToolContext } from './types.js';

const UserSummarySchema = Type.Object({
  name: Type.String(),
  sessionCount: Type.Integer({ minimum: 0 }),
});

const ThemeAssignmentSchema = Type.Object({
  user: Type.String(),
  selectedThemeId: Type.Union([Type.String(), Type.Null()]),
  activeThemeId: Type.String(),
  themeName: Type.String(),
  colorScheme: Type.Union([Type.Literal('light'), Type.Literal('dark')]),
  source: Type.Union([Type.Literal('builtin'), Type.Literal('extension'), Type.Literal('user')]),
});

const ThemeUserErrorSchema = Type.Object({
  error: Type.String(),
  users: Type.Array(UserSummarySchema),
});

const ThemeDiagnosticSchema = Type.Object({
  path: Type.String(),
  message: Type.String(),
  themeId: Type.Optional(Type.String()),
  source: Type.Optional(Type.Union([Type.Literal('builtin'), Type.Literal('extension'), Type.Literal('user')])),
});

const ThemeDemoSuccessSchema = Type.Object({
  slug: Type.String(),
  url: Type.String(),
  themeIds: Type.Array(Type.String()),
  diagnostics: Type.Array(ThemeDiagnosticSchema),
});

const ThemeDemoErrorSchema = Type.Object({
  error: Type.String(),
  diagnostics: Type.Optional(Type.Array(ThemeDiagnosticSchema)),
});

const SetThemeParametersSchema = toolObject({
  user: opt(str({ description: 'Known Pimote username. Omit only when the known-user list contains exactly the default user.' })),
  themeId: nullable(str({ description: 'Available theme ID to save for the user; null clears the saved override and follows the server default.' })),
});

const ThemeDemoParametersSchema = toolObject({
  path: str({ description: 'Absolute or ~-prefixed path to a version 1 theme file. Every valid theme in the file appears in the hosted preview.' }),
});

const MAX_MODEL_USERS = 100;
const MAX_MODEL_DIAGNOSTICS = 50;
const MAX_MODEL_THEME_IDS = 100;

type NestedToolResult = {
  isError?: boolean;
  result?: {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
};

type ToolExecutionContext = {
  executeTool?: (name: string, args: unknown, options?: { signal?: AbortSignal }) => Promise<NestedToolResult>;
};

function knownUserError(message: string, users: readonly UserSummary[]): JsonToolResult {
  const payload = { error: message, users: users.map((user) => ({ ...user })) };
  const inlineUsers = payload.users.slice(0, MAX_MODEL_USERS);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: message,
          users: inlineUsers,
          ...(inlineUsers.length < payload.users.length ? { warning: `Showing ${inlineUsers.length} of ${payload.users.length} known users.` } : {}),
        }),
      },
    ],
    details: { totalUsers: payload.users.length, inlineUsers: inlineUsers.length },
    structuredContent: payload,
    isError: true,
  };
}

function resolveKnownUser(requested: unknown, users: readonly UserSummary[]): { user: string } | { error: string; users: UserSummary[] } {
  const snapshot = users.map((user) => ({ ...user }));
  if (requested !== undefined) {
    const name = typeof requested === 'string' ? requested.trim() : '';
    if (name !== '' && users.some((user) => user.name === name)) return { user: name };
    return { error: `Unknown user ${JSON.stringify(name)}. Specify a known user.`, users: snapshot };
  }
  if (users.length === 1 && users[0]?.name === 'default') return { user: 'default' };
  return {
    error: users.length === 0 ? 'No known users are available. Specify a known user.' : 'Specify a known user because the target is ambiguous.',
    users: snapshot,
  };
}

function nestedResult(result: NestedToolResult): NonNullable<NestedToolResult['result']> | NestedToolResult {
  return result.result ?? result;
}

function nestedErrorMessage(result: NestedToolResult): string {
  const nested = nestedResult(result);
  const structured = nested.structuredContent;
  if (structured && typeof structured === 'object' && typeof (structured as { error?: unknown }).error === 'string') return (structured as { error: string }).error;
  const text = nested.content?.find((item) => item.type === 'text')?.text;
  return text ?? 'static host rejected the bundle';
}

function hostedRegistration(value: unknown): { slug: string; url: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { slug?: unknown; url?: unknown };
  if (typeof candidate.slug !== 'string' || typeof candidate.url !== 'string') return undefined;
  return { slug: candidate.slug, url: candidate.url };
}

function prepareThemeDemoArgs(bundle: ManagerThemeDemoBundle): Record<string, unknown> {
  return {
    slug: 'theme-demo',
    folder: bundle.folderPath,
    title: bundle.title,
    tag: 'theme',
    color: 'accent',
  };
}

function themeDemoError(message: string, diagnostics: readonly ThemeDiagnostic[]): JsonToolResult {
  const payload = { error: message, diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })) };
  const inlineDiagnostics = payload.diagnostics.slice(0, MAX_MODEL_DIAGNOSTICS);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: message,
          diagnostics: inlineDiagnostics,
          ...(inlineDiagnostics.length < payload.diagnostics.length ? { warning: `Showing ${inlineDiagnostics.length} of ${payload.diagnostics.length} diagnostics.` } : {}),
        }),
      },
    ],
    details: { totalDiagnostics: payload.diagnostics.length, inlineDiagnostics: inlineDiagnostics.length },
    structuredContent: payload,
    isError: true,
  };
}

/** Register the manager's deferred theme tools and the discovery tool they need. */
export function registerManagerThemeTools(pi: ExtensionAPI, context: ManagerToolContext): void {
  pi.registerTool({
    name: 'pimote_set_theme',
    label: 'Set user theme',
    exposure: 'deferred',
    promptSnippet: "Assign a known user's active Pimote appearance theme.",
    description:
      'Saves an available theme ID for one existing Pimote user, or clears the saved override with null. ' +
      'When user is omitted, the call succeeds only when default is the sole known user; ambiguous or unknown targets return the known-user list without changing any profile.',
    parameters: SetThemeParametersSchema,
    annotations: { idempotentHint: true },
    outputSchema: Type.Union([ThemeAssignmentSchema, ThemeUserErrorSchema]),
    execute: async (_callId, params): Promise<JsonToolResult> => {
      const input = params as { user?: string; themeId: string | null };
      const themePort = context.themes;
      let users: UserSummary[];
      try {
        users = themePort.listKnownUsers();
      } catch (error) {
        return knownUserError(`Failed to list known users: ${error instanceof Error ? error.message : String(error)}`, []);
      }
      const target = resolveKnownUser(input.user, users);
      if ('error' in target) return knownUserError(target.error, target.users);
      try {
        const result: ManagerThemeAssignment = await themePort.setKnownUserTheme(target.user, input.themeId);
        return jsonToolResult(result);
      } catch (error) {
        return knownUserError(`Failed to set theme for ${target.user}: ${error instanceof Error ? error.message : String(error)}`, users);
      }
    },
  });

  pi.registerTool({
    name: 'pimote_theme_demo',
    label: 'Preview theme file',
    exposure: 'deferred',
    promptSnippet: 'Open a visual static preview for a draft theme file.',
    description:
      'Builds a static visual preview containing every valid theme in the supplied file, then registers it with the existing static host. ' +
      'The result includes the hosted slug and URL, theme IDs, and diagnostics for invalid entries; the source file is not changed.',
    parameters: ThemeDemoParametersSchema,
    reachesTools: () => ['pimote_static_host'],
    annotations: { idempotentHint: true },
    outputSchema: Type.Union([ThemeDemoSuccessSchema, ThemeDemoErrorSchema]),
    execute: async (_callId, params, signal, _onUpdate, rawContext): Promise<JsonToolResult> => {
      signal?.throwIfAborted();
      let bundle: ManagerThemeDemoBundle;
      try {
        bundle = await context.themes.prepareDemo(params.path, signal);
      } catch (error) {
        return errorToolResult(`failed to prepare theme demo: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (bundle.themeIds.length === 0) return themeDemoError('Theme file contains no valid themes.', bundle.diagnostics);

      const executeTool = (rawContext as ToolExecutionContext | undefined)?.executeTool;
      if (!executeTool) return errorToolResult('static host is unavailable in this manager session');
      let hosted: NestedToolResult;
      try {
        hosted = await executeTool('pimote_static_host', prepareThemeDemoArgs(bundle), { signal });
      } catch (error) {
        return errorToolResult(`failed to host theme demo: ${error instanceof Error ? error.message : String(error)}`);
      }
      const nested = nestedResult(hosted);
      if (hosted.isError || nested.isError) return errorToolResult(`failed to host theme demo: ${nestedErrorMessage(hosted)}`);
      const registration = hostedRegistration(nested.structuredContent);
      if (!registration) return errorToolResult('static host returned an invalid registration');
      const payload = { ...registration, themeIds: bundle.themeIds, diagnostics: bundle.diagnostics };
      const inlineDiagnostics = bundle.diagnostics.slice(0, MAX_MODEL_DIAGNOSTICS);
      const inlineThemeIds = bundle.themeIds.slice(0, MAX_MODEL_THEME_IDS);
      return jsonToolResult(payload, {
        modelView: {
          ...registration,
          themeIds: inlineThemeIds,
          diagnostics: inlineDiagnostics,
          ...(inlineThemeIds.length < bundle.themeIds.length || inlineDiagnostics.length < bundle.diagnostics.length
            ? { warning: 'The structured result contains additional theme IDs or diagnostics.' }
            : {}),
        },
        details: {
          totalThemeIds: bundle.themeIds.length,
          inlineThemeIds: inlineThemeIds.length,
          totalDiagnostics: bundle.diagnostics.length,
          inlineDiagnostics: inlineDiagnostics.length,
        },
      });
    },
  });

  pi.on('session_start', () => {
    const active = pi.getActiveTools();
    if (!active.includes('tool_search')) pi.setActiveTools([...active, 'tool_search']);
  });
}
