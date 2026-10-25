import { describe, it, expect } from 'vitest';
import { seededMemberLine, injectMemberLine, managedMemberNature, removeMemberLine } from './hub-agents-md.js';

// The managed-block markers the mutator owns (plan: 0.15-2 dashboard folder UX).
const OPEN = '<!-- pimote:members (managed block) -->';
const CLOSE = '<!-- /pimote:members -->';

/** User-owned hub AGENTS.md content with an empty managed block. */
const userDoc = `# Hub

User prose here.

${OPEN}
${CLOSE}

Trailing user notes.
`;

function blockInner(markdown: string): string {
  return markdown.slice(markdown.indexOf(OPEN) + OPEN.length, markdown.indexOf(CLOSE));
}

describe('seededMemberLine', () => {
  it('is byte-deterministic per (name, nature), one line, without paths', () => {
    const line = seededMemberLine('ada', 'persona');

    expect(line).toBe(seededMemberLine('ada', 'persona'));
    expect(seededMemberLine('ada', 'code')).not.toBe(line);
    expect(line).toContain('ada');
    expect(line.trim().split('\n')).toHaveLength(1);
    expect(line).not.toContain('/');
  });
});

describe('injectMemberLine', () => {
  it('inserts the line into the managed block and leaves all bytes outside it unchanged', () => {
    const line = seededMemberLine('ada', 'persona');
    const out = injectMemberLine(userDoc, line);

    expect(blockInner(out)).toContain(line);
    expect(out.slice(0, out.indexOf(OPEN) + OPEN.length)).toBe(userDoc.slice(0, userDoc.indexOf(OPEN) + OPEN.length));
    expect(out.slice(out.indexOf(CLOSE))).toBe(userDoc.slice(userDoc.indexOf(CLOSE)));
  });

  it('appends a fresh managed block when the markers are gone, preserving the document verbatim', () => {
    const doc = '# Hub\n\nUser prose.\n';
    const line = seededMemberLine('repo-b', 'code');
    const out = injectMemberLine(doc, line);

    expect(out).toContain(doc);
    expect(out).toContain(OPEN);
    expect(out).toContain(CLOSE);
    expect(blockInner(out)).toContain(line);
  });

  it('keeps previously seeded lines when a second member is injected', () => {
    const first = seededMemberLine('ada', 'persona');
    const second = seededMemberLine('repo-b', 'code');
    const out = injectMemberLine(injectMemberLine(userDoc, first), second);

    expect(blockInner(out)).toContain(first);
    expect(blockInner(out)).toContain(second);
  });
});

describe('managedMemberNature', () => {
  it('recognizes only exact seeded lines inside the managed block', () => {
    const code = seededMemberLine('repo-a', 'code');
    const persona = seededMemberLine('ada', 'persona');
    const doc = injectMemberLine(injectMemberLine(userDoc, code), persona);

    expect(managedMemberNature(doc, 'repo-a')).toBe('code');
    expect(managedMemberNature(doc, 'ada')).toBe('persona');
    expect(managedMemberNature(doc, 'other')).toBeUndefined();
    expect(managedMemberNature(`${doc}\n${code}\n`, 'repo-a')).toBe('code');
  });

  it('does not authorize prose or lines outside the managed block', () => {
    const code = seededMemberLine('repo-a', 'code');
    const prose = `${code}\n${userDoc}`;

    expect(managedMemberNature(prose, 'repo-a')).toBeUndefined();
    expect(managedMemberNature(userDoc.replace(`${OPEN}\n${CLOSE}`, `${OPEN}\n- repo-a (code): user note.\n${CLOSE}`), 'repo-a')).toBeUndefined();
  });
});

describe('removeMemberLine', () => {
  it('deletes the seeded line byte-exact, restoring the document before the injection', () => {
    const line = seededMemberLine('ada', 'persona');
    const seeded = injectMemberLine(userDoc, line);
    const out = removeMemberLine(seeded, line);

    expect(out).not.toContain(line);
    expect(out).toBe(userDoc);
  });

  it('leaves a line it did not seed alone', () => {
    const line = seededMemberLine('ada', 'persona');
    const edited = injectMemberLine(userDoc, line).replace(line, '- the user rewrote this member line');
    const out = removeMemberLine(edited, line);

    expect(out).toBe(edited);
    expect(out).toContain('- the user rewrote this member line');
  });

  it('does nothing when the block markers are gone', () => {
    const line = seededMemberLine('ada', 'persona');
    const doc = `# Hub\n\n${line}\n`;

    expect(removeMemberLine(doc, line)).toBe(doc);
  });

  it('removes one seeded line and leaves the other members byte-exact', () => {
    const first = seededMemberLine('ada', 'persona');
    const second = seededMemberLine('repo-b', 'code');
    const seeded = injectMemberLine(injectMemberLine(userDoc, first), second);
    const out = removeMemberLine(seeded, first);

    expect(out).not.toContain(first);
    expect(blockInner(out)).toContain(second);
    expect(out.slice(0, out.indexOf(OPEN) + OPEN.length)).toBe(userDoc.slice(0, userDoc.indexOf(OPEN) + OPEN.length));
  });
});
