/**
 * Client-side extraction of the `@`-file-path autocomplete token. Mirrors pi's
 * interactive TUI `CombinedAutocompleteProvider.extractAtPrefix`: given the text
 * before the cursor, return the `@`-token the user is currently typing, or
 * `null` when the cursor is not inside an `@`-token.
 *
 * The returned token includes the leading `@` (and the opening `"` for quoted
 * `@"…"` tokens that may contain spaces). It is sent verbatim as the
 * `complete_file_refs` command `prefix`. The `@` only triggers when it sits at a
 * token boundary — the start of the line or immediately after a path delimiter
 * (whitespace, quote, `=`) — so mid-word `@` (e.g. an email address) does not
 * trigger completion.
 */
export function extractFileRefPrefix(textBeforeCursor: string): string | null {
  // Find the last `@` that sits at a token boundary: the first character, or
  // immediately after a path delimiter (whitespace, quote, or `=`).
  let at = -1;
  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    if (textBeforeCursor[i] !== '@') continue;
    const prev = i === 0 ? undefined : textBeforeCursor[i - 1];
    if (prev === undefined || prev === '"' || prev === '=' || /\s/.test(prev)) {
      at = i;
      break;
    }
  }
  if (at === -1) return null;

  const token = textBeforeCursor.slice(at);
  const body = token.slice(1);

  // Quoted token: spaces are part of the token until a closing quote. Since this
  // is the still-open token before the cursor, no closing quote is present.
  if (body.startsWith('"')) {
    return token;
  }

  // Unquoted token: a space terminates it, so the cursor is past a finished
  // token and should not trigger completion.
  if (/\s/.test(body)) {
    return null;
  }

  return token;
}

/** Outcome of applying a selected `@`-file-ref autocomplete item to the input. */
export interface FileRefSelection {
  /** Text to insert in place of the current `@`-token. */
  insertedText: string;
  /** True when the selection is a directory — the menu stays open to drill in. */
  isDirectory: boolean;
  /** For a directory, the still-open token to re-arm as the next prefix; else null. */
  nextPrefix: string | null;
}

/**
 * Decide how a selected `@`-file-ref item is applied to the input.
 *
 * `value` is the server-produced inserted token: `@path`, `@path/`,
 * `@"quoted path"`, or `@"quoted dir/"`. Note the closing quote on a quoted
 * directory falls *after* the trailing slash (`@"my dir/"`), so directory
 * detection tests the path portion, not the raw value's last character.
 *
 * For a directory drill-in the inserted text is the *still-open* token (no
 * closing quote for quoted tokens) so continued typing extends the same
 * `@`-token; a terminal file keeps the closed form as-is.
 */
export function resolveFileRefSelection(value: string): FileRefSelection {
  const isQuoted = value.startsWith('@"') && value.endsWith('"');
  const path = isQuoted ? value.slice(2, -1) : value.slice(1);
  if (!path.endsWith('/')) {
    return { insertedText: value, isDirectory: false, nextPrefix: null };
  }
  const openToken = isQuoted ? `@"${path}` : `@${path}`;
  return { insertedText: openToken, isDirectory: true, nextPrefix: openToken };
}
