// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { AgentPath, PimoteAgentMessage } from '@pimote/shared';
import { userIdentity } from '$lib/stores/user-identity.svelte.js';
import Message from './Message.svelte';

const mounted: ReturnType<typeof mount>[] = [];

// Node's built-in localStorage shadows jsdom's and works only with
// --localstorage-file, so the store gets a Map-backed storage of its own.
function createMockStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMockStorage());
  userIdentity.setName('');
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function render(message: PimoteAgentMessage, props: { agentPath?: AgentPath } = {}): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(Message, { target, props: { message, ...props } }));
  await tick();
  return target;
}

function speakerChips(target: HTMLElement, leading: 'bot' | 'user'): HTMLElement[] {
  return [...target.querySelectorAll<HTMLElement>(`[data-agent-leading="${leading}"]`)];
}

describe('Message speaker chips', () => {
  it('labels this device user rows with the stored name', async () => {
    userIdentity.setName('alenna');
    const target = await render({ role: 'user', content: [{ type: 'text', text: 'status?' }] } as PimoteAgentMessage);

    const chips = speakerChips(target, 'user');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent?.trim()).toBe('alenna');
  });

  it('keeps the plain user avatar when this device has no name', async () => {
    const target = await render({ role: 'user', content: [{ type: 'text', text: 'status?' }] } as PimoteAgentMessage);

    expect(speakerChips(target, 'user')).toHaveLength(0);
    expect(target.querySelector('.user-icon')).not.toBeNull();
  });
});
