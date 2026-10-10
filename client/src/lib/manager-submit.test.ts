import { describe, expect, it, vi } from 'vitest';
import { submitManagerMessage, type ManagerSubmitPorts } from './manager-composer.js';

// The shared manager-area submit operation (plan step 8; review findings 2
// and 5): open-then-prompt-then-navigate for a new session, navigation on the
// confirmed open and not on prompt admission, draft-preserving rejections, and
// the re-entry guard that makes a double submit a no-op.

function makePorts(overrides: Partial<ManagerSubmitPorts> = {}): ManagerSubmitPorts {
  return {
    openManagerSession: vi.fn(async () => ({ success: true, sessionId: 'manager-new' })),
    prompt: vi.fn(async () => true),
    switchToSession: vi.fn(),
    ...overrides,
  };
}

const openNewInput = { viewed: undefined, viewedIsManager: false, managerRoot: '/srv/manager', text: '  hello  ' };
const continueInput = { ...openNewInput, viewed: { sessionId: 'manager-1' }, viewedIsManager: true };

describe('submitManagerMessage — open-new', () => {
  it('opens a new manager session, prompts it with the trimmed text, then navigates to it', async () => {
    const ports = makePorts();

    await expect(submitManagerMessage(openNewInput, ports)).resolves.toBe(true);

    expect(ports.openManagerSession).toHaveBeenCalledWith('/srv/manager');
    expect(ports.prompt).toHaveBeenCalledWith('manager-new', 'hello');
    expect(ports.switchToSession).toHaveBeenCalledWith('manager-new');
    // Plan order: prompt the opened session, then navigate.
    expect(vi.mocked(ports.prompt).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ports.switchToSession).mock.invocationCallOrder[0]);
  });

  it('navigates to the opened session and reports the rejection when the prompt is refused', async () => {
    const ports = makePorts({ prompt: vi.fn(async () => false) });

    // The draft is preserved (false), and the opened session is on screen so a
    // retry continues it instead of opening a duplicate.
    await expect(submitManagerMessage(openNewInput, ports)).resolves.toBe(false);
    expect(ports.switchToSession).toHaveBeenCalledWith('manager-new');
  });

  it('does not prompt or navigate when the open is refused', async () => {
    const ports = makePorts({ openManagerSession: vi.fn(async () => ({ success: false })) });

    await expect(submitManagerMessage(openNewInput, ports)).resolves.toBe(false);
    expect(ports.prompt).not.toHaveBeenCalled();
    expect(ports.switchToSession).not.toHaveBeenCalled();
  });

  it('ignores a placeholder session id from the open', async () => {
    const ports = makePorts({ openManagerSession: vi.fn(async () => ({ success: true, sessionId: 'pending-1' })) });

    await expect(submitManagerMessage(openNewInput, ports)).resolves.toBe(false);
    expect(ports.prompt).not.toHaveBeenCalled();
    expect(ports.switchToSession).not.toHaveBeenCalled();
  });
});

describe('submitManagerMessage — continue', () => {
  it('prompts the viewed manager session without opening a new one', async () => {
    const ports = makePorts();

    await expect(submitManagerMessage(continueInput, ports)).resolves.toBe(true);

    expect(ports.prompt).toHaveBeenCalledWith('manager-1', 'hello');
    expect(ports.openManagerSession).not.toHaveBeenCalled();
    expect(ports.switchToSession).not.toHaveBeenCalled();
  });

  it('reports the rejection when the continue prompt is refused', async () => {
    const ports = makePorts({ prompt: vi.fn(async () => false) });

    await expect(submitManagerMessage(continueInput, ports)).resolves.toBe(false);
    expect(ports.openManagerSession).not.toHaveBeenCalled();
  });

  it('never prompts a placeholder viewed session', async () => {
    const ports = makePorts();

    await expect(submitManagerMessage({ ...continueInput, viewed: { sessionId: 'pending-2' } }, ports)).resolves.toBe(false);
    expect(ports.prompt).not.toHaveBeenCalled();
    expect(ports.openManagerSession).not.toHaveBeenCalled();
  });
});

describe('submitManagerMessage — re-entry guard', () => {
  it('rejects a second submit while one is in flight', async () => {
    let releasePrompt!: (sent: boolean) => void;
    const promptGate = new Promise<boolean>((resolve) => {
      releasePrompt = resolve;
    });
    const ports = makePorts({ prompt: vi.fn(() => promptGate) });

    const first = submitManagerMessage(openNewInput, ports);
    await expect(submitManagerMessage(openNewInput, ports)).resolves.toBe(false);

    expect(ports.openManagerSession).toHaveBeenCalledTimes(1);
    releasePrompt(true);
    await expect(first).resolves.toBe(true);
    expect(ports.prompt).toHaveBeenCalledTimes(1);
    expect(ports.switchToSession).toHaveBeenCalledTimes(1);
  });

  it('accepts a new submit after the in-flight one settles', async () => {
    const ports = makePorts();

    await expect(submitManagerMessage(openNewInput, ports)).resolves.toBe(true);
    await expect(submitManagerMessage(openNewInput, ports)).resolves.toBe(true);
    expect(ports.openManagerSession).toHaveBeenCalledTimes(2);
  });
});

describe('submitManagerMessage — input guards', () => {
  it('ignores empty text and a missing manager root without touching any port', async () => {
    const ports = makePorts();

    await expect(submitManagerMessage({ ...openNewInput, text: '   ' }, ports)).resolves.toBe(false);
    await expect(submitManagerMessage({ ...openNewInput, managerRoot: '' }, ports)).resolves.toBe(false);

    expect(ports.openManagerSession).not.toHaveBeenCalled();
    expect(ports.prompt).not.toHaveBeenCalled();
    expect(ports.switchToSession).not.toHaveBeenCalled();
  });
});
