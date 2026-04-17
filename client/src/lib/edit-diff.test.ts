import { describe, expect, it } from 'vitest';
import { buildEditLines, createEditDiffStreamer, type EditArgs, type EditEntry } from './edit-diff.js';

describe('buildEditLines', () => {
  it('returns an empty array for an entry with both sides empty', () => {
    expect(buildEditLines({ oldText: '', newText: '' })).toEqual([]);
  });

  it('emits deletion lines for oldText and addition lines for newText', () => {
    expect(buildEditLines({ oldText: 'hello', newText: 'world' })).toEqual([
      { kind: 'deletion', text: '- hello' },
      { kind: 'addition', text: '+ world' },
    ]);
  });

  it('splits multi-line oldText and newText on \\n', () => {
    expect(buildEditLines({ oldText: 'a\nb\nc', newText: 'x\ny' })).toEqual([
      { kind: 'deletion', text: '- a' },
      { kind: 'deletion', text: '- b' },
      { kind: 'deletion', text: '- c' },
      { kind: 'addition', text: '+ x' },
      { kind: 'addition', text: '+ y' },
    ]);
  });

  it('preserves line contents verbatim (no escaping)', () => {
    expect(buildEditLines({ oldText: 'const x = "foo";', newText: 'const x = `bar ${y}`;' })).toEqual([
      { kind: 'deletion', text: '- const x = "foo";' },
      { kind: 'addition', text: '+ const x = `bar ${y}`;' },
    ]);
  });

  it('renders append-only edit (empty oldText) with only addition lines', () => {
    expect(buildEditLines({ oldText: '', newText: 'added\nline' })).toEqual([
      { kind: 'addition', text: '+ added' },
      { kind: 'addition', text: '+ line' },
    ]);
  });

  it('renders pure deletion (empty newText) with only deletion lines', () => {
    expect(buildEditLines({ oldText: 'gone', newText: '' })).toEqual([{ kind: 'deletion', text: '- gone' }]);
  });

  it('treats a trailing newline as a trailing empty prefix-only line', () => {
    // Matches `string.split('\n')` semantics — a trailing `\n` produces an
    // extra empty element. During streaming this surfaces briefly while a
    // value ends with '\n' waiting for more characters; the final snapshot
    // will typically drop the trailing newline once the full value arrives.
    expect(buildEditLines({ oldText: 'a\n', newText: '' })).toEqual([
      { kind: 'deletion', text: '- a' },
      { kind: 'deletion', text: '- ' },
    ]);
  });
});

describe('createEditDiffStreamer', () => {
  it('starts with an empty entries array', () => {
    const s = createEditDiffStreamer();
    expect(s.entries).toEqual([]);
    s.dispose();
  });

  it('remains empty after writing only structural JSON with no string values', () => {
    const s = createEditDiffStreamer();
    s.write('{"path":"/x.ts","edits":[');
    expect(s.entries).toEqual([]);
    s.dispose();
  });

  it('produces the full entries array once fully fed', () => {
    const args: EditArgs = {
      path: '/x.ts',
      edits: [
        { oldText: 'hello\nworld', newText: 'goodbye' },
        { oldText: 'foo', newText: 'bar\nbaz' },
      ],
    };
    const s = createEditDiffStreamer();
    s.write(JSON.stringify(args));
    expect(Array.from(s.entries)).toEqual(args.edits);
    s.dispose();
  });

  it('produces identical final entries when fed in arbitrary chunk sizes', () => {
    const args: EditArgs = {
      path: '/x.ts',
      edits: [{ oldText: 'alpha\nbeta', newText: 'gamma\ndelta' }],
    };
    const json = JSON.stringify(args);

    const s = createEditDiffStreamer();
    for (const ch of json) s.write(ch);
    expect(Array.from(s.entries)).toEqual(args.edits);
    s.dispose();
  });

  it('reveals oldText progressively as a partial string grows', () => {
    const args: EditArgs = {
      path: '/x.ts',
      edits: [{ oldText: 'abcdef', newText: '' }],
    };
    const json = JSON.stringify(args);

    const s = createEditDiffStreamer();
    const snapshots: string[] = [];
    for (const ch of json) {
      s.write(ch);
      snapshots.push(s.entries[0]?.oldText ?? '');
    }

    // We should have seen a snapshot where oldText is a non-empty strict
    // prefix of 'abcdef' but not yet the full value.
    const sawPartial = snapshots.some((v) => v.length > 0 && v.length < 'abcdef'.length && 'abcdef'.startsWith(v));
    expect(sawPartial).toBe(true);
    s.dispose();
  });

  it('grows only monotonically as partials come in', () => {
    // Once a character has appeared in oldText/newText it should never
    // disappear from a subsequent snapshot \u2014 the downstream component
    // relies on this to avoid flicker.
    const args: EditArgs = {
      path: '/x.ts',
      edits: [
        { oldText: 'alpha\nbeta', newText: 'gamma\ndelta' },
        { oldText: 'epsilon', newText: 'zeta\neta' },
      ],
    };
    const s = createEditDiffStreamer();

    const prev: Array<EditEntry> = [];
    for (const ch of JSON.stringify(args)) {
      s.write(ch);
      for (let i = 0; i < s.entries.length; i++) {
        const now = s.entries[i];
        const before = prev[i] ?? { oldText: '', newText: '' };
        expect(now.oldText.startsWith(before.oldText)).toBe(true);
        expect(now.newText.startsWith(before.newText)).toBe(true);
        prev[i] = { oldText: now.oldText, newText: now.newText };
      }
    }
    s.dispose();
  });

  it('opens a new entry when a new edit index is encountered', () => {
    const args: EditArgs = {
      path: '/x.ts',
      edits: [
        { oldText: 'a', newText: 'b' },
        { oldText: 'c', newText: 'd' },
      ],
    };
    const s = createEditDiffStreamer();
    s.write(JSON.stringify(args));
    expect(s.entries.length).toBe(2);
    s.dispose();
  });

  it('dispose is idempotent and does not mutate entries', () => {
    const s = createEditDiffStreamer();
    s.write(JSON.stringify({ path: '/x.ts', edits: [{ oldText: 'a', newText: 'b' }] }));
    const before = Array.from(s.entries);
    s.dispose();
    s.dispose();
    expect(Array.from(s.entries)).toEqual(before);
  });

  it('swallows malformed JSON without throwing', () => {
    const s = createEditDiffStreamer();
    expect(() => {
      s.write('{"path":"/x.ts","edits":[{"oldText":"a","newText":');
      s.write('!!! not valid json !!!');
    }).not.toThrow();
    s.dispose();
  });
});
