import { describe, expect, it } from 'vitest';
import { HubActivity } from './hub-activity.js';

describe('HubActivity', () => {
  it('reports requested paths that still host a session after the close', async () => {
    // The close source closed the idle slot in `/work/platform/api` but a
    // working or observed session keeps `/work/platform` hosted.
    const activity = new HubActivity({
      closeIdleSessionsAt: async (paths) => paths.filter((path) => path === '/work/platform'),
      externalPiWorkingDirectories: async () => [],
    });

    const busy = await activity.closeIdleSessionsAt(['/work/platform', '/work/platform/api', '/work/other']);

    expect(busy).toEqual(['/work/platform']);
  });

  it('reports requested paths containing an external pi working directory in their subtree', async () => {
    const activity = new HubActivity({
      closeIdleSessionsAt: async () => [],
      externalPiWorkingDirectories: async () => ['/work/platform/api/src'],
    });

    const busy = await activity.closeIdleSessionsAt(['/work/platform', '/work/platform/api', '/work/other']);

    expect(busy).toEqual(expect.arrayContaining(['/work/platform', '/work/platform/api']));
    expect(busy).not.toContain('/work/other');
  });

  it('does not confuse a sibling path with a descendant', async () => {
    const activity = new HubActivity({
      closeIdleSessionsAt: async () => ['/work/platform-other'],
      externalPiWorkingDirectories: async () => [],
    });

    await expect(activity.closeIdleSessionsAt(['/work/platform'])).resolves.toEqual([]);
  });

  it.each(['session close', 'external pi'])('fails closed when the %s source fails', async (kind) => {
    const activity = new HubActivity({
      closeIdleSessionsAt: async () => {
        if (kind === 'session close') throw new Error('activity unavailable');
        return [];
      },
      externalPiWorkingDirectories: async () => {
        if (kind === 'external pi') throw new Error('activity unavailable');
        return [];
      },
    });

    await expect(activity.closeIdleSessionsAt(['/work/platform'])).rejects.toThrow();
  });
});
