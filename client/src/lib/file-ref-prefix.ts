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
export function extractFileRefPrefix(_textBeforeCursor: string): string | null {
  throw new Error('not implemented');
}
