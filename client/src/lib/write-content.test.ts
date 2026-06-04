import { describe, expect, it } from 'vitest';
import { createWriteContentStreamer, extractWriteContent, type WriteArgs } from './write-content.js';

describe('extractWriteContent', () => {
  it('returns the content string from finalized args', () => {
    const args: WriteArgs = { path: '/x.ts', content: 'const x = 1;\n' };
    expect(extractWriteContent(args)).toBe('const x = 1;\n');
  });

  it('returns an empty string for the empty content field', () => {
    expect(extractWriteContent({ path: '/x.ts', content: '' })).toBe('');
  });

  it('returns an empty string when content is missing', () => {
    expect(extractWriteContent({ path: '/x.ts' })).toBe('');
  });

  it('returns an empty string when content is not a string', () => {
    expect(extractWriteContent({ path: '/x.ts', content: 123 })).toBe('');
  });

  it('returns an empty string for null, undefined, and non-objects', () => {
    expect(extractWriteContent(null)).toBe('');
    expect(extractWriteContent(undefined)).toBe('');
    expect(extractWriteContent('content')).toBe('');
    expect(extractWriteContent(42)).toBe('');
  });
});

describe('createWriteContentStreamer', () => {
  it('starts with empty content', () => {
    const s = createWriteContentStreamer();
    expect(s.content).toBe('');
    s.dispose();
  });

  it('remains empty after writing only structural JSON with no content value', () => {
    const s = createWriteContentStreamer();
    s.write('{"path":"/x.ts",');
    expect(s.content).toBe('');
    s.dispose();
  });

  it('matches extractWriteContent once fully fed in one chunk', () => {
    const args: WriteArgs = { path: '/x.ts', content: 'line one\nline two\n' };
    const s = createWriteContentStreamer();
    s.write(JSON.stringify(args));
    expect(s.content).toBe(extractWriteContent(args));
    s.dispose();
  });

  it('produces identical final content when fed one character at a time', () => {
    const args: WriteArgs = { path: '/x.ts', content: 'alpha\nbeta\ngamma' };
    const json = JSON.stringify(args);
    const s = createWriteContentStreamer();
    for (const ch of json) s.write(ch);
    expect(s.content).toBe(extractWriteContent(args));
    s.dispose();
  });

  it('preserves content verbatim including escaped characters', () => {
    const args: WriteArgs = { path: '/x.ts', content: 'const s = "he said \\"hi\\"";\n\ttabbed' };
    const s = createWriteContentStreamer();
    s.write(JSON.stringify(args));
    expect(s.content).toBe(args.content);
    s.dispose();
  });

  it('reveals content progressively as a partial string grows', () => {
    const args: WriteArgs = { path: '/x.ts', content: 'abcdef' };
    const json = JSON.stringify(args);
    const s = createWriteContentStreamer();
    const snapshots: string[] = [];
    for (const ch of json) {
      s.write(ch);
      snapshots.push(s.content);
    }
    const sawPartial = snapshots.some((v) => v.length > 0 && v.length < 'abcdef'.length && 'abcdef'.startsWith(v));
    expect(sawPartial).toBe(true);
    s.dispose();
  });

  it('grows only monotonically as partials come in', () => {
    const args: WriteArgs = { path: '/x.ts', content: 'one\ntwo\nthree' };
    const s = createWriteContentStreamer();
    let prev = '';
    for (const ch of JSON.stringify(args)) {
      s.write(ch);
      expect(s.content.startsWith(prev)).toBe(true);
      prev = s.content;
    }
    s.dispose();
  });

  it('swallows malformed JSON without throwing', () => {
    const s = createWriteContentStreamer();
    expect(() => {
      s.write('{"path":"/x.ts","content":"a');
      s.write('!!! not valid json !!!');
    }).not.toThrow();
    s.dispose();
  });

  it('dispose is idempotent and does not mutate content', () => {
    const s = createWriteContentStreamer();
    s.write(JSON.stringify({ path: '/x.ts', content: 'final body' }));
    const before = s.content;
    s.dispose();
    s.dispose();
    expect(s.content).toBe(before);
  });
});
