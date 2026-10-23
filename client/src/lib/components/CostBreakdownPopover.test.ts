// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { PimoteUsageBreakdown } from '@pimote/shared';
import CostBreakdownPopover from './CostBreakdownPopover.svelte';

const mounted: ReturnType<typeof mount>[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
});

describe('CostBreakdownPopover presentation', () => {
  it('uses a plain numeric trigger without explanatory copy in the breakdown', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(CostBreakdownPopover, {
        target,
        props: {
          totalCostUsd: 0.13,
          contextLabel: 'Assistant message',
          breakdown: {
            tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, total: 170 },
            cost: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0 },
          } satisfies PimoteUsageBreakdown,
        },
      }),
    );
    await tick();

    const trigger = target.querySelector<HTMLButtonElement>('button.cost-disclosure-trigger');
    expect(trigger?.textContent?.trim()).toBe('$0.13');
    expect(trigger?.classList.contains('underline')).toBe(false);
    expect(trigger?.classList.contains('decoration-dotted')).toBe(false);

    trigger?.click();
    await tick();
    await tick();

    const popover = document.body.querySelector('[role="dialog"]');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain('Input');
    expect(popover?.textContent).toContain('Total');
    expect(popover?.textContent).toContain('$0.10');
    expect(popover?.textContent).toContain('2.00¢');
    expect(popover?.textContent).toContain('1.00¢');
    expect(popover?.textContent).toContain('0.00¢');
    expect(popover?.querySelector('p')).toBeNull();
    expect(popover?.textContent).not.toContain('configured model prices');
    expect(popover?.textContent).not.toContain('invoice amount');
  });
});
