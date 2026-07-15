/** A system notification may open a session, but must never redeem a one-shot href. */
export interface DownloadNotificationIntent {
  sessionId: string;
  folderPath?: string;
  openDownloads: true;
}

/** Narrow adapter over the existing switch/adopt session flows and inbox UI state. */
export interface NotificationSessionPort {
  hasSession(sessionId: string): boolean;
  switchToSession(sessionId: string): void;
  openExistingSession(sessionId: string, folderPath: string): Promise<boolean>;
  openDownloadInbox(sessionId: string): void;
}

/**
 * Switch or adopt the owning session before opening its session-local inbox.
 * A missing folder path cannot be adopted, so it is intentionally a no-op.
 */
export async function handleDownloadNotificationIntent(intent: DownloadNotificationIntent, port: NotificationSessionPort): Promise<void> {
  if (port.hasSession(intent.sessionId)) {
    port.switchToSession(intent.sessionId);
    port.openDownloadInbox(intent.sessionId);
    return;
  }

  if (!intent.folderPath) {
    return;
  }

  const adopted = await port.openExistingSession(intent.sessionId, intent.folderPath);
  if (adopted) {
    port.openDownloadInbox(intent.sessionId);
  }
}
