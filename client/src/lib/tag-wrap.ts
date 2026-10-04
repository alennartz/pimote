/**
 * Pure tag-wrap semantics for the config-file editor toolbar.
 *
 * Both functions are pure: inputs in, new text plus selection out. The caller
 * applies the result to the editor (single transaction replacing the document
 * and setting the selection).
 */

export type TagWrapResult = { text: string; from: number; to: number };

const TAG_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Tag names: /^[A-Za-z][A-Za-z0-9_-]*$/; anything else is invalid. */
export function isValidTagName(tag: string): boolean {
  return TAG_NAME_PATTERN.test(tag);
}

/**
 * Pure. Returns the new document text plus the selection to restore.
 * - Selection (from < to): inline wrap — '<tag>' at from, '</tag>' at to;
 *   resulting selection is the original inner range, shifted past the open tag.
 * - Cursor (from === to): inserts '<tag>\n\n</tag>' at the cursor (tags each on
 *   their own line, blank line between); resulting selection is collapsed on
 *   the blank middle line.
 *
 * Throws on an invalid tag name.
 */
export function wrapWithTag(value: string, from: number, to: number, tag: string): TagWrapResult {
  if (!isValidTagName(tag)) {
    throw new Error(`Invalid tag name: ${JSON.stringify(tag)}`);
  }
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;

  if (from === to) {
    // Block insert: cursor lands on the blank middle line, i.e. right after
    // the first newline of '<tag>\n\n</tag>'.
    const insert = `${openTag}\n\n${closeTag}`;
    return {
      text: value.slice(0, from) + insert + value.slice(to),
      from: from + openTag.length + 1,
      to: from + openTag.length + 1,
    };
  }

  // Inline wrap: inner range shifts right by the open tag's length.
  return {
    text: value.slice(0, from) + openTag + value.slice(from, to) + closeTag + value.slice(to),
    from: from + openTag.length,
    to: to + openTag.length,
  };
}
