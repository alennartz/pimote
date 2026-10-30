import type { GlobalSettingsFile, PimoteCommand, PimoteResponse } from '@pimote/shared';

export type { GlobalSettingsFile } from '@pimote/shared';

export interface GlobalSettingsDraft extends GlobalSettingsFile {
  draft: string;
  exists: boolean;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
}

export type GlobalSettingsTransport = (command: PimoteCommand) => Promise<PimoteResponse>;

export class GlobalSettingsStore {
  open = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  files = $state<GlobalSettingsDraft[]>([]);
  activePath = $state<string | null>(null);
  discardConfirmation = $state(false);

  constructor(_send: GlobalSettingsTransport) {}

  async loadManifest(): Promise<void> {
    throw new Error('not implemented');
  }

  async select(_path: string): Promise<void> {
    throw new Error('not implemented');
  }

  edit(_path: string, _draft: string): void {
    throw new Error('not implemented');
  }

  async save(_path: string): Promise<boolean> {
    throw new Error('not implemented');
  }

  hasDirtyDrafts(): boolean {
    throw new Error('not implemented');
  }

  close(): void {
    throw new Error('not implemented');
  }

  keepEditing(): void {
    throw new Error('not implemented');
  }

  discardAndClose(): void {
    throw new Error('not implemented');
  }
}
