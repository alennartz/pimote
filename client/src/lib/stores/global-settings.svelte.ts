import type { FileGetResponseData, GlobalSettingsFile, GetGlobalSettingsResponseData, PimoteCommand, PimoteResponse } from '@pimote/shared';
import { SvelteMap } from 'svelte/reactivity';
import { connection } from './connection.svelte.js';

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

function createDraft(file: GlobalSettingsFile): GlobalSettingsDraft {
  return {
    ...file,
    draft: '',
    exists: false,
    loaded: false,
    loading: false,
    saving: false,
    dirty: false,
    error: null,
  };
}

function responseError(response: PimoteResponse, fallback: string): string {
  return response.error ?? fallback;
}

/**
 * Client state for one global-settings dialog opening.
 *
 * The server manifest is a snapshot. File contents load lazily, and each tab
 * owns its draft and baseline so switching tabs never loses edits.
 */
export class GlobalSettingsStore {
  open = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  files = $state<GlobalSettingsDraft[]>([]);
  activePath = $state<string | null>(null);
  discardConfirmation = $state(false);

  private readonly send: GlobalSettingsTransport;
  private generation = 0;
  private baselines = new SvelteMap<string, string>();
  private editRevisions = new SvelteMap<string, number>();
  private fileLoads = new SvelteMap<string, Promise<void>>();
  private saveRevisions = new SvelteMap<string, number>();

  constructor(send: GlobalSettingsTransport) {
    this.send = send;
  }

  /** Open a fresh manifest snapshot. An open dialog never refreshes its tabs. */
  async loadManifest(): Promise<void> {
    if (this.open) return;

    const generation = ++this.generation;
    this.resetStateForOpening();
    this.open = true;
    this.loading = true;

    try {
      const response = await this.send({ type: 'get_global_settings' });
      if (generation !== this.generation) return;
      if (!response.success) {
        this.error = responseError(response, 'Failed to load settings files');
        return;
      }

      const data = response.data as GetGlobalSettingsResponseData | undefined;
      if (!data || !Array.isArray(data.files)) {
        this.error = 'Invalid settings manifest';
        return;
      }

      this.files = data.files.map(createDraft);
      if (this.files.length > 0) {
        await this.select(this.files[0].path);
      }
    } catch (cause) {
      if (generation !== this.generation) return;
      this.error = cause instanceof Error ? cause.message : 'Failed to load settings files';
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  /** Select a manifest tab and load its content on first selection. */
  async select(path: string): Promise<void> {
    if (!this.open) return;
    const entry = this.findFile(path);
    if (!entry) return;

    this.activePath = path;
    if (entry.loaded) return;

    const existing = this.fileLoads.get(path);
    if (existing) {
      await existing;
      return;
    }

    const generation = this.generation;
    const load = this.loadFile(entry, generation);
    this.fileLoads.set(path, load);
    try {
      await load;
    } finally {
      if (this.fileLoads.get(path) === load) this.fileLoads.delete(path);
    }
  }

  /** Update one tab's draft while retaining its independent baseline. */
  edit(path: string, draft: string): void {
    const entry = this.findFile(path);
    if (!entry) return;

    entry.draft = draft;
    this.editRevisions.set(path, (this.editRevisions.get(path) ?? 0) + 1);
    entry.dirty = draft !== (this.baselines.get(path) ?? '');
  }

  /** Save a complete loaded draft for one file. */
  async save(path: string): Promise<boolean> {
    const entry = this.findFile(path);
    if (!this.open || !entry || !entry.loaded || entry.saving) return false;

    const generation = this.generation;
    const saveRevision = (this.saveRevisions.get(path) ?? 0) + 1;
    this.saveRevisions.set(path, saveRevision);
    const submittedDraft = entry.draft;
    entry.saving = true;
    entry.error = null;

    try {
      const response = await this.send({ type: 'file_put', path, content: submittedDraft });
      if (generation !== this.generation || this.saveRevisions.get(path) !== saveRevision) return false;
      if (!response.success) {
        entry.error = responseError(response, 'Failed to save');
        return false;
      }

      this.baselines.set(path, submittedDraft);
      entry.exists = true;
      entry.dirty = entry.draft !== submittedDraft;
      entry.error = null;
      return true;
    } catch (cause) {
      if (generation !== this.generation || this.saveRevisions.get(path) !== saveRevision) return false;
      entry.error = cause instanceof Error ? cause.message : 'Failed to save';
      return false;
    } finally {
      if (generation === this.generation && this.saveRevisions.get(path) === saveRevision) {
        entry.saving = false;
      }
    }
  }

  hasDirtyDrafts(): boolean {
    return this.files.some((entry) => entry.dirty);
  }

  /** Close cleanly, or open the one discard-confirmation state when dirty. */
  close(): void {
    if (!this.open) return;
    if (this.hasDirtyDrafts()) {
      this.discardConfirmation = true;
      return;
    }
    this.resetOpening();
  }

  keepEditing(): void {
    this.discardConfirmation = false;
  }

  discardAndClose(): void {
    if (!this.open) {
      this.discardConfirmation = false;
      return;
    }
    this.resetOpening();
  }

  private findFile(path: string): GlobalSettingsDraft | undefined {
    return this.files.find((entry) => entry.path === path);
  }

  private async loadFile(entry: GlobalSettingsDraft, generation: number): Promise<void> {
    const path = entry.path;
    const editRevision = this.editRevisions.get(path) ?? 0;
    entry.loading = true;
    entry.error = null;

    try {
      const response = await this.send({ type: 'file_get', path });
      if (generation !== this.generation) return;
      if (!response.success) {
        entry.error = responseError(response, 'Failed to read file');
        return;
      }

      const data = response.data as FileGetResponseData | undefined;
      if (!data || typeof data.content !== 'string' || typeof data.exists !== 'boolean') {
        entry.error = 'Invalid file response';
        return;
      }

      const baseline = data.content;
      this.baselines.set(path, baseline);
      if ((this.editRevisions.get(path) ?? 0) === editRevision) {
        entry.draft = baseline;
      }
      entry.exists = data.exists;
      entry.loaded = true;
      entry.dirty = entry.draft !== baseline;
      entry.error = null;
    } catch (cause) {
      if (generation !== this.generation) return;
      entry.error = cause instanceof Error ? cause.message : 'Failed to read file';
    } finally {
      if (generation === this.generation) entry.loading = false;
    }
  }

  private resetStateForOpening(): void {
    this.files = [];
    this.activePath = null;
    this.error = null;
    this.loading = false;
    this.discardConfirmation = false;
    this.baselines.clear();
    this.editRevisions.clear();
    this.fileLoads.clear();
    this.saveRevisions.clear();
  }

  private resetOpening(): void {
    this.generation += 1;
    this.open = false;
    this.resetStateForOpening();
  }
}

export const globalSettingsStore = new GlobalSettingsStore((command) => connection.send(command));
