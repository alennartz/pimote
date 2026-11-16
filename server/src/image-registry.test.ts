import { describe, expect, it } from 'vitest';
import { getRegisteredImage, registerImage, resolveImageInputs } from './image-registry.js';

describe('image registry', () => {
  it('registers one content-addressed path and resolves it for the pi prompt API', () => {
    const bytes = Buffer.from('unique-prompt-image');
    const url = registerImage('image/webp', bytes);
    expect(url).toMatch(/^\/i\/[a-f0-9]{64}$/);
    expect(getRegisteredImage(url!.slice('/i/'.length))?.buffer).toEqual(bytes);
    expect(resolveImageInputs([url!])).toEqual([{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/webp' }]);
  });

  it('continues to accept legacy data URLs from native clients', () => {
    expect(resolveImageInputs(['data:image/png;base64,AQIDBA=='])).toEqual([{ type: 'image', data: 'AQIDBA==', mimeType: 'image/png' }]);
  });

  it('rejects an expired reference instead of dispatching an empty image', () => {
    expect(() => resolveImageInputs([`/i/${'f'.repeat(64)}`])).toThrow('image_upload_expired');
  });
});
