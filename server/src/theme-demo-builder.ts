import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { ResolvedTheme, ThemeDefinition, ThemeDiagnostic } from '../../shared/dist/index.js';
import { SYNTAX_SCOPES } from '../../shared/dist/index.js';
import { builtinThemeDefinitions } from './builtin-themes.js';
import { resolveFilePath } from './file-edit.js';
import { auditThemes } from './theme-audit.js';
import { parseThemeFile, resolveThemeDefinitions, type ThemeCatalogReader } from './theme-catalog.js';
import type { ManagerThemeDemoBundle } from './manager/types.js';

const DEFAULT_TEMPLATE_PATH = fileURLToPath(new URL('../../tools/theme-demo/index.html', import.meta.url));
export const MAX_THEME_FILE_BYTES = 4 * 1024 * 1024;

type ThemeSourceEntry = { definition: ThemeDefinition; source: 'builtin' | 'extension' | 'user'; path: string };

export interface ThemeDemoBuilderOptions {
  outputRoot: string;
  builtinThemes?: readonly ThemeDefinition[];
  extensionFiles?: readonly string[] | (() => readonly string[]);
  reader?: ThemeCatalogReader;
  templatePath?: string;
}

interface ThemeDemoPayload {
  themes: ResolvedTheme[];
  palettes: Record<string, Record<string, string>>;
  audit: ReturnType<typeof auditThemes>;
  mappingFindings: [];
  syntaxScopes: readonly string[];
  snippets: Record<string, string>;
}

/** Read one bounded, regular, non-symlink UTF-8 theme file. */
export async function readThemeFile(path: string): Promise<string> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    throw new Error(`failed to inspect theme file ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let initial;
  try {
    initial = await lstat(canonicalPath);
  } catch (error) {
    throw new Error(`failed to inspect theme file ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!initial.isFile()) throw new Error(`theme file is not a regular file: ${path}`);

  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`theme file is not a regular file: ${path}`);
    if (info.size > MAX_THEME_FILE_BYTES) throw new Error(`theme file exceeds ${MAX_THEME_FILE_BYTES} bytes: ${path}`);
    const bytes = Buffer.allocUnsafe(MAX_THEME_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_THEME_FILE_BYTES) throw new Error(`theme file exceeds ${MAX_THEME_FILE_BYTES} bytes: ${path}`);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    } catch (error) {
      throw new Error(`theme file is not valid UTF-8: ${path}`, { cause: error });
    }
  } finally {
    await handle.close();
  }
}

function defaultReader(): ThemeCatalogReader {
  return { read: readThemeFile };
}

function bundleDirectory(outputRoot: string, sourcePath: string): string {
  const key = createHash('sha256').update(sourcePath).digest('hex').slice(0, 24);
  return join(outputRoot, key);
}

function diagnosticWithSource(diagnostic: ThemeDiagnostic, source: 'extension' | 'user'): ThemeDiagnostic {
  return { ...diagnostic, source: diagnostic.source ?? source };
}

async function isSafeDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function isSafeFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureSafeDirectory(path: string): Promise<boolean> {
  const existed = await isSafeDirectory(path);
  if (!existed) {
    await mkdir(path, { recursive: true });
    const created = await lstat(path);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`generated theme bundle is not a safe directory: ${path}`);
  }
  return existed;
}

async function writeGeneratedFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`generated theme bundle target is not a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readBaseEntries(
  paths: readonly string[],
  reader: ThemeCatalogReader,
  overriddenIds: ReadonlySet<string>,
  diagnostics: ThemeDiagnostic[],
): Promise<ThemeSourceEntry[]> {
  const entries: ThemeSourceEntry[] = [];
  for (const path of paths) {
    let raw: string;
    try {
      raw = await reader.read(path);
    } catch (error) {
      diagnostics.push({ path, source: 'extension', message: `failed to read theme file: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const parsed = parseThemeFile(raw, path);
    diagnostics.push(...parsed.diagnostics.map((diagnostic) => diagnosticWithSource(diagnostic, 'extension')));
    for (const definition of parsed.definitions) {
      if (!overriddenIds.has(definition.id)) entries.push({ definition, source: 'extension', path });
    }
  }
  return entries;
}

