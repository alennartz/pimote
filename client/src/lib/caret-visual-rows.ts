// Visual-row checks for the composer textarea. History recall must follow what
// the user perceives as rows (soft-wrapped lines), not logical `\n` lines.
// Textareas expose no caret geometry, so the caret's row is measured in a
// hidden mirror element that replicates the textarea's wrap layout.

// Styles that change where text wraps in the mirror.
const WRAP_STYLES = [
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'font-stretch',
  'font-variant',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'text-transform',
  'text-indent',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'tab-size',
  'direction',
] as const;

function caretRowTop(target: HTMLTextAreaElement, position: number): number {
  const style = getComputedStyle(target);
  const mirror = document.createElement('div');
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.boxSizing = 'border-box';
  // clientWidth already excludes the border and a visible scrollbar, so the
  // mirror wraps text at exactly the width the textarea renders at.
  mirror.style.width = `${target.clientWidth}px`;
  for (const property of WRAP_STYLES) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.append(document.createTextNode(target.value.slice(0, position)), marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

export function caretOnFirstVisualRow(target: HTMLTextAreaElement): boolean {
  const position = target.selectionStart ?? 0;
  if (target.value.slice(0, position).includes('\n')) return false;
  return caretRowTop(target, position) === caretRowTop(target, 0);
}

export function caretOnLastVisualRow(target: HTMLTextAreaElement): boolean {
  const position = target.selectionStart ?? target.value.length;
  if (target.value.slice(position).includes('\n')) return false;
  return caretRowTop(target, position) === caretRowTop(target, target.value.length);
}
