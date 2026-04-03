/** Convert raw markdown to speakable plain text. */
export function markdownToSpeech(markdown: string): string {
  let text = markdown;

  // 1. Replace fenced code blocks with summary
  text = text.replace(/^```(\w*)\n([\s\S]*?)^```/gm, (_match, lang: string, content: string) => {
    const lines = content ? content.replace(/\n$/, '').split('\n') : [];
    // An empty code block (nothing between fences) has 0 lines
    const lineCount = content.trim() === '' ? 0 : lines.length;
    return lang ? `Code block, ${lineCount} lines, ${lang}.` : `Code block, ${lineCount} lines.`;
  });

  // 2. Strip HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // 3. Replace images ![alt](url) → alt text (or empty if no alt)
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 4. Replace links [text](url) → text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 5. Strip header markers at start of line
  text = text.replace(/^#{1,6}\s+/gm, '');

  // 6. Strip horizontal rules
  text = text.replace(/^(?:---|\*\*\*|___)$/gm, '');

  // 7. Convert tables: detect |‑delimited rows, parse header + separator + data rows
  text = text.replace(/(?:^\|.+\|[ \t]*(?:\n|$))+/gm, (tableBlock: string) => {
    const rows = tableBlock
      .trim()
      .split('\n')
      .map((row) =>
        row
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim()),
      );

    if (rows.length < 2) return '';

    const headers = rows[0];

    // Check if second row is a separator (all cells are dashes/colons)
    const isSeparator = rows[1].every((cell) => /^[:-][-:]*$/.test(cell));
    if (!isSeparator) return '';

    const dataRows = rows.slice(2);
    if (dataRows.length === 0) return '';

    return dataRows.map((row) => headers.map((header, i) => `${header}: ${row[i] ?? ''}.`).join(' ')).join('\n') + '\n';
  });

  // 8. Process list items: strip bullet/number, append . if needed
  text = text.replace(/^([-*+]|\d+\.)\s+(.*)/gm, (_match, _bullet: string, content: string) => {
    const trimmed = content.trimEnd();
    if (trimmed && !/[.!?:]$/.test(trimmed)) {
      return trimmed + '.';
    }
    return trimmed;
  });

  // 9. Strip formatting markers (order matters — longer patterns first)
  text = text.replace(/\*{3}(.*?)\*{3}/g, '$1'); // ***bold italic***
  text = text.replace(/\*{2}(.*?)\*{2}/g, '$1'); // **bold**
  text = text.replace(/~~(.*?)~~/g, '$1'); // ~~strikethrough~~
  text = text.replace(/`([^`]+)`/g, '$1'); // `inline code`
  text = text.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1'); // *italic*
  text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1'); // _italic_

  // 10. Collapse 3+ consecutive newlines to 2, trim
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  // 11. Return empty string if whitespace-only
  if (/^\s*$/.test(text)) return '';

  return text;
}
