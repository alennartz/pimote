import type { ServerCapabilitiesEvent } from '../../shared/dist/index.js';
import type { PimoteConfig } from './config.js';

export interface ConfigRuntimeOptions {
  configPath: string;
  config: PimoteConfig;
}

/** Native configuration validation and effective runtime state. */
export class ConfigRuntime {
  constructor(_options: ConfigRuntimeOptions) {}

  async isNativeConfig(_path: string): Promise<boolean> {
    throw new Error('not implemented');
  }

  validate(_content: string): PimoteConfig {
    throw new Error('not implemented');
  }

  apply(_candidate: PimoteConfig): PimoteConfig {
    throw new Error('not implemented');
  }

  snapshot(): PimoteConfig {
    throw new Error('not implemented');
  }

  capabilities(): ServerCapabilitiesEvent {
    throw new Error('not implemented');
  }

  /** Validate before writing, then apply safe fields. Ordinary files retain generic writes. */
  async putFile(_path: string, _content: string): Promise<{ path: string }> {
    throw new Error('not implemented');
  }
}
