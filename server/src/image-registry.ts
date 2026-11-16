import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAX_IMAGE_BASE64_LENGTH } from '../../shared/dist/index.js';

/** Content-addressed transcript image registry. The message mapper registers
 *  every mapped image here and emits `/i/<sha256>` URLs on the wire, so
 *  transcripts replay without base64 payloads. */
interface RegisteredImage {
  mimeType: string;
  buffer: Buffer;
}

const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_DISK_BYTES = 1024 * 1024 * 1024;
const MAX_IMAGE_BYTES = Math.floor((MAX_IMAGE_BASE64_LENGTH * 3) / 4);
const IMAGE_MIME_PATTERN = /^image\/[a-z0-9.+-]+$/i;
const DATA_URL_PATTERN = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i;
const IMAGE_REF_PATTERN = /^\/i\/([a-f0-9]{64})$/;

const registry = new Map<string, RegisteredImage>();
let registryBytes = 0;
const pendingWrites = new Map<string, Promise<void>>();
let pruneTimer: ReturnType<typeof setTimeout> | null = null;
let pruneWork: Promise<void> | null = null;

function imageCacheDirectory(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'pimote', 'images');
}

function imageFilePaths(hex: string): { binary: string; metadata: string } {
  const root = imageCacheDirectory();
  return { binary: join(root, `${hex}.bin`), metadata: join(root, `${hex}.mime`) };
}

function touch(hex: string, image: RegisteredImage): void {
  registry.delete(hex);
  registry.set(hex, image);
}

function evictMemoryOverflow(): void {
  while (registryBytes > MAX_MEMORY_BYTES && registry.size > 0) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    const image = registry.get(oldest)!;
    registryBytes -= image.buffer.length;
    registry.delete(oldest);
  }
}

async function pruneDiskCache(): Promise<void> {
  if (pruneWork) return pruneWork;
  pruneWork = (async () => {
    const root = imageCacheDirectory();
    let files: string[];
    try {
      files = await readdir(root);
    } catch {
      return;
    }
    const entries: Array<{ hex: string; bytes: number; modified: number }> = [];
    for (const name of files) {
      const match = /^([a-f0-9]{64})\.bin$/.exec(name);
      if (!match) continue;
      try {
        const info = await stat(join(root, name));
        entries.push({ hex: match[1], bytes: info.size, modified: info.mtimeMs });
      } catch {
        // A concurrent delete is already a successful eviction.
      }
    }
    let totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    if (totalBytes <= MAX_DISK_BYTES) return;
    entries.sort((left, right) => left.modified - right.modified);
    for (const entry of entries) {
      if (totalBytes <= MAX_DISK_BYTES) break;
      const paths = imageFilePaths(entry.hex);
      await Promise.all([unlink(paths.binary).catch(() => {}), unlink(paths.metadata).catch(() => {})]);
      totalBytes -= entry.bytes;
      const cached = registry.get(entry.hex);
      if (cached) {
        registryBytes -= cached.buffer.length;
        registry.delete(entry.hex);
      }
    }
  })().finally(() => {
    pruneWork = null;
  });
  return pruneWork;
}

function scheduleDiskPrune(): void {
  if (pruneTimer !== null) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    void pruneDiskCache().catch(() => {});
  }, 5_000);
  (pruneTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

async function persistImage(hex: string, image: RegisteredImage): Promise<void> {
  const pending = pendingWrites.get(hex);
  if (pending) return pending;
  const paths = imageFilePaths(hex);
  const work = (async () => {
    await mkdir(imageCacheDirectory(), { recursive: true, mode: 0o700 });
    const suffix = randomUUID();
    const binaryTemp = `${paths.binary}.${suffix}.tmp`;
    const metadataTemp = `${paths.metadata}.${suffix}.tmp`;
    try {
      await writeFile(binaryTemp, image.buffer, { mode: 0o600, flag: 'wx' });
      await writeFile(metadataTemp, image.mimeType, { mode: 0o600, flag: 'wx' });
      await rename(binaryTemp, paths.binary);
      await rename(metadataTemp, paths.metadata);
      scheduleDiskPrune();
    } finally {
      await Promise.all([unlink(binaryTemp).catch(() => {}), unlink(metadataTemp).catch(() => {})]);
    }
  })().finally(() => {
    if (pendingWrites.get(hex) === work) pendingWrites.delete(hex);
  });
  pendingWrites.set(hex, work);
  return work;
}

/** Register bytes under their MIME-sensitive content hash and return the URL. */
export function registerImage(mimeType: string, buffer: Buffer): string | null {
  const normalizedMimeType = mimeType.toLowerCase();
  if (!IMAGE_MIME_PATTERN.test(normalizedMimeType) || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
  const hex = createHash('sha256').update(normalizedMimeType).update('\0').update(buffer).digest('hex');
  const existing = registry.get(hex);
  const image = existing ?? { mimeType: normalizedMimeType, buffer };
  if (existing) touch(hex, existing);
  else {
    registry.set(hex, image);
    registryBytes += buffer.length;
    evictMemoryOverflow();
  }
  void persistImage(hex, image).catch(() => {});
  return `/i/${hex}`;
}

export function registerImageDataUrl(dataUrl: string): string | null {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match || match[2].length > MAX_IMAGE_BASE64_LENGTH) return null;
  return registerImage(match[1], Buffer.from(match[2], 'base64'));
}

/** Ensure an uploaded reference is durable before the client dispatches it. */
export async function persistImageRef(url: string): Promise<boolean> {
  const match = IMAGE_REF_PATTERN.exec(url);
  if (!match) return false;
  const image = registry.get(match[1]);
  if (!image) return (await getRegisteredImage(match[1])) !== null;
  await persistImage(match[1], image);
  return true;
}

/** Resolve uploaded image refs and legacy native-client data URLs for Pi. */
export async function resolveImageInputs(images?: string[]): Promise<{ type: 'image'; data: string; mimeType: string }[] | undefined> {
  if (!images || images.length === 0) return undefined;
  return Promise.all(
    images.map(async (value) => {
      const ref = IMAGE_REF_PATTERN.exec(value);
      if (ref) {
        const registered = await getRegisteredImage(ref[1]);
        if (!registered) throw new Error('image_upload_expired');
        return { type: 'image' as const, data: registered.buffer.toString('base64'), mimeType: registered.mimeType };
      }
      const dataUrl = DATA_URL_PATTERN.exec(value);
      if (!dataUrl || dataUrl[2].length > MAX_IMAGE_BASE64_LENGTH) throw new Error('Invalid image data URL');
      return { type: 'image' as const, data: dataUrl[2], mimeType: dataUrl[1] };
    }),
  );
}

/** Serve a registered image. The disk cache keeps content refs valid across
 *  memory eviction and server restarts. */
export async function getRegisteredImage(hex: string): Promise<RegisteredImage | null> {
  if (!/^[a-f0-9]{64}$/.test(hex)) return null;
  const inMemory = registry.get(hex);
  if (inMemory) {
    touch(hex, inMemory);
    return inMemory;
  }
  await pendingWrites.get(hex)?.catch(() => {});
  const paths = imageFilePaths(hex);
  try {
    const [buffer, mimeType] = await Promise.all([readFile(paths.binary), readFile(paths.metadata, 'utf8')]);
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES || !IMAGE_MIME_PATTERN.test(mimeType)) return null;
    const image = { buffer, mimeType };
    registry.set(hex, image);
    registryBytes += buffer.length;
    touch(hex, image);
    evictMemoryOverflow();
    const now = new Date();
    void utimes(paths.binary, now, now).catch(() => {});
    return image;
  } catch {
    return null;
  }
}
