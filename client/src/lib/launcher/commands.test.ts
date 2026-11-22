import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/connection.svelte.js', () => ({
  connection: new Proxy(
    { status: 'connected', managerRoot: null, send: vi.fn(async () => ({ success: true, data: {} })) },
    {
      get(target, property) {
        return property in target ? target[property as keyof typeof target] : vi.fn();
      },
    },
  ),
}));

const { getDefaultLauncherCommands } = await import('./commands.js');
const { shortcutHelpStore } = await import('$lib/stores/shortcut-help-store.svelte.js');

describe('launcher command catalog', () => {
  it('includes a keyboard shortcuts command that opens the cheat sheet', () => {
    const command = getDefaultLauncherCommands().find((candidate) => candidate.id === 'view-keyboard-shortcuts');
    expect(command).toBeDefined();
    expect(command!.isAvailable?.() ?? true).toBe(true);
    expect(shortcutHelpStore.isOpen).toBe(false);
    command!.run();
    expect(shortcutHelpStore.isOpen).toBe(true);
  });

  it('keeps every command id unique', () => {
    const commands = getDefaultLauncherCommands();
    const ids = commands.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
