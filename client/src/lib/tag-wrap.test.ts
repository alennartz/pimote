import { describe, expect, it } from 'vitest';
import { isValidTagName, wrapWithTag } from './tag-wrap.js';

describe('isValidTagName', () => {
  it('accepts names starting with a letter and containing letters, digits, underscore, hyphen', () => {
    expect(isValidTagName('tag')).toBe(true);
    expect(isValidTagName('a')).toBe(true);
    expect(isValidTagName('My-Tag_1')).toBe(true);
    expect(isValidTagName('h1')).toBe(true);
  });

  it('rejects empty, digit-first, punctuation, and whitespace names', () => {
    expect(isValidTagName('')).toBe(false);
    expect(isValidTagName('1tag')).toBe(false);
    expect(isValidTagName('-tag')).toBe(false);
    expect(isValidTagName('_tag')).toBe(false);
    expect(isValidTagName('tag name')).toBe(false);
    expect(isValidTagName('<tag>')).toBe(false);
    expect(isValidTagName('tag.')).toBe(false);
    expect(isValidTagName('täg')).toBe(false);
  });
});

describe('wrapWithTag', () => {
  it('wraps a selection inline and returns the inner range shifted past the open tag', () => {
    //             0123456789...
    const value = 'say hello now';
    const result = wrapWithTag(value, 4, 9, 'b');
    expect(result.text).toBe('say <b>hello</b> now');
    expect(result.from).toBe(7);
    expect(result.to).toBe(12);
    expect(result.text.slice(result.from, result.to)).toBe('hello');
  });

  it('wraps a full-document selection', () => {
    const value = 'whole';
    const result = wrapWithTag(value, 0, value.length, 'div');
    expect(result.text).toBe('<div>whole</div>');
    expect(result.from).toBe(5);
    expect(result.to).toBe(10);
    expect(result.text.slice(result.from, result.to)).toBe('whole');
  });

  it('wraps a multi-line selection without adding lines', () => {
    const value = 'one\ntwo\nthree';
    const result = wrapWithTag(value, 4, 7, 'em');
    expect(result.text).toBe('one\n<em>two</em>\nthree');
    expect(result.text.slice(result.from, result.to)).toBe('two');
  });

  it('inserts a block with a collapsed cursor on the blank middle line', () => {
    const value = 'ab';
    const result = wrapWithTag(value, 1, 1, 'section');
    expect(result.text).toBe('a<section>\n\n</section>b');
    expect(result.from).toBe(result.to);
    // The cursor sits on an empty line between the two tag lines.
    expect(result.text.slice(result.from - 1, result.to + 1)).toBe('\n\n');
  });

  it('inserts the block at the start of a non-empty document', () => {
    const result = wrapWithTag('body', 0, 0, 'p');
    expect(result.text).toBe('<p>\n\n</p>body');
    expect(result.from).toBe(result.to);
    expect(result.text.slice(result.from - 1, result.to + 1)).toBe('\n\n');
  });

  it('inserts the block at the end of a non-empty document', () => {
    const result = wrapWithTag('body', 4, 4, 'p');
    expect(result.text).toBe('body<p>\n\n</p>');
    expect(result.from).toBe(result.to);
    expect(result.text.slice(result.from - 1, result.to + 1)).toBe('\n\n');
  });

  it('inserts the block into an empty document', () => {
    const result = wrapWithTag('', 0, 0, 'note');
    expect(result.text).toBe('<note>\n\n</note>');
    expect(result.from).toBe(result.to);
    expect(result.text.slice(result.from - 1, result.to + 1)).toBe('\n\n');
  });

  it('throws on invalid tag names for both modes', () => {
    expect(() => wrapWithTag('abc', 0, 3, '1bad')).toThrow();
    expect(() => wrapWithTag('abc', 1, 1, 'bad name')).toThrow();
    expect(() => wrapWithTag('abc', 1, 1, '')).toThrow();
  });

  it('returns a selection inside the resulting document bounds', () => {
    for (const result of [wrapWithTag('say hello now', 4, 9, 'b'), wrapWithTag('say hello now', 4, 4, 'b')]) {
      expect(result.from).toBeGreaterThanOrEqual(0);
      expect(result.to).toBeGreaterThanOrEqual(result.from);
      expect(result.to).toBeLessThanOrEqual(result.text.length);
    }
  });
});
