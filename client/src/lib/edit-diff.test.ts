import { describe, expect, it } from 'vitest';
import { buildEditDiffMarkdown, createEditDiffStreamer, type EditArgs } from './edit-diff.js';

describe('buildEditDiffMarkdown', () => {
  it('returns empty string for empty edits array', () => {
    expect(buildEditDiffMarkdown({ path: '/x.ts', edits: [] })).toBe('');
  });

  it('returns empty string when edits is missing', () => {
    expect(buildEditDiffMarkdown({ path: '/x.ts' } as unknown as EditArgs)).toBe('');
  });

  it('emits a single ```diff block for a single edit', () => {
    const md = buildEditDiffMarkdown({
      path: '/x.ts',
      edits: [{ oldText: 'hello', newText: 'world' }],
    });
    expect(md).toBe('```diff\n- hello\n+ world\n```');
  });

  it('emits one line per newline in oldText and newText', () => {
    const md = buildEditDiffMarkdown({
      path: '/x.ts',
      edits: [{ oldText: 'a\nb\nc', newText: 'x\ny' }],
    });
    expect(md).toBe('```diff\n- a\n- b\n- c\n+ x\n+ y\n```');
  });

  it('preserves line contents verbatim (no escaping)', () => {
    const md = buildEditDiffMarkdown({
      path: '/x.ts',
      edits: [
        {
          oldText: 'const x = "foo";',
          newText: 'const x = `bar ${y}`;',
        },
      ],
    });
    expect(md).toBe('```diff\n- const x = "foo";\n+ const x = `bar ${y}`;\n```');
  });

  it('omits the file path from the rendered markdown', () => {
    const md = buildEditDiffMarkdown({
      path: '/some/long/path/foo.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(md).not.toContain('/some/long/path/foo.ts');
    expect(md).not.toContain('foo.ts');
  });

  it('renders append-only edit (empty oldText) with only + lines', () => {
    const md = buildEditDiffMarkdown({
      path: '/x.ts',
      edits: [{ oldText: '', newText: 'added\nline' }],
    });
    expect(md).toBe('```diff\n+ added\n+ line\n```');
  });

  it('renders pure deletion (empty newText) with only - lines', () => {
    const md = buildEditDiffMarkdown({
      path: '/x.ts',
      edits: [{ oldText: 'gone', newText: '' }],
    });
    expect(md).toBe('```diff\n- gone\n```');
  });

  it('separates multiple edits with a blank line between diff blocks', () => {
    const md = buildEditDiffMarkdown({
      path: '/x.ts',
      edits: [
        { oldText: 'a', newText: 'b' },
        { oldText: 'c', newText: 'd' },
      ],
    });
    expect(md).toBe('```diff\n- a\n+ b\n```\n\n```diff\n- c\n+ d\n```');
  });

  it('preserves edit order in the output', () => {
    const md = buildEditDiffMarkdown({
      path: '/x.ts',
      edits: [
        { oldText: 'first-old', newText: 'first-new' },
        { oldText: 'second-old', newText: 'second-new' },
        { oldText: 'third-old', newText: 'third-new' },
      ],
    });
    const firstIdx = md.indexOf('first-old');
    const secondIdx = md.indexOf('second-old');
    const thirdIdx = md.indexOf('third-old');
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });
});

describe('createEditDiffStreamer', () => {
  it('starts with empty markdown', () => {
    const s = createEditDiffStreamer();
    expect(s.markdown).toBe('');
    s.dispose();
  });

  it('remains empty after writing only structural JSON with no string values', () => {
    const s = createEditDiffStreamer();
    s.write('{"path":"/x.ts","edits":[');
    expect(s.markdown).toBe('');
    s.dispose();
  });

  it('produces markdown equal to buildEditDiffMarkdown once fully fed', () => {
    const args: EditArgs = {
      path: '/x.ts',
      edits: [
        { oldText: 'hello\nworld', newText: 'goodbye' },
        { oldText: 'foo', newText: 'bar\nbaz' },
      ],
    };
    const expected = buildEditDiffMarkdown(args);
    const s = createEditDiffStreamer();
    s.write(JSON.stringify(args));
    expect(s.markdown).toBe(expected);
    s.dispose();
  });

  it('produces identical final markdown when fed in arbitrary chunk sizes', () => {
    const args: EditArgs = {
      path: '/x.ts',
      edits: [{ oldText: 'alpha\nbeta', newText: 'gamma\ndelta' }],
    };
    const expected = buildEditDiffMarkdown(args);
    const json = JSON.stringify(args);

    const s = createEditDiffStreamer();
    for (const ch of json) s.write(ch);
    expect(s.markdown).toBe(expected);
    s.dispose();
  });

  it('reveals oldText - lines progressively as a partial string grows', () => {
    const args: EditArgs = {
      path: '/x.ts',
      edits: [{ oldText: 'abcdef', newText: '' }],
    };
    const json = JSON.stringify(args);

    const s = createEditDiffStreamer();
    const snapshots: string[] = [];
    for (const ch of json) {
      s.write(ch);
      snapshots.push(s.markdown);
    }

    // At some intermediate point during streaming we should have seen a
    // markdown state that contains a '-' line with a prefix of 'abcdef'
    // but not yet the full value.
    const sawPartial = snapshots.some((m) => {
      return /- ab(?!cdef)/.test(m);
    });
    expect(sawPartial).toBe(true);
    s.dispose();
  });

  it('splits a partial oldText containing newlines into multiple - lines', () => {
    const s = createEditDiffStreamer();
    // Stream the JSON in one go but choose content with embedded newline.
    s.write(JSON.stringify({ path: '/x.ts', edits: [{ oldText: 'a\nb', newText: '' }] }));
    expect(s.markdown).toBe('```diff\n- a\n- b\n```');
    s.dispose();
  });

  it('opens a new diff block when a new edit index is encountered', () => {
    const args: EditArgs = {
      path: '/x.ts',
      edits: [
        { oldText: 'a', newText: 'b' },
        { oldText: 'c', newText: 'd' },
      ],
    };
    const s = createEditDiffStreamer();
    s.write(JSON.stringify(args));
    // Two fenced diff blocks in the final output.
    const fenceCount = (s.markdown.match(/```diff/g) ?? []).length;
    expect(fenceCount).toBe(2);
    s.dispose();
  });

  it('appends + lines under the - lines of the same edit block', () => {
    const s = createEditDiffStreamer();
    s.write(JSON.stringify({ path: '/x.ts', edits: [{ oldText: 'a', newText: 'b' }] }));
    const idxMinus = s.markdown.indexOf('- a');
    const idxPlus = s.markdown.indexOf('+ b');
    expect(idxMinus).toBeGreaterThanOrEqual(0);
    expect(idxPlus).toBeGreaterThan(idxMinus);
    s.dispose();
  });

  it('dispose is idempotent and does not mutate markdown', () => {
    const s = createEditDiffStreamer();
    s.write(JSON.stringify({ path: '/x.ts', edits: [{ oldText: 'a', newText: 'b' }] }));
    const before = s.markdown;
    s.dispose();
    s.dispose();
    expect(s.markdown).toBe(before);
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
