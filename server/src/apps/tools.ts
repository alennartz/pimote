import { Type } from 'typebox';
import { errorToolResult, jsonToolResult, type JsonToolResult } from '../tool-result.js';
import type { AppService } from './service.js';

export const AppInfoOutputSchema = Type.Object({
  slug: Type.String(),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  target: Type.String(),
  url: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  createdBySessionId: Type.Optional(Type.String()),
  folderPath: Type.Optional(Type.String()),
});

export const AppsSyncStateOutputSchema = Type.Object({
  status: Type.Union([Type.Literal('synced'), Type.Literal('error')]),
  lastSyncedAt: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});

export interface RegisterAppToolInput {
  slug: string;
  title: string;
  target: string;
  description?: string;
  icon?: string;
  overwrite?: boolean;
}

export const RegisterAppOutputSchema = Type.Object({
  app: AppInfoOutputSchema,
  sync: AppsSyncStateOutputSchema,
});

export const ListAppsOutputSchema = Type.Object({
  apps: Type.Array(AppInfoOutputSchema),
  sync: AppsSyncStateOutputSchema,
});

export interface RemoveAppToolInput {
  slug: string;
}

export const RemoveAppOutputSchema = Type.Object({
  removed: Type.Boolean(),
  sync: AppsSyncStateOutputSchema,
});

/** Normalize blank optional string fields to omitted before schema validation. */
export function prepareRegisterAppArguments(args: unknown): RegisterAppToolInput {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args as RegisterAppToolInput;
  const record = args as Record<string, unknown>;
  let rest = record;
  if (typeof rest.description === 'string' && rest.description.trim() === '') {
    const { description: _omitted, ...remaining } = rest;
    rest = remaining;
  }
  if (typeof rest.icon === 'string' && rest.icon.trim() === '') {
    const { icon: _omitted, ...remaining } = rest;
    rest = remaining;
  }
  return rest as unknown as RegisterAppToolInput;
}

export interface AppToolContext {
  service: AppService;
  sessionId: string;
  folderPath?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeRegisterAppTool(input: RegisterAppToolInput, context: AppToolContext, signal?: AbortSignal): Promise<JsonToolResult> {
  signal?.throwIfAborted();
  try {
    const result = await context.service.register({
      slug: input.slug,
      title: input.title,
      target: input.target,
      description: input.description,
      icon: input.icon,
      overwrite: input.overwrite ?? false,
      createdBySessionId: context.sessionId,
      folderPath: context.folderPath,
    });
    return jsonToolResult(result);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    return errorToolResult(errorMessage(error));
  }
}

export function executeListAppsTool(context: AppToolContext, signal?: AbortSignal): JsonToolResult {
  signal?.throwIfAborted();
  return jsonToolResult(context.service.snapshot());
}

export async function executeRemoveAppTool(input: RemoveAppToolInput, context: AppToolContext, signal?: AbortSignal): Promise<JsonToolResult> {
  signal?.throwIfAborted();
  try {
    const result = await context.service.remove(input.slug);
    return jsonToolResult(result);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    return errorToolResult(errorMessage(error));
  }
}
