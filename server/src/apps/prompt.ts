export const APP_REGISTER_TOOL_SNIPPET = 'Register a durable web app on its own origin instead of a session report.';

export const APP_REGISTER_TOOL_GUIDELINES = [
  'For durable web applications that outlive the current session, use pimote_app_register instead of pimote_static_host.',
  'For ephemeral HTML reports tied to the current session, use pimote_static_host instead of pimote_app_register.',
  'Before using pimote_app_register, read the Apps guide listed in the <pimote-docs> section.',
];

export const APP_REGISTER_TOOL_DESCRIPTION = [
  'Persists a durable App backed by an HTTP or HTTPS origin, reconciles its Caddy route, and returns {app, sync}.',
  'Rejects an existing slug unless overwrite is true, blocks Pimote, Caddy, and metadata targets, and rejects non-root target paths.',
  'Accepts an optional icon image URL that Pimote proxies same-origin for the Home tile.',
  'When Caddy is unreachable, the App stays persisted with sync.status set to "error" and sync.error set to the failure message.',
].join(' ');

export const APP_LIST_TOOL_SNIPPET = 'List registered durable apps, their public URLs, targets, and Caddy sync state.';

export const APP_LIST_TOOL_DESCRIPTION = 'Returns all registered durable Apps sorted by title then slug along with the current Caddy route sync state as {apps, sync}.';

export const APP_REMOVE_TOOL_SNIPPET = 'Unregister a durable app and remove its Caddy route permanently.';

export const APP_REMOVE_TOOL_DESCRIPTION = [
  'Deletes a registered App by slug from Pimote storage, reconciles Caddy to drop its route, and returns {removed, sync}.',
  'Returns removed=false when the slug is not registered, leaving the upstream process untouched.',
].join(' ');
