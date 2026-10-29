const SVG_NS = 'http://www.w3.org/2000/svg';

type IconNode = readonly [string, Readonly<Record<string, string>>][];

const COPY_ICON: IconNode = [
  ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
  ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
];

const CHECK_ICON: IconNode = [['path', { d: 'M20 6 9 17l-5-5' }]];

function createIcon(name: 'copy' | 'check', nodes: IconNode): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `lucide-icon lucide lucide-${name}`);

  for (const [tagName, attributes] of nodes) {
    const node = document.createElementNS(SVG_NS, tagName);
    for (const [attribute, value] of Object.entries(attributes)) {
      node.setAttribute(attribute, value);
    }
    svg.append(node);
  }

  return svg;
}

export function setCopyIcon(button: HTMLElement, copied: boolean): void {
  button.replaceChildren(createIcon(copied ? 'check' : 'copy', copied ? CHECK_ICON : COPY_ICON));
}
