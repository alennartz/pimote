export const FILE_DOWNLOAD_TOOL_SNIPPET = 'Offer a file download instead of a browser report.';

export const FILE_DOWNLOAD_TOOL_GUIDELINES = ['For pending pimote_send_file offers, keep their source files available and unchanged.'];

export const FILE_DOWNLOAD_TOOL_DESCRIPTION = [
  'Offer a server-readable file as a one-shot native browser download that requires an explicit user click or approval.',
  'Returns {id,filename,sizeBytes}, not a URL, without waiting for a click.',
  'The server reads the live source file when the user acts.',
].join(' ');

export const CANCEL_FILE_SEND_TOOL_SNIPPET = 'Withdraw a file download offer that is no longer needed.';

export const CANCEL_FILE_SEND_TOOL_DESCRIPTION = [
  'Revoke a pending download offer owned by this session.',
  'Returns {cancelled}, with false for unknown, consumed, previously cancelled, or other-session offers.',
].join(' ');
