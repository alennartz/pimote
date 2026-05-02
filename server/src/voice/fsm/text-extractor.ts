// Streaming extractor for the `text` value of a `speak({text:"..."})`
// tool argument JSON.
//
// Replaces our previous use of `@streamparser/json` (which is callback-
// based and thus required closures into reducer state). This extractor
// is fully synchronous: callers write JSON chunks and read the extracted
// text via `currentText()`. All mutation is encapsulated inside the
// extractor object; the FSM treats it as an opaque streaming buffer.
//
// **Scope.** This handles only the JSON shape `{"text": "<string>"}` —
// the exact shape of the `speak` tool's argument schema (single string
// field). It is *not* a general JSON parser. If we ever add more args
// to `speak`, we'll need to extend it (or reach for streamparser
// again). The trade-off is: ~80 lines of focused code vs a 3-letter
// dependency that introduced a closure-binding bug.
//
// **Robustness.** The extractor handles:
//   - leading whitespace before / inside the object
//   - the `text` key appearing first (not nested or preceded by other
//     keys — the schema enforces this)
//   - all JSON string escapes including `\uXXXX`
//   - chunk boundaries falling inside escape sequences (the buffer
//     holds onto unconsumed bytes until the next write provides the
//     rest)
// It does NOT handle:
//   - object/array values (no need; `text` is a string)
//   - non-`text` keys appearing before `text`

const HEAD_PATTERN = /"text"\s*:\s*"/;

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
};

type Phase = 'pre_string' | 'in_string' | 'closed' | 'errored';

export class TextExtractor {
  private phase: Phase = 'pre_string';
  /** Unconsumed input bytes that follow the cursor. */
  private buffer = '';
  /** Decoded text accumulated so far. */
  private text = '';

  /** Feed another JSON chunk. Idempotent once `closed` or `errored`. */
  write(chunk: string): void {
    if (this.phase === 'closed' || this.phase === 'errored') return;
    if (chunk.length === 0) return;
    this.buffer += chunk;
    this.advance();
  }

  /** The decoded value of `$.text` accumulated so far. Monotonic until
   *  `closed`/`errored`. */
  currentText(): string {
    return this.text;
  }

  /** Whether the closing `"` has been observed. */
  isClosed(): boolean {
    return this.phase === 'closed';
  }

  /** Whether parsing failed (e.g. malformed escape sequence). The FSM's
   *  toolcall_end fallback fills any remaining gap from the SDK's
   *  authoritative final text, so an errored extractor is recoverable
   *  at end-of-stream. */
  isErrored(): boolean {
    return this.phase === 'errored';
  }

  // -------------------------------------------------------------------------

  private advance(): void {
    if (this.phase === 'pre_string') this.advancePreString();
    if (this.phase === 'in_string') this.advanceInString();
  }

  private advancePreString(): void {
    const m = HEAD_PATTERN.exec(this.buffer);
    if (!m) return; // wait for more input
    // Drop everything up to and including the opening quote.
    this.buffer = this.buffer.slice(m.index + m[0].length);
    this.phase = 'in_string';
  }

  private advanceInString(): void {
    let i = 0;
    while (i < this.buffer.length) {
      const c = this.buffer.charCodeAt(i);
      if (c === 0x5c /* \ */) {
        if (i + 1 >= this.buffer.length) break; // wait for the escape char
        const esc = this.buffer[i + 1]!;
        if (esc === 'u') {
          if (i + 6 > this.buffer.length) break; // wait for the 4 hex digits
          const hex = this.buffer.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.phase = 'errored';
            return;
          }
          this.text += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (esc in SIMPLE_ESCAPES) {
          this.text += SIMPLE_ESCAPES[esc];
          i += 2;
        } else {
          // Invalid escape; bail.
          this.phase = 'errored';
          return;
        }
      } else if (c === 0x22 /* " */) {
        // End of string. Consume up to and including the closing quote.
        this.phase = 'closed';
        this.buffer = this.buffer.slice(i + 1);
        return;
      } else {
        this.text += this.buffer[i];
        i += 1;
      }
    }
    // Retain unconsumed tail (a partial escape at boundary).
    this.buffer = this.buffer.slice(i);
  }
}
