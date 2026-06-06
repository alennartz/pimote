import { describe, it, expect } from 'vitest';
import { extractFileRefPrefix, resolveFileRefSelection } from './file-ref-prefix';

describe('extractFileRefPrefix', () => {
  it('returns null for empty text', () => {
    expect(extractFileRefPrefix('')).toBeNull();
  });

  it('returns null when there is no @-token before the cursor', () => {
    expect(extractFileRefPrefix('just some text')).toBeNull();
  });

  it('returns null for a slash command', () => {
    expect(extractFileRefPrefix('/help')).toBeNull();
  });

  it('extracts a bare @-token at the start of the line', () => {
    expect(extractFileRefPrefix('@foo')).toBe('@foo');
  });

  it('extracts a lone @ as the prefix', () => {
    expect(extractFileRefPrefix('@')).toBe('@');
  });

  it('extracts an @-token that follows whitespace mid-line', () => {
    expect(extractFileRefPrefix('look at @src/index.ts')).toBe('@src/index.ts');
  });

  it('extracts only the token immediately before the cursor', () => {
    expect(extractFileRefPrefix('@one @two')).toBe('@two');
  });

  it('does not trigger on a mid-word @ such as an email address', () => {
    expect(extractFileRefPrefix('mail me at user@host')).toBeNull();
  });

  it('triggers when @ follows a non-space delimiter', () => {
    expect(extractFileRefPrefix('x=@foo')).toBe('@foo');
  });

  it('returns null once the token is terminated by a trailing space', () => {
    expect(extractFileRefPrefix('@done ')).toBeNull();
  });

  it('captures an unclosed quoted @"…" token including its opening quote', () => {
    expect(extractFileRefPrefix('@"my dir')).toBe('@"my dir');
  });

  it('keeps spaces inside an unclosed quoted @"…" token', () => {
    expect(extractFileRefPrefix('open @"src/a b')).toBe('@"src/a b');
  });
});

describe('resolveFileRefSelection', () => {
  it('treats an unquoted file as terminal: inserts as-is, no drill-in', () => {
    expect(resolveFileRefSelection('@index.ts')).toEqual({
      insertedText: '@index.ts',
      isDirectory: false,
      nextPrefix: null,
    });
  });

  it('treats an unquoted directory as a drill-in, re-arming the same token', () => {
    expect(resolveFileRefSelection('@src/')).toEqual({
      insertedText: '@src/',
      isDirectory: true,
      nextPrefix: '@src/',
    });
  });

  it('keeps the closing quote on a terminal quoted file', () => {
    expect(resolveFileRefSelection('@"my file.ts"')).toEqual({
      insertedText: '@"my file.ts"',
      isDirectory: false,
      nextPrefix: null,
    });
  });

  it('detects a quoted directory whose closing quote falls after the trailing slash', () => {
    // Server emits `@"my dir/"` (quote after the slash). The raw value ends in
    // `"`, but it is a directory — drill-in must fire.
    expect(resolveFileRefSelection('@"my dir/"')).toEqual({
      insertedText: '@"my dir/',
      isDirectory: true,
      nextPrefix: '@"my dir/',
    });
  });

  it('strips the closing quote from a quoted directory so the re-armed token stays open', () => {
    // The re-armed prefix must be the open-quoted form so continued typing
    // extends the same token and parsePrefix does not mis-split on a stray quote.
    const { nextPrefix } = resolveFileRefSelection('@"a b/c d/"');
    expect(nextPrefix).toBe('@"a b/c d/');
    expect(nextPrefix?.endsWith('"')).toBe(false);
  });
});
