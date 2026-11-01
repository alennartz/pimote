// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

// The session view carries no New session chip: /new stays a composer verb
// (see InputBar.new-session.test.ts), so a duplicate control has nothing to do.
describe('session view New session chip removal', () => {
  it('keeps the session bar free of a New session chip', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile('src/lib/components/ActiveSessionBar.svelte', 'utf8'));
    expect(source).not.toContain('>New session<');
    expect(source).not.toContain('message-square-plus');
  });
});
