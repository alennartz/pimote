import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { ServerCapabilitiesEvent } from '../../shared/dist/index.js';
import { normalizeTagSnippets, parseConfig, type PimoteConfig } from './config.js';
import { resolveFilePath, writeEditableFile } from './file-edit.js';

export interface ConfigRuntimeOptions {
  configPath: string;
  config: PimoteConfig;
  /** Optional authority for the active voice transport. */
  voiceAvailable?: boolean | (() => boolean);
}

function cloneConfig(config: PimoteConfig): PimoteConfig {
  return {
    ...config,
    roots: [...config.roots],
    voice: config.voice ? { ...config.voice } : undefined,
    tagSnippets: normalizeTagSnippets(config.tagSnippets),
    settingsFiles: config.settingsFiles ? [...config.settingsFiles] : undefined,
  };
}

function hasVoiceTransport(config: PimoteConfig): boolean {
  return Boolean(config.voice?.speechmuxSignalUrl && config.voice?.speechmuxLlmWsUrl);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissingFileError(error)) return path;
    throw error;
  }
}

/** Native configuration validation and effective runtime state. */
export class ConfigRuntime {
  private readonly configPath: string;
  private readonly startupConfig: PimoteConfig;
  private effectiveConfig: PimoteConfig;
  private readonly voiceAvailability: () => boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ConfigRuntimeOptions) {
    this.configPath = resolveFilePath(options.configPath, homedir());
    this.startupConfig = cloneConfig(options.config);
    this.effectiveConfig = cloneConfig(options.config);

    if (typeof options.voiceAvailable === 'function') {
      this.voiceAvailability = options.voiceAvailable;
    } else {
      const voiceAvailable = options.voiceAvailable ?? hasVoiceTransport(options.config);
      this.voiceAvailability = () => voiceAvailable;
    }
  }

  async isNativeConfig(path: string): Promise<boolean> {
    const resolvedPath = resolveFilePath(path, homedir());
    if (resolvedPath === this.configPath) return true;

    const [candidateIdentity, nativeIdentity] = await Promise.all([canonicalPath(resolvedPath), canonicalPath(this.configPath)]);
    return candidateIdentity === nativeIdentity;
  }

  validate(content: string): PimoteConfig {
    return parseConfig(content, this.configPath, homedir());
  }

  apply(candidate: PimoteConfig): PimoteConfig {
    const next = cloneConfig(this.startupConfig);

    next.settingsFiles = candidate.settingsFiles ? [...candidate.settingsFiles] : undefined;
    next.tagSnippets = normalizeTagSnippets(candidate.tagSnippets);
    next.defaultTheme = candidate.defaultTheme ?? 'pimote/light';
    next.defaultInterpreterModel = candidate.defaultInterpreterModel;
    next.defaultWorkerModel = candidate.defaultWorkerModel;
    next.idleTimeout = candidate.idleTimeout;
    next.bufferSize = candidate.bufferSize;

    this.effectiveConfig = next;
    return cloneConfig(this.effectiveConfig);
  }

  snapshot(): PimoteConfig {
    return cloneConfig(this.effectiveConfig);
  }

  capabilities(): ServerCapabilitiesEvent {
    return {
      type: 'server_capabilities',
      voice: this.voiceAvailability(),
      tagSnippets: this.effectiveConfig.tagSnippets ? [...this.effectiveConfig.tagSnippets] : [],
    };
  }

  /** Validate before writing, then apply safe fields. Ordinary files retain generic writes. */
  putFile(path: string, content: string): Promise<{ path: string }> {
    const operation = this.writeQueue.then(async () => {
      if (await this.isNativeConfig(path)) {
        const candidate = this.validate(content);
        const result = await writeEditableFile(path, content);
        this.apply(candidate);
        return result;
      }

      return writeEditableFile(path, content);
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
