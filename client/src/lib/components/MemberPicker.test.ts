// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import type { FolderInfo } from '@pimote/shared';
import MemberPicker from './MemberPicker.svelte';

// bits-ui popper layers expect browser APIs jsdom doesn't ship.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

function makeFolder(overrides: Partial<FolderInfo> & Pick<FolderInfo, 'path' | 'name'>): FolderInfo {
  return {
    nature: 'code',
    shortcutCount: 0,
    favorite: false,
    archived: false,
    tags: [],
    missing: false,
    activeSessionCount: 0,
    externalProcessCount: 0,
    ...overrides,
  };
}

const alpha = makeFolder({ path: '/w/alpha', name: 'alpha' });
const beta = makeFolder({ path: '/w/beta', name: 'beta', nature: 'persona' });

function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('button, label')].find((el) => el.textContent?.includes(name));
  if (!found) throw new Error(`candidate row not found: ${name}`);
  return found;
}

function checkboxIn(el: HTMLElement): HTMLInputElement {
  const box = el.querySelector('input[type="checkbox"]');
  if (!(box instanceof HTMLInputElement)) throw new Error('no checkbox in row');
  return box;
}

function render(candidates: FolderInfo[], selectedPaths: string[] = []) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const onToggle = vi.fn();
  const component = mount(MemberPicker, { target, props: { candidates, selectedPaths, onToggle } });
  return {
    onToggle,
    destroy: () => {
      unmount(component);
      document.body.innerHTML = '';
    },
  };
}

let destroy: (() => void) | null = null;
afterEach(() => {
  destroy?.();
  destroy = null;
});

describe('MemberPicker', () => {
  it('renders code and persona candidates as checkbox rows', () => {
    ({ destroy } = render([alpha, beta]));

    expect(document.body.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(row('alpha')).toBeTruthy();
    expect(row('beta')).toBeTruthy();
  });

  it('reflects the caller-owned selection in the checkbox states', () => {
    ({ destroy } = render([alpha, beta], ['/w/alpha']));

    expect(checkboxIn(row('alpha')).checked).toBe(true);
    expect(checkboxIn(row('beta')).checked).toBe(false);
  });

  it('toggles candidates through onToggle with the folder path', () => {
    const ctx = render([alpha, beta]);
    destroy = ctx.destroy;

    row('beta').click();

    expect(ctx.onToggle).toHaveBeenCalledWith('/w/beta');
    expect(ctx.onToggle).not.toHaveBeenCalledWith('/w/alpha');
  });
});
