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
