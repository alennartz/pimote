import { IMAGE_TOO_LARGE_PLACEHOLDER, MAX_IMAGE_BASE64_LENGTH, type PimoteImageContent, type PimoteMessageContent } from '@pimote/shared';

export function imageFromDataUrl(dataUrl: string): PimoteImageContent | undefined {
  const match = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) return undefined;
  return { mimeType: match[1], data: match[2] };
}

export function imageToDataUrl(image: PimoteImageContent): string {
  if (image.data !== undefined) return `data:${image.mimeType};base64,${image.data}`;
  return image.url ?? '';
}

export function imageFromToolData(value: unknown): PimoteImageContent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { type?: unknown; data?: unknown; url?: unknown; mimeType?: unknown };
  if (candidate.type !== 'image' || typeof candidate.mimeType !== 'string' || !candidate.mimeType.startsWith('image/')) return undefined;
  if (typeof candidate.url === 'string' && /^\/i\/[a-f0-9]{64}$/.test(candidate.url)) return { url: candidate.url, mimeType: candidate.mimeType };
  if (typeof candidate.data !== 'string' || candidate.data.length > MAX_IMAGE_BASE64_LENGTH) return undefined;
  return { data: candidate.data, mimeType: candidate.mimeType };
}

export function imageContentBlocksFromDataUrls(dataUrls: readonly string[]): PimoteMessageContent[] {
  return dataUrls.flatMap((dataUrl): PimoteMessageContent[] => {
    const image = imageFromDataUrl(dataUrl);
    if (!image?.data) return [];
    if (image.data.length > MAX_IMAGE_BASE64_LENGTH) {
      return [{ type: 'text', text: IMAGE_TOO_LARGE_PLACEHOLDER }];
    }
    return [{ type: 'image', image }];
  });
}
