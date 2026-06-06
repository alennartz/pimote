import { describe, it, expect } from 'vitest';
import { extractFileRefPrefix } from './file-ref-prefix';

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
