import { describe, it, expect, beforeEach } from 'vitest';
import type { CommandInfo } from '@pimote/shared';
import { createCommandStore, type CommandStore } from './command-store.svelte.js';

const sampleCommands: CommandInfo[] = [
  { name: 'skill:brainstorm', description: 'Brainstorm ideas', hasArgCompletions: false },
  { name: 'deploy', description: 'Deploy to production', hasArgCompletions: true },
  { name: 'skill:code-review', description: 'Review code', hasArgCompletions: false },
];

describe('CommandStore', () => {
  let store: CommandStore;

  beforeEach(() => {
    store = createCommandStore();
  });

  describe('initial state', () => {
    it('returns empty array for unknown session', () => {
      expect(store.getCommands('nonexistent')).toEqual([]);
    });
  });

  describe('setCommands / getCommands', () => {
    it('stores and retrieves commands for a session', () => {
      store.setCommands('session-1', sampleCommands);
      expect(store.getCommands('session-1')).toEqual(sampleCommands);
    });

    it('keeps commands separate per session', () => {
      const otherCommands: CommandInfo[] = [{ name: 'test', description: 'Run tests', hasArgCompletions: false }];

      store.setCommands('session-1', sampleCommands);
      store.setCommands('session-2', otherCommands);

      expect(store.getCommands('session-1')).toEqual(sampleCommands);
      expect(store.getCommands('session-2')).toEqual(otherCommands);
    });

    it('overwrites previous commands for the same session', () => {
      store.setCommands('session-1', sampleCommands);

      const updated: CommandInfo[] = [{ name: 'new-cmd', description: 'New', hasArgCompletions: false }];
      store.setCommands('session-1', updated);

      expect(store.getCommands('session-1')).toEqual(updated);
    });
  });

  describe('removeSession', () => {
    it('removes cached commands for a session', () => {
      store.setCommands('session-1', sampleCommands);
      store.removeSession('session-1');
      expect(store.getCommands('session-1')).toEqual([]);
    });

    it('does not affect other sessions', () => {
      store.setCommands('session-1', sampleCommands);
      store.setCommands('session-2', [{ name: 'other', description: 'Other', hasArgCompletions: false }]);

      store.removeSession('session-1');

      expect(store.getCommands('session-2')).toHaveLength(1);
    });

    it('is a no-op for unknown session', () => {
      expect(() => store.removeSession('nonexistent')).not.toThrow();
    });
  });

  describe('clear', () => {
    it('removes all cached commands', () => {
      store.setCommands('session-1', sampleCommands);
      store.setCommands('session-2', [{ name: 'x', description: 'X', hasArgCompletions: false }]);

      store.clear();

      expect(store.getCommands('session-1')).toEqual([]);
      expect(store.getCommands('session-2')).toEqual([]);
    });
  });
});