/** Build a static theme-demo bundle from one draft theme file. */
export class ThemeDemoBuilder {
  private readonly builtinThemes: readonly ThemeDefinition[];
  private readonly extensionFiles: () => readonly string[];
  private readonly reader: ThemeCatalogReader;
  private readonly templatePath: string;
  private readonly preparations = new Map<string, Promise<ManagerThemeDemoBundle>>();

  constructor(private readonly options: ThemeDemoBuilderOptions) {
    this.builtinThemes = options.builtinThemes ?? builtinThemeDefinitions();
    const extensionFiles = options.extensionFiles;
    this.extensionFiles = typeof extensionFiles === 'function' ? extensionFiles : () => [...(extensionFiles ?? [])];
    this.reader = options.reader ?? defaultReader();
    this.templatePath = options.templatePath ?? DEFAULT_TEMPLATE_PATH;
  }

  async prepare(themeFile: string, signal?: AbortSignal): Promise<ManagerThemeDemoBundle> {
    if (!themeFile.startsWith('~') && !isAbsolute(themeFile)) throw new Error('theme file path must be absolute or start with ~');
    const sourcePath = resolveFilePath(themeFile, homedir());
    signal?.throwIfAborted();
    const existing = this.preparations.get(sourcePath);
    if (existing) return existing;
    const operation = this.prepareSource(sourcePath, signal);
    this.preparations.set(sourcePath, operation);
    try {
      return await operation;
    } finally {
      if (this.preparations.get(sourcePath) === operation) this.preparations.delete(sourcePath);
    }
  }

  private async prepareSource(sourcePath: string, signal?: AbortSignal): Promise<ManagerThemeDemoBundle> {
    const raw = await this.reader.read(sourcePath);
    signal?.throwIfAborted();
    const parsed = parseThemeFile(raw, sourcePath);
    const diagnostics: ThemeDiagnostic[] = parsed.diagnostics.map((diagnostic) => diagnosticWithSource(diagnostic, 'user'));
    const draftIds = new Set(parsed.definitions.map((definition) => definition.id));
    const folderPath = bundleDirectory(this.options.outputRoot, sourcePath);
    const emptyResult: ManagerThemeDemoBundle = {
      folderPath,
      title: `Theme demo: ${basename(sourcePath)}`,
      themeIds: [],
      diagnostics,
    };
    if (!parsed.valid || parsed.definitions.length === 0) return emptyResult;
    const entries: ThemeSourceEntry[] = this.builtinThemes.map((definition) => ({ definition, source: 'builtin', path: '<builtin>' }));
    entries.push(...(await readBaseEntries(this.extensionFiles(), this.reader, draftIds, diagnostics)));
    entries.push(...parsed.definitions.map((definition) => ({ definition, source: 'user' as const, path: sourcePath })));

    signal?.throwIfAborted();
    const resolution = resolveThemeDefinitions(entries);
    diagnostics.push(...resolution.diagnostics);
    const themes = resolution.themes.filter((theme) => theme.source === 'user' && draftIds.has(theme.id));
    const result: ManagerThemeDemoBundle = {
      folderPath,
      title: `Theme demo: ${basename(sourcePath)}`,
      themeIds: themes.map((theme) => theme.id),
      diagnostics,
    };
    if (themes.length === 0) return result;

    const palettes = Object.fromEntries(parsed.definitions.map((definition) => [definition.id, { ...(definition.palette ?? {}) }]));
    const payload: ThemeDemoPayload = {
      themes,
      palettes,
      audit: auditThemes(themes),
      mappingFindings: [],
      syntaxScopes: SYNTAX_SCOPES,
      snippets: {},
    };
    const existed = await ensureSafeDirectory(folderPath);
    try {
      const indexPath = join(folderPath, 'index.html');
      if (!(await isSafeFile(indexPath))) await writeGeneratedFile(indexPath, await readFile(this.templatePath, 'utf8'));
      signal?.throwIfAborted();
      await writeGeneratedFile(join(folderPath, 'themes.json'), `${JSON.stringify(payload)}\n`);
    } catch (error) {
      if (!existed) await rm(folderPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return result;
  }
}
