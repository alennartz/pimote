import Convert from 'ansi-to-html';

const converter = new Convert({ fg: 'inherit', bg: 'transparent', escapeXML: true, newline: true });

export function ansiToHtml(text: string): string {
  return converter.toHtml(text);
}

// ECMA-48 CSI sequences: ESC [ parameters, intermediates, final byte.
// eslint-disable-next-line no-control-regex -- control characters are the input this rule pattern matches
const ANSI_CSI_PATTERN = /\u001B\[[\d;:?<=>]*[ -/]*[@-~]/g;

/** Remove ANSI escape sequences, e.g. for clipboard copies of styled output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_PATTERN, '');
}
