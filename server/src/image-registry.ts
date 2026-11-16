import { createHash } from 'node:crypto';
import { MAX_IMAGE_BASE64_LENGTH } from '../../shared/dist/index.js';

/** Content-addressed transcript image registry. The message mapper registers
 *  every mapped image here and emits `/i/<sha256>` URLs on the wire, so
 *  transcripts replay without base64 payloads. */
interface RegisteredImage {
  mimeType: string;
  buffer: Buffer;
}

const MAX_REGISTRY_BYTES = 64 * 1024 * 1024;
const IMAGE_MIME_PATTERN = /^image\/[a-z0-9.+-]+$/i;

const registry = new Map<string, RegisteredImage>();
let registryBytes = 0;

function touch(hex: string, image: RegisteredImage): void {
  registry.delete(hex);
  registry.set(hex, image);
}

function evictOverflow(): void {
  while (registryBytes > MAX_REGISTRY_BYTES && registry.size > 0) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    const image = registry.get(oldest)!;
    registryBytes -= image.buffer.length;
    registry.delete(oldest);
  }
}

const DATA_URL_PATTERN = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i;
const IMAGE_REF_PATTERN = /^\/i\/([a-f0-9]{64})$/;

/** Register inline image bytes under their content hash and return the URL
 *  path for the wire. Mapping a transcript re-registers its images, so any
 *  client that receives a URL has just refreshed those entries. */
export function registerImage(mimeType: string, buffer: Buffer): string | null {
  const normalizedMimeType = mimeType.toLowerCase();
  if (!IMAGE_MIME_PATTERN.test(normalizedMimeType) || buffer.length === 0) return null;
  const hex = createHash('sha256').update(normalizedMimeType).update('\0').update(buffer).digest('hex');
  const existing = registry.get(hex);
  if (existing) {
    touch(hex, existing);
    return `/i/${hex}`;
  }
  // Keep one image at most below the transcript limit. The LRU may evict
  // older refs; the next transcript mapping re-registers bytes from pi.
  if (buffer.length > MAX_REGISTRY_BYTES) return null;
  registry.set(hex, { mimeType: normalizedMimeType, buffer });
  registryBytes += buffer.length;
  evictOverflow();
  return `/i/${hex}`;
}

export function registerImageDataUrl(dataUrl: string): string | null {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match || match[2].length > MAX_IMAGE_BASE64_LENGTH) return null;
  return registerImage(match[1], Buffer.from(match[2], 'base64'));
}

/** Accept uploaded image refs and legacy native-client data URLs. */
export function resolveImageInputs(images?: string[]): { type: 'image'; data: string; mimeType: string }[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((value) => {
    const ref = IMAGE_REF_PATTERN.exec(value);
    if (ref) {
      const registered = getRegisteredImage(ref[1]);
      if (!registered) throw new Error('image_upload_expired');
      return { type: 'image' as const, data: registered.buffer.toString('base64'), mimeType: registered.mimeType };
    }
    const dataUrl = DATA_URL_PATTERN.exec(value);
    if (!dataUrl || dataUrl[2].length > MAX_IMAGE_BASE64_LENGTH) throw new Error('Invalid image data URL');
    return { type: 'image' as const, data: dataUrl[2], mimeType: dataUrl[1] };
  });
}

/** Serve a registered image. A miss means the entry was evicted or the server
 *  restarted; the next transcript map re-registers it. */
export function getRegisteredImage(hex: string): { mimeType: string; buffer: Buffer } | null {
  const image = registry.get(hex);
  if (!image) return null;
  touch(hex, image);
  return image;
}
