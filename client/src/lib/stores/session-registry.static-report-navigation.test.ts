/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let viewportListener: ((event: { matches: boolean }) => void) | null = null;
const viewportQuery = {
  matches: false,
  addEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
    viewportListener = listener;
  },
  removeEventListener: vi.fn(),
} as unknown as MediaQueryList;
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn(() => viewportQuery),
});

const { SessionRegistry } = await import('./session-registry.svelte.js');

let open: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;

function setMobileViewport(mobile: boolean): void {
  viewportListener?.({ matches: mobile });
}

function registryViewing(sessionId: string): InstanceType<typeof SessionRegistry> {
  const registry = new SessionRegistry();
  registry.addSession(sessionId, '/workspace', 'workspace');
  registry.viewedSessionId = sessionId;
  return registry;
}

beforeEach(() => {
  open = vi.fn();
  assign = vi.fn();
  vi.stubGlobal('window', {
    location: { origin: 'https://pimote.example', assign },
    open,
  });
  setMobileViewport(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMobileViewport(false);
});

describe('static report publish navigation', () => {
  it('navigates the current tab when a report is published on mobile', () => {
    setMobileViewport(true);
    const registry = registryViewing('s1');

    registry.handleEvent({ type: 'pimote_navigate', sessionId: 's1', url: '/s/report/' });

    expect(assign).toHaveBeenCalledWith('/s/report/');
    expect(open).not.toHaveBeenCalled();
  });

  it('opens a published report in a new tab on desktop', () => {
    const registry = registryViewing('s1');

    registry.handleEvent({ type: 'pimote_navigate', sessionId: 's1', url: '/s/report/' });

    expect(open).toHaveBeenCalledWith('/s/report/', '_blank', 'noopener,noreferrer');
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps non-report surfaces in a new tab on mobile', () => {
    setMobileViewport(true);
    const registry = registryViewing('s1');

    registry.handleEvent({ type: 'pimote_navigate', sessionId: 's1', url: '/other/' });

    expect(open).toHaveBeenCalledWith('/other/', '_blank', 'noopener,noreferrer');
    expect(assign).not.toHaveBeenCalled();
  });
});
