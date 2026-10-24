export const STATIC_HOST_TOOL_SNIPPET = 'Publish HTML reports for browser reading instead of chat.';

export const STATIC_HOST_TOOL_GUIDELINES = [
  'For answers of roughly 300+ words, several paragraphs, or multiple sections, use pimote_static_host instead of long chat.',
  'For visual or interactive answers, including compact reports, use pimote_static_host instead of chat.',
  'For brief, unstructured text answers, use chat instead of pimote_static_host.',
  'For reports routed to pimote_static_host, proceed without a separate permission request.',
  'After pimote_static_host publishes a report, keep chat to a one-to-three-sentence summary plus the card.',
  'Before authoring a pimote_static_host report, read the static report design guide listed in the <pimote-docs> section.',
  'Before using pimote_static_host, keep bundle files free of secrets and calls to services that require authentication.',
];

export const STATIC_HOST_TOOL_DESCRIPTION = [
  'Serve a local HTML/asset bundle verbatim, with source edits visible without rehosting, and return {slug,url}.',
  'Slug collisions change the returned slug.',
  'Registration creates a session card and requests immediate browser navigation.',
].join(' ');

export const STATIC_HOST_REMOVE_TOOL_SNIPPET = 'Stop serving a hosted bundle that is no longer needed.';

export const STATIC_HOST_REMOVE_TOOL_DESCRIPTION = [
  'Unregister a hosted bundle owned by this session and remove its card, leaving source files intact.',
  'Returns {removed}, with false for unknown slugs or bundles owned by another session.',
].join(' ');
