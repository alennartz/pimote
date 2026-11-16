import { MAX_IMAGE_BASE64_LENGTH } from '@pimote/shared';
import { imageFromDataUrl } from './image-content.js';

/** Upload one staged image body outside the WebSocket transcript. The server
 *  returns a content-addressed path that the prompt can carry by reference. */
export async function uploadImage(dataUrl: string): Promise<string> {
  const image = imageFromDataUrl(dataUrl);
  if (!image?.data) throw new Error('invalid_image_data_url');
  if (image.data.length > MAX_IMAGE_BASE64_LENGTH) throw new Error('image_too_large');

  const source = await fetch(dataUrl);
  if (!source.ok) throw new Error('image_decode_failed');
  const body = await source.blob();
  const response = await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': image.mimeType },
    body,
  });
  if (!response.ok) throw new Error(response.status === 413 ? 'image_too_large' : 'image_upload_failed');
  const result = (await response.json()) as { url?: unknown };
  if (typeof result.url !== 'string' || !/^\/i\/[a-f0-9]{64}$/.test(result.url)) throw new Error('invalid_image_upload_response');
  return result.url;
}

/** Preserve attachment order and upload several images concurrently. */
export async function uploadImages(dataUrls: readonly string[]): Promise<string[]> {
  return Promise.all(dataUrls.map(uploadImage));
}
