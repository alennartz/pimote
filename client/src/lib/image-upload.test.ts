import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadImage, uploadImages } from './image-upload.js';

afterEach(() => vi.unstubAllGlobals());

describe('uploadImage', () => {
  it('uploads image bytes and returns the content-addressed path', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push([input, init]);
        if (String(input).startsWith('data:')) return { ok: true, blob: async () => new Blob(['image-bytes'], { type: 'image/png' }) };
        return { ok: true, json: async () => ({ url: `/i/${'b'.repeat(64)}` }) };
      }),
    );

    await expect(uploadImage('data:image/png;base64,AQIDBA==')).resolves.toBe(`/i/${'b'.repeat(64)}`);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe('data:image/png;base64,AQIDBA==');
    expect(calls[1]?.[0]).toBe('/api/images');
    expect(calls[1]?.[1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'image/png' } });
  });

  it('uploads several images concurrently and preserves attachment order', async () => {
    const refs = [`/i/${'c'.repeat(64)}`, `/i/${'d'.repeat(64)}`];
    let uploadIndex = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('data:')) return { ok: true, blob: async () => new Blob([String(input)]) };
        const url = refs[uploadIndex++];
        return { ok: true, json: async () => ({ url }) };
      }),
    );
    await expect(uploadImages(['data:image/png;base64,AAA', 'data:image/jpeg;base64,BBB'])).resolves.toEqual(refs);
    expect(uploadIndex).toBe(2);
  });

  it('rejects invalid data URLs and malformed upload responses', async () => {
    await expect(uploadImage('not-an-image')).rejects.toThrow('invalid_image_data_url');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob([]), json: async () => ({ url: '/not-an-image-ref' }) })),
    );
    await expect(uploadImage('data:image/png;base64,AQIDBA==')).rejects.toThrow('invalid_image_upload_response');
  });
});
