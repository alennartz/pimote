import { describe, expect, it } from 'vitest';
import { HubActivity } from './hub-activity.js';

describe('HubActivity', () => {
  it.each(['session', 'external pi'])('reports paths containing an active %s in their subtree', async (kind) => {
    const cwd = '/work/platform/api/src';
    const activity = new HubActivity({
      sessionWorkingDirectories: async () => (kind === 'session' ? [cwd] : []),
      externalPiWorkingDirectories: async () => (kind === 'external pi' ? [cwd] : []),
    });

    const busy = await activity.findBusyPaths(['/work/platform', '/work/platform/api', '/work/other']);

    expect(busy).toEqual(expect.arrayContaining(['/work/platform', '/work/platform/api']));
    expect(busy).not.toContain('/work/other');
  });

  it('does not confuse a sibling path with a descendant', async () => {
    const activity = new HubActivity({
      sessionWorkingDirectories: async () => ['/work/platform-other'],
      externalPiWorkingDirectories: async () => [],
    });

    await expect(activity.findBusyPaths(['/work/platform'])).resolves.toEqual([]);
  });

  it.each(['session', 'external pi'])('fails closed when the %s activity source fails', async (kind) => {
    const activity = new HubActivity({
      sessionWorkingDirectories: async () => {
        if (kind === 'session') throw new Error('activity unavailable');
        return [];
      },
      externalPiWorkingDirectories: async () => {
        if (kind === 'external pi') throw new Error('activity unavailable');
        return [];
      },
    });

    await expect(activity.findBusyPaths(['/work/platform'])).rejects.toThrow();
  });
});
