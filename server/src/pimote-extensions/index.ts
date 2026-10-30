import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createJiti } from 'jiti';
import type { PimoteExtensionContext } from '@pimote/sdk/pimote';
import { sdkRuntimeAliases } from '../folder-sources/loader.js';
import type {
  PimoteConfiguredPackage,
  PimoteExtensionHost,
  PimoteExtensionHostOptions,
  PimoteExtensionRegistry,
  PimoteExtensionDiagnostic,
  PimoteExtensionModule,
} from './types.js';

export type {
  PimoteConfiguredPackage,
  PimoteExtensionDiagnostic,
  PimoteExtensionHost,
  PimoteExtensionHostOptions,
  PimoteExtensionModule,
  PimoteExtensionRegistry,
  PimotePackageManager,
  PimotePackageScope,
} from './types.js';

const MODULE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

type Manifest = { main?: string; pimote?: { extensions?: string[] } };

async function readManifest(directory: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function directoryEntry(directory: string): Promise<string | undefined> {
  const manifest = await readManifest(directory);
  if (typeof manifest?.main === 'string') return resolve(directory, manifest.main);
  for (const name of ['index.ts', 'index.js', 'index.mjs', 'index.cjs', 'index.mts', 'index.cts']) {
    try {
      if ((await stat(join(directory, name))).isFile()) return join(directory, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

async function discoverEntries(options: PimoteExtensionHostOptions, diagnostics: PimoteExtensionDiagnostic[]): Promise<string[]> {
  const paths: string[] = [];
  try {
    const entries = await readdir(options.extensionDirectory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = resolve(options.extensionDirectory, entry.name);
      try {
        if (entry.isFile() && MODULE_EXTENSIONS.has(extname(entry.name))) paths.push(path);
        else if (entry.isDirectory()) {
          const module = await directoryEntry(path);
          if (module) paths.push(module);
        }
      } catch (error) {
        diagnostics.push({ path, message: String(error) });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push({ path: options.extensionDirectory, message: String(error) });
  }
  if (options.packageManager) {
    let configuredPackages: readonly PimoteConfiguredPackage[] = [];
    try {
      configuredPackages = options.packageManager.listConfiguredPackages();
    } catch (error) {
      diagnostics.push({ path: '<package-manager>', message: String(error) });
    }
    for (const pkg of configuredPackages) {
      if (pkg.scope !== 'user') continue;
      let root: string | undefined;
      try {
        root = options.packageManager.getInstalledPath(pkg.source, pkg.scope);
      } catch (error) {
        diagnostics.push({ path: pkg.source, message: String(error) });
        continue;
      }
      if (!root) continue;
      try {
        const manifest = await readManifest(root);
        const entries = manifest?.pimote?.extensions;
        if (entries === undefined) continue;
        if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) throw new Error('pimote.extensions must be a string array');
        for (const entry of entries) paths.push(resolve(root, entry));
      } catch (error) {
        diagnostics.push({ path: join(root, 'package.json'), message: String(error) });
      }
    }
  }
  return [...new Set(paths)];
}

type ShutdownRegistration = {
  path: string;
  handler: () => void | Promise<void>;
  active: boolean;
  owner: Runtime;
};

class Runtime {
  readonly sources: PimoteExtensionRegistry['sources'][number][] = [];
  readonly settingsFiles: string[] = [];
  readonly diagnostics: PimoteExtensionDiagnostic[] = [];
  readonly handlers: ShutdownRegistration[] = [];
  active = true;

  context(path: string): PimoteExtensionContext {
    return {
      folders: {
        registerSource: (source) => {
          if (!this.active) return;
          if (
            !source ||
            typeof source.id !== 'string' ||
            !source.id.trim() ||
            typeof source.list !== 'function' ||
            (source.onFolderOpen !== undefined && typeof source.onFolderOpen !== 'function')
          )
            throw new Error('Invalid folder source');
          this.sources.push(source);
        },
      },
      settings: {
        registerFile: (file) => {
          if (!this.active) return;
          if (typeof file !== 'string' || !file.trim()) throw new Error('Invalid settings file path');
          const expanded = file === '~' ? homedir() : file.startsWith('~/') ? join(homedir(), file.slice(2)) : file;
          this.settingsFiles.push(resolve(dirname(path), expanded));
        },
      },
      on: (event, handler) => {
        if (!this.active) return () => {};
        if (event !== 'shutdown' || typeof handler !== 'function') throw new Error('Invalid shutdown handler');
        const registration: ShutdownRegistration = { path, handler, active: true, owner: this };
        this.handlers.push(registration);
        return () => {
          registration.active = false;
          registration.owner.removeHandler(registration);
        };
      },
    };
  }

  /** Publish one successfully initialized entry into this runtime. */
  commit(entry: Runtime): void {
    if (!this.active || !entry.active) return;
    this.sources.push(...entry.sources);
    this.settingsFiles.push(...entry.settingsFiles);
    for (const registration of entry.handlers) {
      registration.owner = this;
      this.handlers.push(registration);
    }
    entry.handlers.length = 0;
    entry.active = false;
  }

  /** Seal a staged entry after a failed factory or a completed commit. */
  seal(): void {
    this.active = false;
  }

  private removeHandler(registration: ShutdownRegistration): void {
    const index = this.handlers.indexOf(registration);
    if (index >= 0) this.handlers.splice(index, 1);
  }

  snapshot(): PimoteExtensionRegistry {
    return { sources: [...this.sources], settingsFiles: [...this.settingsFiles], diagnostics: this.diagnostics.map((diagnostic) => ({ ...diagnostic })) };
  }

  async stop(): Promise<readonly PimoteExtensionDiagnostic[]> {
    this.active = false;
    const shutdownDiagnostics: PimoteExtensionDiagnostic[] = [];
    for (const registration of [...this.handlers]) {
      if (!registration.active) continue;
      registration.active = false;
      try {
        await registration.handler();
      } catch (error) {
        const diagnostic = { path: registration.path, message: String(error) };
        this.diagnostics.push(diagnostic);
        shutdownDiagnostics.push(diagnostic);
      }
    }
    this.handlers.length = 0;
    return shutdownDiagnostics;
  }
}

class ExtensionHost implements PimoteExtensionHost {
  private runtime: Runtime | undefined;
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PimoteExtensionHostOptions) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => undefined);
    return result;
  }

  start(): Promise<PimoteExtensionRegistry> {
    return this.serialize(() => (this.runtime ? Promise.resolve(this.runtime.snapshot()) : this.replaceRuntime()));
  }

  reload(): Promise<PimoteExtensionRegistry> {
    return this.serialize(() => this.replaceRuntime());
  }

  getRegistry(): PimoteExtensionRegistry {
    return this.runtime?.snapshot() ?? { sources: [], settingsFiles: [], diagnostics: [] };
  }

  shutdown(): Promise<void> {
    return this.serialize(async () => {
      const diagnostics = (await this.runtime?.stop()) ?? [];
      for (const diagnostic of diagnostics) {
        console.warn(`[pimote-extensions] ${diagnostic.path}: ${diagnostic.message}`);
      }
      this.runtime = undefined;
    });
  }

  private async replaceRuntime(): Promise<PimoteExtensionRegistry> {
    const shutdownDiagnostics = (await this.runtime?.stop()) ?? [];
    const runtime = new Runtime();
    runtime.diagnostics.push(...shutdownDiagnostics);
    try {
      const entries = await discoverEntries(this.options, runtime.diagnostics);
      const jiti = createJiti(import.meta.url, {
        moduleCache: false,
        fsCache: false,
        tryNative: false,
        alias: sdkRuntimeAliases(['@pimote/sdk/pimote']),
      });
      for (const path of entries) {
        const entryRuntime = new Runtime();
        try {
          const module = (await jiti.evalModule(await readFile(path, 'utf8'), { filename: path, async: true, forceTranspile: true })) as PimoteExtensionModule;
          if (typeof module.default !== 'function') throw new Error('Pimote extension must export a default factory');
          await module.default(entryRuntime.context(path));
          runtime.commit(entryRuntime);
        } catch (error) {
          const cleanupDiagnostics = await entryRuntime.stop();
          entryRuntime.seal();
          runtime.diagnostics.push(...cleanupDiagnostics);
          runtime.diagnostics.push({ path, message: String(error) });
        }
      }
    } catch (error) {
      runtime.diagnostics.push({ path: this.options.extensionDirectory, message: String(error) });
    }
    this.runtime = runtime;
    return runtime.snapshot();
  }
}

export function createPimoteExtensionHost(options: PimoteExtensionHostOptions): PimoteExtensionHost {
  return new ExtensionHost(options);
}
