import { describe, expect, it } from 'vitest';
import { createCodemodeCodeStreamer, extractCodemodeCode, type CodemodeArgs } from './codemode-content.js';

describe('extractCodemodeCode', () => {
  it('returns the code string from finalized args', () => {
    const args: CodemodeArgs = { code: 'return text("hi");\n' };
    expect(extractCodemodeCode(args)).toBe('return text("hi");\n');
  });

  it('returns an empty string for the empty code field', () => {
    expect(extractCodemodeCode({ code: '' })).toBe('');
  });

  it('returns an empty string when code is missing', () => {
    expect(extractCodemodeCode({})).toBe('');
  });

  it('returns an empty string when code is not a string', () => {
    expect(extractCodemodeCode({ code: 123 })).toBe('');
  });

  it('returns an empty string for null, undefined, and non-objects', () => {
    expect(extractCodemodeCode(null)).toBe('');
    expect(extractCodemodeCode(undefined)).toBe('');
    expect(extractCodemodeCode('code')).toBe('');
    expect(extractCodemodeCode(42)).toBe('');
  });
});

describe('createCodemodeCodeStreamer', () => {
  it('starts with empty code', () => {
    const s = createCodemodeCodeStreamer();
    expect(s.code).toBe('');
    s.dispose();
  });

  it('remains empty after writing only structural JSON with no code value', () => {
    const s = createCodemodeCodeStreamer();
    s.write('{"other":');
    expect(s.code).toBe('');
    s.dispose();
  });

  it('matches extractCodemodeCode once fully fed in one chunk', () => {
    const args: CodemodeArgs = { code: 'const r = await tools.read({ path: "/x" });\nreturn r;\n' };
    const s = createCodemodeCodeStreamer();
    s.write(JSON.stringify(args));
    expect(s.code).toBe(extractCodemodeCode(args));
    s.dispose();
  });

  it('produces identical final code when fed one character at a time', () => {
    const args: CodemodeArgs = { code: 'await tools.bash({ command: "ls" });\nreturn "done";' };
    const json = JSON.stringify(args);
    const s = createCodemodeCodeStreamer();
    for (const ch of json) s.write(ch);
    expect(s.code).toBe(extractCodemodeCode(args));
    s.dispose();
  });

  it('preserves code verbatim including escaped characters', () => {
    const args: CodemodeArgs = { code: 'const s = "he said \\"hi\\"";\n\ttabbed' };
    const s = createCodemodeCodeStreamer();
    s.write(JSON.stringify(args));
    expect(s.code).toBe(args.code);
    s.dispose();
  });

  it('reveals code progressively as a partial string grows', () => {
    const args: CodemodeArgs = { code: 'abcdef' };
    const json = JSON.stringify(args);
    const s = createCodemodeCodeStreamer();
    const snapshots: string[] = [];
    for (const ch of json) {
      s.write(ch);
      snapshots.push(s.code);
    }
    const sawPartial = snapshots.some((v) => v.length > 0 && v.length < 'abcdef'.length && 'abcdef'.startsWith(v));
    expect(sawPartial).toBe(true);
    s.dispose();
  });

  it('grows only monotonically as partials come in', () => {
    const args: CodemodeArgs = { code: 'one\ntwo\nthree' };
    const s = createCodemodeCodeStreamer();
    let prev = '';
    for (const ch of JSON.stringify(args)) {
      s.write(ch);
      expect(s.code.startsWith(prev)).toBe(true);
      prev = s.code;
    }
    s.dispose();
  });

  it('swallows malformed JSON without throwing', () => {
    const s = createCodemodeCodeStreamer();
    expect(() => {
      s.write('{"code":"a');
      s.write('!!! not valid json !!!');
    }).not.toThrow();
    s.dispose();
  });

  it('dispose is idempotent and does not mutate code', () => {
    const s = createCodemodeCodeStreamer();
    s.write(JSON.stringify({ code: 'final source' }));
    const before = s.code;
    s.dispose();
    s.dispose();
    expect(s.code).toBe(before);
  });
});
