import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('manager transcript card', () => {
  const managerChat = readFileSync(resolve(__dirname, 'ManagerChat.svelte'), 'utf8');
  const dashboard = readFileSync(resolve(__dirname, 'Dashboard.svelte'), 'utf8');
  const toolbar = readFileSync(resolve(__dirname, 'HomeToolbar.svelte'), 'utf8');

  it('renders inline under the toolbar on every viewport — no fullscreen sheet', () => {
    expect(dashboard).toContain('<ManagerChat />');
    expect(dashboard).not.toContain('variant="expanded"');
    expect(dashboard).not.toContain('managerOpen');
  });

  it('only appears once a conversation exists', () => {
    expect(managerChat).toContain('hasConversation');
  });

  it('the composer lives in the toolbar box, not the card', () => {
    expect(toolbar).toContain('aria-label="Message the manager"');
    expect(managerChat).not.toContain('<textarea');
  });

  it('has exactly one dismiss affordance (the card header X)', () => {
    expect(managerChat.split('title="Dismiss manager conversation"').length - 1).toBe(1);
  });
});
