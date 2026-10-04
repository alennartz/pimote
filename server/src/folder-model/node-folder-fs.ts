import { promises as fsp } from 'node:fs';
import type { FolderFs } from './index.js';

/** Default FolderFs backed by node's fs/promises. Reads are UTF-8. */
export const nodeFolderFs: FolderFs = {
  readdir: (path) => fsp.readdir(path, { withFileTypes: true }),
  lstat: (path) => fsp.lstat(path),
  realpath: (path) => fsp.realpath(path),
  readFile: (path) => fsp.readFile(path, 'utf8'),
};
