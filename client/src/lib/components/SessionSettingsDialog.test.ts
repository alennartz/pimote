// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import SessionSettingsDialog from './SessionSettingsDialog.svelte';

let component: ReturnType<typeof mount> | undefined;

async function render(): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(SessionSettingsDialog, { target });
  await Promise.resolve();
  return target;
}

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
});

describe('SessionSettingsDialog trigger', () => {
  it('uses a prominent gear button with desktop and mobile sizing', async () => {
    const target = await render();
    const trigger = target.querySelector<HTMLButtonElement>('button[title="Session settings"]');

    expect(trigger).not.toBeNull();
    expect(trigger?.querySelector('.lucide-settings')).not.toBeNull();
    expect(trigger?.querySelector('.lucide-sliders-horizontal')).toBeNull();
    expect(trigger?.classList.contains('size-10')).toBe(true);
    expect(trigger?.classList.contains('md:size-14')).toBe(true);
  });
});
