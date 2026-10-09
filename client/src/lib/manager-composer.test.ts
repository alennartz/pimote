import { describe, expect, it } from 'vitest';
import { managerComposerAction } from './manager-composer.js';

describe('managerComposerAction', () => {
  it('continues the manager session currently viewed', () => {
    expect(managerComposerAction({ sessionId: 'manager-1' }, true)).toEqual({ action: 'continue', sessionId: 'manager-1' });
  });

  it('opens a new session from the manager landing', () => {
    expect(managerComposerAction(undefined, false)).toEqual({ action: 'open-new' });
  });

  it('opens a new manager session when a code session is viewed', () => {
    expect(managerComposerAction({ sessionId: 'code-1' }, false)).toEqual({ action: 'open-new' });
  });

  it('opens a new session when no view exists despite a stale manager flag', () => {
    expect(managerComposerAction(undefined, true)).toEqual({ action: 'open-new' });
  });
});
