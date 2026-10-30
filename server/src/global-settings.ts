import type { GetGlobalSettingsResponseData } from '../../shared/dist/index.js';

export interface GlobalSettingsCatalogOptions {
  home: string;
  agentDir: string;
  configPath: string;
  settingsFiles?: readonly string[];
  /** Paths already resolved by the Pimote extension host. */
  extensionFiles?: readonly string[];
}

export class GlobalSettingsCatalog {
  constructor(_options: GlobalSettingsCatalogOptions) {}

  async snapshot(): Promise<GetGlobalSettingsResponseData> {
    throw new Error('not implemented');
  }
}
