import { describe, it, expect } from 'vitest';
import { buildDownloadInbox, buildDownloadToast, formatDownloadSize } from './download-presentation.js';
import type { DownloadItem, DownloadUpdateEvent } from '@pimote/shared';

const item: DownloadItem = {
  id: 'opaque-1',
  filename: 'report.pdf',
  sizeBytes: 1536,
  href: '/d/opaque-1',
};

const olderItem: DownloadItem = {
  id: 'opaque-old',
  filename: 'older.txt',
  sizeBytes: 10,
  href: '/d/opaque-old',
};

function offeredUpdate(downloads: DownloadItem[] = [item], offeredDownloadId = item.id): DownloadUpdateEvent {
  return { type: 'download_update', sessionId: 'session-1', cause: 'offered', offeredDownloadId, downloads };
}

function silentUpdate(cause: Exclude<DownloadUpdateEvent['cause'], 'offered'>, downloads: DownloadItem[] = [item]): DownloadUpdateEvent {
  return { type: 'download_update', sessionId: 'session-1', cause, downloads };
}

describe('download presentation', () => {
  describe('formatDownloadSize', () => {
    it('formats zero and byte-sized files without losing the exact size', () => {
      expect(formatDownloadSize(0)).toBe('0 B');
      expect(formatDownloadSize(512)).toBe('512 B');
    });

    it('formats larger registration sizes with human-readable units', () => {
      expect(formatDownloadSize(1536)).toMatch(/1\.5|1,?\.5/);
      expect(formatDownloadSize(5 * 1024 * 1024)).toMatch(/5.*MB/i);
    });
  });

  describe('buildDownloadToast', () => {
    it('creates an actionable native-link toast for the exact newly offered item in a multi-item snapshot', () => {
      expect(buildDownloadToast(offeredUpdate([olderItem, item], item.id))).toEqual({
        item,
        filename: 'report.pdf',
        sizeLabel: expect.any(String),
        href: '/d/opaque-1',
      });
    });

    it.each(['restored', 'consumed', 'revoked'] as const)('does not toast a %s snapshot replay', (cause) => {
      expect(buildDownloadToast(silentUpdate(cause))).toBeUndefined();
    });

    it('does not produce a toast when the offered item is absent from its snapshot', () => {
      expect(buildDownloadToast(offeredUpdate([], item.id))).toBeUndefined();
    });
  });

  describe('buildDownloadInbox', () => {
    it('shows pending native links only for the currently viewed session', () => {
      expect(buildDownloadInbox({ viewedSessionId: 'session-1', sessionId: 'session-1', downloads: [item] })).toEqual({
        visible: true,
        items: [item],
      });
    });

    it('hides a background session inbox even when it has pending registrations', () => {
      expect(buildDownloadInbox({ viewedSessionId: 'session-2', sessionId: 'session-1', downloads: [item] })).toEqual({
        visible: false,
        items: [],
      });
    });

    it('hides the control when the viewed session has no pending registrations', () => {
      expect(buildDownloadInbox({ viewedSessionId: 'session-1', sessionId: 'session-1', downloads: [] })).toEqual({
        visible: false,
        items: [],
      });
    });

    it('hides the inbox when no session is viewed', () => {
      expect(buildDownloadInbox({ viewedSessionId: null, sessionId: 'session-1', downloads: [item] })).toEqual({
        visible: false,
        items: [],
      });
    });
  });
});
