import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('manager chat presentation', () => {
  const managerChat = readFileSync(resolve(__dirname, 'ManagerChat.svelte'), 'utf8');
  const dashboard = readFileSync(resolve(__dirname, 'Dashboard.svelte'), 'utf8');
  const toolbar = readFileSync(resolve(__dirname, 'HomeToolbar.svelte'), 'utf8');

  it('presents from local UI state, never inline under the box', () => {
    expect(dashboard).not.toContain('<ManagerChat />');
    expect(dashboard).not.toContain('managerStore');
    expect(dashboard).toContain('managerOpen');
    expect(dashboard).toContain('variant="panel"');
    expect(dashboard).toContain('variant="sheet"');
  });

  it('desktop: homepage narrows to a left rail, manager panel takes the right', () => {
    expect(dashboard).toContain('splitView');
    expect(dashboard).toContain('md:w-1/4');
    expect(dashboard).toContain('md:border-r');
    expect(managerChat).toContain('border-l');
  });

  it('mobile: sheet mirroring the session page chrome', () => {
    expect(dashboard).toContain('sheetView');
    expect(dashboard).toContain('isMobileViewport');
    expect(managerChat).toContain('fixed inset-0');
    expect(managerChat).toContain('md:hidden');
    // Header and composer honour the same safe-area contracts as the session view.
    expect(managerChat).toContain('pt-[max(env(safe-area-inset-top),0.25rem)]');
    expect(managerChat).toContain('pb-[max(env(safe-area-inset-bottom),8px)]');
    expect(managerChat).toContain('max-w-3xl');
  });

  it('both variants have exactly one dismiss affordance', () => {
    expect(managerChat.split('title="Dismiss manager conversation"').length - 1).toBe(2);
  });

  it('composers share one draft with the homepage box', () => {
    expect(managerChat).toContain('bind:value={managerDraft}');
    expect(toolbar).toContain('bind:value={managerDraft}');
    expect(toolbar).toContain('aria-label="Message the manager"');
  });
});
