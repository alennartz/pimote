// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { sessionRegistry } from '$lib/stores/session-registry.svelte.js';
import { connection } from '$lib/stores/connection.svelte.js';

// mobile-viewport.svelte.ts seeds its state from matchMedia at module load,
// and InputBar imports it statically — so the stub must be installed before
// the component module (and its imports) are first evaluated below.
type ChangeListener = (event: { matches: boolean }) => void;
const changeListeners = new Set<ChangeListener>();
let mobileMatches = false;

vi.stubGlobal(
  'matchMedia',
  vi.fn(() => ({
    get matches() {
      return mobileMatches;
    },
    addEventListener: (_type: 'change', listener: ChangeListener) => {
      changeListeners.add(listener);
    },
    removeEventListener: (_type: 'change', listener: ChangeListener) => {
      changeListeners.delete(listener);
    },
  })),
);

let InputBar: typeof import('./InputBar.svelte').default;

beforeAll(async () => {
  ({ default: InputBar } = await import('./InputBar.svelte'));
});

function setMobile(matches: boolean) {
  mobileMatches = matches;
  for (const listener of changeListeners) listener({ matches });
}

function setupSession() {
  sessionRegistry.addSession('s1', '/workspace/project', 'project');
  sessionRegistry.switchTo('s1');
  connection.ready = true;
}

function render() {
  const target = document.createElement('div');
  const component = mount(InputBar, { target });
  return { target, destroy: () => unmount(component) };
}

function messageTextarea(target: HTMLElement): HTMLTextAreaElement {
  return target.querySelector('textarea[aria-label="Message"]')!;
}

function bashTextarea(target: HTMLElement): HTMLTextAreaElement {
  return target.querySelector('textarea[aria-label="Bash command"]')!;
}

afterEach(() => {
  sessionRegistry.sessions = {};
  sessionRegistry.viewedSessionId = null;
  connection.ready = false;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('InputBar mobile spellcheck', () => {
  it('disables web spellcheck on the message textarea on mobile viewports', async () => {
    setupSession();
    setMobile(true);
    const { target, destroy } = render();
    await tick();

    // Web spellcheck triggers Chrome on Android to hide the IME when the
    // spell-suggestion popup opens, so it must be off on mobile.
    expect(messageTextarea(target).getAttribute('spellcheck')).toBe('false');
    // The bash editor never wants web spellcheck, mobile or not.
    expect(bashTextarea(target).getAttribute('spellcheck')).toBe('false');
    destroy();
  });

  it('keeps web spellcheck on the message textarea on desktop viewports', async () => {
    setupSession();
    setMobile(false);
    const { target, destroy } = render();
    await tick();

    expect(messageTextarea(target).getAttribute('spellcheck')).toBe('true');
    destroy();
  });

  it('follows the breakpoint when the viewport crosses it while mounted', async () => {
    setupSession();
    setMobile(true);
    const { target, destroy } = render();
    await tick();
    expect(messageTextarea(target).getAttribute('spellcheck')).toBe('false');

    setMobile(false);
    await tick();
    expect(messageTextarea(target).getAttribute('spellcheck')).toBe('true');
    destroy();
  });
});
