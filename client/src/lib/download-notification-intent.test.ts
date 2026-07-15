import { describe, expect, it, vi } from 'vitest';
import { handleDownloadNotificationIntent, type NotificationSessionPort } from './download-notification-intent.js';

function makePort(overrides: Partial<NotificationSessionPort> = {}): NotificationSessionPort & {
  switchToSession: ReturnType<typeof vi.fn>;
  openExistingSession: ReturnType<typeof vi.fn>;
  openDownloadInbox: ReturnType<typeof vi.fn>;
} {
  const port = {
    hasSession: () => false,
    switchToSession: vi.fn(),
    openExistingSession: vi.fn(async () => true),
    openDownloadInbox: vi.fn(),
    ...overrides,
  };
  return port as unknown as NotificationSessionPort & {
    switchToSession: ReturnType<typeof vi.fn>;
    openExistingSession: ReturnType<typeof vi.fn>;
    openDownloadInbox: ReturnType<typeof vi.fn>;
  };
}

const intent = { sessionId: 'session-1', folderPath: '/workspace/project', openDownloads: true } as const;

describe('handleDownloadNotificationIntent', () => {
  it('switches an already-open owning session and opens only its local inbox', async () => {
    const port = makePort({ hasSession: (sessionId) => sessionId === 'session-1' });

    await handleDownloadNotificationIntent(intent, port);

    expect(port.switchToSession).toHaveBeenCalledWith('session-1');
    expect(port.openExistingSession).not.toHaveBeenCalled();
    expect(port.openDownloadInbox).toHaveBeenCalledWith('session-1');
  });

  it('awaits adoption before opening the downloaded session inbox', async () => {
    const order: string[] = [];
    const port = makePort({
      openExistingSession: vi.fn(async () => {
        order.push('adopted');
        return true;
      }),
      openDownloadInbox: vi.fn(() => order.push('inbox-opened')),
    });

    await handleDownloadNotificationIntent(intent, port);

    expect(port.switchToSession).not.toHaveBeenCalled();
    expect(port.openExistingSession).toHaveBeenCalledWith('session-1', '/workspace/project');
    expect(order).toEqual(['adopted', 'inbox-opened']);
  });

  it('does not open an inbox when session adoption fails', async () => {
    const port = makePort({ openExistingSession: vi.fn(async () => false) });

    await handleDownloadNotificationIntent(intent, port);

    expect(port.openDownloadInbox).not.toHaveBeenCalled();
  });

  it('does nothing when a closed session has no folder path to adopt', async () => {
    const port = makePort();

    await handleDownloadNotificationIntent({ sessionId: 'session-1', openDownloads: true }, port);

    expect(port.switchToSession).not.toHaveBeenCalled();
    expect(port.openExistingSession).not.toHaveBeenCalled();
    expect(port.openDownloadInbox).not.toHaveBeenCalled();
  });
});
