import Convert from 'ansi-to-html';

const converter = new Convert({ fg: 'inherit', bg: 'transparent', escapeXML: true, newline: true });

export function ansiToHtml(text: string): string {
  return converter.toHtml(text);
}
