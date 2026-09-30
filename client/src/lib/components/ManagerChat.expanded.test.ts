import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ManagerChat mobile expanded layout', () => {
  const managerChat = readFileSync(resolve(__dirname, 'ManagerChat.svelte'), 'utf8');
  const dashboard = readFileSync(resolve(__dirname, 'Dashboard.svelte'), 'utf8');

  it('mobile sheet renders the expanded variant, not the desktop embed widget', () => {
    expect(dashboard).toContain('<ManagerChat variant="expanded" />');
  });

  it('expanded variant is a full-height column with the input pinned to the bottom', () => {
    expect(managerChat).toContain("variant === 'expanded'");
    expect(managerChat).toContain('flex h-full min-h-0 flex-col');
    // Bottom edge respects keyboard/home-indicator safe area, same contract as InputBar.
    expect(managerChat).toContain('pb-[max(env(safe-area-inset-bottom),8px)]');
  });

  it('has exactly one dismiss affordance (the embed card header X)', () => {
    expect(managerChat.split('title="Dismiss manager conversation"').length - 1).toBe(1);
  });
});
