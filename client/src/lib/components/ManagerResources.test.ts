// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import ManagerResources from './ManagerResources.svelte';
import type { PerSessionState } from '$lib/stores/session-registry.svelte.js';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  document.body.innerHTML = '';
});

function render(source: PerSessionState | null) {
  const target = document.createElement('div');
  document.body.append(target);
  component = mount(ManagerResources, { target, props: { source } });
  return target;
}

describe('ManagerResources', () => {
  it('renders report cards in a new tab and explicit download links', () => {
    const target = render({
      panelCards: [{ id: 'report', header: { title: 'Report', tag: 'summary' }, href: '/s/report/' }],
      downloads: [{ id: 'file', filename: 'report.txt', sizeBytes: 100, href: '/d/file' }],
    } as PerSessionState);
    const report = target.querySelector('a[href="/s/report/"]')!;
    expect(report.getAttribute('target')).toBe('_blank');
    expect(report.getAttribute('rel')).toContain('noopener');
    expect(report.textContent).toContain('Report');
    const file = target.querySelector('a[href="/d/file"]')!;
    expect(file.hasAttribute('download')).toBe(true);
    expect(file.textContent).toContain('report.txt');
  });

  it('does not render an empty resources area', () => {
    expect(render(null).querySelector('section')).toBeNull();
  });
});
