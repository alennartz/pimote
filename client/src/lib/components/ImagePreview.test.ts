// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ImagePreview from './ImagePreview.svelte';

const mounted: ReturnType<typeof mount>[] = [];

function pointerEvent(type: string, pointerId: number, clientX: number, clientY: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: 'touch' },
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
});

describe('ImagePreview', () => {
  it('opens a full-screen viewer with zoom controls', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(ImagePreview, {
        target,
        props: { image: { data: 'AQIDBA==', mimeType: 'image/png' }, alt: 'Screenshot' },
      }),
    );

    const openButton = target.querySelector<HTMLButtonElement>('[aria-label="Open image full screen"]');
    openButton?.click();
    await tick();

    const viewer = document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    expect(viewer?.querySelector<HTMLImageElement>('.image-viewer img')?.getAttribute('src')).toBe('data:image/png;base64,AQIDBA==');
    expect(viewer?.querySelector('[aria-label="Close image viewer"]')).not.toBeNull();
    expect(viewer?.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')?.disabled).toBe(true);

    viewer?.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click();
    await tick();
    expect(viewer?.querySelector('[aria-live="polite"]')?.textContent).toBe('125%');

    viewer?.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')?.click();
    await tick();
    expect(viewer?.querySelector('[aria-live="polite"]')?.textContent).toBe('100%');

    viewer?.querySelector<HTMLButtonElement>('[aria-label="Close image viewer"]')?.click();
    await tick();
    expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(openButton);
  });

  it('zooms with a two-pointer pinch gesture', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(ImagePreview, {
        target,
        props: { image: { data: 'AQIDBA==', mimeType: 'image/png' } },
      }),
    );

    target.querySelector<HTMLButtonElement>('[aria-label="Open image full screen"]')?.click();
    await tick();

    const viewer = document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    const canvas = viewer?.querySelector<HTMLElement>('[aria-label="Image viewing area"]');
    expect(canvas).not.toBeNull();
    Object.defineProperty(canvas!, 'setPointerCapture', { value: () => {} });

    canvas?.dispatchEvent(pointerEvent('pointerdown', 1, 100, 100));
    canvas?.dispatchEvent(pointerEvent('pointerdown', 2, 200, 100));
    canvas?.dispatchEvent(pointerEvent('pointermove', 2, 300, 100));
    await tick();

    expect(viewer?.querySelector('[aria-live="polite"]')?.textContent).toBe('200%');
  });
});
