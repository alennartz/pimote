import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const imageCache = mkdtempSync(join(tmpdir(), 'pimote-image-registry-test-'));
const previousCacheHome = process.env.XDG_CACHE_HOME;
process.env.XDG_CACHE_HOME = imageCache;
process.on('exit', () => {
  if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = previousCacheHome;
  rmSync(imageCache, { recursive: true, force: true });
});
