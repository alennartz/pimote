import { describe, expect, it } from 'vitest';
import { planDownloadPushDelivery } from './download-push.js';

const payload = {
  reason: 'download' as const,
  sessionId: 'session-1',
  folderPath: '/workspace/project',
  sessionName: 'Report work',
  projectName: 'project',
  download: { downloadId: 'opaque-1', filename: 'report.pdf', sizeBytes: 42 },
};

describe('planDownloadPushDelivery', () => {
  it('emits no focused-client notification because the live update owns the one in-app toast', () => {
    expect(planDownloadPushDelivery({ payload, appInFocus: true })).toEqual({ kind: 'none' });
  });

  it('creates a background OS notification that opens the session-local inbox without a one-shot href', () => {
    const delivery = planDownloadPushDelivery({ payload, appInFocus: false });

    expect(delivery).toEqual({
      kind: 'system',
      title: 'Report work',
      body: expect.stringMatching(/report\.pdf/i),
      tag: 'pimote-session-1',
      data: { sessionId: 'session-1', folderPath: '/workspace/project', openDownloads: true },
    });
    expect(JSON.stringify(delivery)).not.toContain('href');
  });
});
