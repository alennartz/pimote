/**
 * Reactive command store — holds the fetched command list per session.
 * Commands are fetched once when a session connects, then cached.
 */

import { SvelteMap } from 'svelte/reactivity';
import type { CommandInfo } from '@pimote/shared';

export interface CommandStore {
  /** Get the commands for a given session (empty array if not yet fetched). */
  getCommands(sessionId: string): CommandInfo[];

  /** Store fetched commands for a session. */
  setCommands(sessionId: string, commands: CommandInfo[]): void;

  /** Remove cached commands when a session is closed. */
  removeSession(sessionId: string): void;

  /** Clear all cached commands. */
  clear(): void;
}

/**
 * Create a new CommandStore instance.
 */
export function createCommandStore(): CommandStore {
  const store = new SvelteMap<string, CommandInfo[]>();

  return {
    getCommands(sessionId: string): CommandInfo[] {
      return store.get(sessionId) ?? [];
    },

    setCommands(sessionId: string, commands: CommandInfo[]): void {
      store.set(sessionId, commands);
    },

    removeSession(sessionId: string): void {
      store.delete(sessionId);
    },

    clear(): void {
      store.clear();
    },
  };
}
