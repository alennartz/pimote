import Convert from 'ansi-to-html';

const terminalRoles = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
] as const;
const standardRgb = [
  [0, 0, 0],
  [170, 0, 0],
  [0, 170, 0],
  [170, 85, 0],
  [0, 0, 170],
  [170, 0, 170],
  [0, 170, 170],
  [170, 170, 170],
  [85, 85, 85],
  [255, 85, 85],
  [85, 255, 85],
  [255, 255, 85],
  [85, 85, 255],
  [255, 85, 255],
  [85, 255, 255],
  [255, 255, 255],
] as const;
function rgbText(rgb: readonly number[]): string {
  const shorthand = rgb.every((channel) => channel % 17 === 0);
  if (shorthand)
    return `#${rgb
      .map((channel) => (channel / 17).toString(16))
      .join('')
      .toUpperCase()}`;
  return `#${rgb
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}
const standardColors = standardRgb.map(rgbText);

function ansiColors(useTheme: boolean): Record<number, string> {
  const colors: Record<number, string> = {};
  terminalRoles.forEach((role, index) => {
    colors[index] = useTheme ? `var(--pimote-terminal-${role}, ${standardColors[index]})` : standardColors[index];
  });
  const cube = [0, 95, 135, 175, 215, 255];
  for (let red = 0; red < 6; red += 1) {
    for (let green = 0; green < 6; green += 1) {
      for (let blue = 0; blue < 6; blue += 1) {
        colors[16 + red * 36 + green * 6 + blue] = `rgb(${cube[red]}, ${cube[green]}, ${cube[blue]})`;
      }
    }
  }
  for (let gray = 0; gray < 24; gray += 1) {
    const level = gray * 10 + 8;
    colors[232 + gray] = `rgb(${level}, ${level}, ${level})`;
  }
  return colors;
}

const converter = new Convert({ fg: 'inherit', bg: 'transparent', escapeXML: true, newline: true, colors: ansiColors(false) });
const themedConverter = new Convert({ fg: 'inherit', bg: 'transparent', escapeXML: true, newline: true, colors: ansiColors(true) });
const indexedBase = [
  [0, 0, 0],
  [170, 0, 0],
  [0, 170, 0],
  [170, 85, 0],
  [0, 0, 170],
  [170, 0, 170],
  [0, 170, 170],
  [170, 170, 170],
  [85, 85, 85],
  [255, 85, 85],
  [85, 255, 85],
  [255, 255, 85],
  [85, 85, 255],
  [255, 85, 255],
  [85, 255, 255],
  [255, 255, 255],
] as const;

/** Keep indexed 0–15 ANSI semantics stable while direct SGR slots follow the theme. */
function preserveIndexedBase(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape is the input format
  return text.replace(/\u001b\[(38|48);5;(\d{1,3})m/g, (whole, channel: string, rawIndex: string) => {
    const index = Number(rawIndex);
    const rgb = indexedBase[index];
    if (!rgb) return whole;
    return `\u001b[${channel};2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  });
}

function themeInstalled(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.style.getPropertyValue('--pimote-terminal-black').trim() !== '';
}

export function ansiToHtml(text: string): string {
  return (themeInstalled() ? themedConverter : converter).toHtml(preserveIndexedBase(text));
}

// ECMA-48 CSI sequences: ESC [ parameters, intermediates, final byte.
// eslint-disable-next-line no-control-regex -- control characters are the input this rule pattern matches
const ANSI_CSI_PATTERN = /\u001B\[[\d;:?<=>]*[ -/]*[@-~]/g;

/** Remove ANSI escape sequences, e.g. for clipboard copies of styled output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_PATTERN, '');
}
