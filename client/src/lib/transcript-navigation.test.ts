import { describe, expect, it } from 'vitest';
import { previousUserAbove } from './transcript-navigation.js';

describe('sticky previous-user target', () => {
  const positions = [
    { entryId: 'older', role: 'user', bottom: -80 },
    { entryId: 'previous', role: 'user', bottom: -10 },
    { entryId: 'assistant', role: 'assistant', bottom: -5 },
    { entryId: 'visible', role: 'user', bottom: 100 },
  ];
  it('chooses the last user message fully above the viewport', () => {
    expect(previousUserAbove(positions, 0)).toBe('previous');
  });
  it('detaches when the full message enters the threshold and chooses the older user', () => {
    expect(previousUserAbove(positions, -10)).toBe('older');
    expect(previousUserAbove(positions, -20, 10)).toBe('older');
  });
  it('has no target when no user message is above the viewport', () => {
    expect(previousUserAbove([], 0)).toBeNull();
    expect(previousUserAbove(positions, -100)).toBeNull();
  });
});
