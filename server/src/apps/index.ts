import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { bool, opt, str } from '@earendil-works/pi-schema';
import { toolObject } from '../tool-parameters.js';
import { AppService } from './service.js';
import {
  APP_LIST_TOOL_DESCRIPTION,
  APP_LIST_TOOL_SNIPPET,
  APP_REGISTER_TOOL_DESCRIPTION,
  APP_REGISTER_TOOL_GUIDELINES,
  APP_REGISTER_TOOL_SNIPPET,
  APP_REMOVE_TOOL_DESCRIPTION,
  APP_REMOVE_TOOL_SNIPPET,
} from './prompt.js';
import {
  executeListAppsTool,
  executeRegisterAppTool,
  executeRemoveAppTool,
  ListAppsOutputSchema,
  prepareRegisterAppArguments,
  RegisterAppOutputSchema,
  RemoveAppOutputSchema,
  type AppToolContext,
} from './tools.js';
import { MAX_APP_DESCRIPTION_LENGTH, MAX_APP_SLUG_LENGTH, MAX_APP_TITLE_LENGTH } from './validation.js';

const APP_SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';

const RegisterAppParametersSchema = toolObject({
  slug: str({
    minLength: 1,
    maxLength: MAX_APP_SLUG_LENGTH,
    pattern: APP_SLUG_PATTERN,
    description: 'Unique DNS-label slug of 1 to 63 lowercase letters, digits, and single separating hyphens.',
  }),
  title: str({
    minLength: 1,
    maxLength: MAX_APP_TITLE_LENGTH,
    description: 'Display title shown on the Pimote Home screen, up to 100 characters.',
  }),
  target: str({
    minLength: 1,
    description: 'Upstream http:// or https:// origin reachable from the Pimote host, without credentials, path, query, or hash.',
  }),
  description: opt(
    str({
      maxLength: MAX_APP_DESCRIPTION_LENGTH,
      description: 'Short summary shown on the Home card, up to 280 characters.',
    }),
  ),
  overwrite: opt(
    bool({
      default: false,
      description: 'Replace an existing App with the same slug when true, default false.',
    }),
  ),
});

const ListAppsParametersSchema = toolObject({});

const RemoveAppParametersSchema = toolObject({
  slug: str({
    minLength: 1,
    maxLength: MAX_APP_SLUG_LENGTH,
    pattern: APP_SLUG_PATTERN,
    description: 'Slug of the registered App to remove.',
  }),
});

export { AppService, type AppServiceOptions, type AppsChangeListener } from './service.js';
export { FileAppStore, type AppStore } from './store.js';
export { CaddyAdminClient, buildCaddyServerConfig, type AppRouteReconciler, type CaddyAdminClientOptions, type CaddyHttpServerConfig } from './caddy-client.js';
export {
  buildBlockedLocalPorts,
  DEFAULT_CADDY_LISTEN,
  DEFAULT_CADDY_SERVER_NAME,
  effectivePort,
  isLoopbackHost,
  MAX_APP_DESCRIPTION_LENGTH,
  MAX_APP_SLUG_LENGTH,
  MAX_APP_TITLE_LENGTH,
  parseAppsConfig,
  parseListenPort,
  renderAppHostname,
  renderPublicUrl,
  targetToCaddyDial,
  validateAppDescription,
  validateAppSlug,
  validateAppTarget,
  validateAppTitle,
  validateCaddyAdminUrl,
  validatePublicUrlTemplate,
} from './validation.js';
export type { AppInfo, AppRouteEntry, AppsConfig, AppsSnapshot, AppsSyncState, AppStoreFile, PersistedAppRecord, RegisterAppInput, UpdateAppInput } from './types.js';

export interface CreateAppsExtensionOptions {
  service: AppService;
}

/** Build the pi extension factory that exposes durable App tools when the Apps gateway is configured. */
export function createAppsExtension(options: CreateAppsExtensionOptions): ExtensionFactory {
  const { service } = options;

  function toolContext(ctx: ExtensionContext): AppToolContext {
    return {
      service,
      sessionId: ctx.sessionManager.getSessionId(),
      folderPath: ctx.cwd,
    };
  }

  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'pimote_app_register',
      label: 'Register durable app',
      description: APP_REGISTER_TOOL_DESCRIPTION,
      promptSnippet: APP_REGISTER_TOOL_SNIPPET,
      promptGuidelines: APP_REGISTER_TOOL_GUIDELINES,
      exposure: 'direct',
      executionMode: 'sequential',
      annotations: { openWorldHint: true },
      parameters: RegisterAppParametersSchema,
      prepareArguments: prepareRegisterAppArguments,
      outputSchema: RegisterAppOutputSchema,
      execute: async (_callId, input, signal, _onUpdate, ctx) => {
        return executeRegisterAppTool(input, toolContext(ctx), signal);
      },
    });

    pi.registerTool({
      name: 'pimote_app_list',
      label: 'List durable apps',
      description: APP_LIST_TOOL_DESCRIPTION,
      promptSnippet: APP_LIST_TOOL_SNIPPET,
      promptGuidelines: [],
      exposure: 'direct',
      annotations: { readOnlyHint: true },
      parameters: ListAppsParametersSchema,
      outputSchema: ListAppsOutputSchema,
      execute: async (_callId, _input, signal, _onUpdate, ctx) => {
        return executeListAppsTool(toolContext(ctx), signal);
      },
    });

    pi.registerTool({
      name: 'pimote_app_remove',
      label: 'Remove durable app',
      description: APP_REMOVE_TOOL_DESCRIPTION,
      promptSnippet: APP_REMOVE_TOOL_SNIPPET,
      promptGuidelines: [],
      exposure: 'direct',
      executionMode: 'sequential',
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      parameters: RemoveAppParametersSchema,
      outputSchema: RemoveAppOutputSchema,
      execute: async (_callId, input, signal, _onUpdate, ctx) => {
        return executeRemoveAppTool(input, toolContext(ctx), signal);
      },
    });
  };
}
