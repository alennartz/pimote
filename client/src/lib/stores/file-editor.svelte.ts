import type { FileGetResponseData, PimoteCommand, PimoteResponse } from '@pimote/shared';
import { connection } from '$lib/stores/connection.svelte.js';

/** Wire transport seam — the store talks to the server through this alone. */
export type SendCommand = (command: PimoteCommand) => Promise<PimoteResponse>;

/**
 * State and operations for the config-file editor dialog (first citizen:
 * `~/.pi/agent/AGENTS.md`). File reads/writes are last-write-wins `file_get` /
 * `file_put` round trips; `close()` is unconditional — the unsaved-changes
 * confirmation is the dialog's concern.
 */
export class FileEditorStore {
  open = $state(false);
  loading = $state(false);
  /** True only after a completed successful load; saves are refused until then. */
  loaded = $state(false);
  saving = $state(false);
  exists = $state(false);
  path = $state<string | null>(null);
  resolvedPath = $state<string | null>(null);
  title = $state('');
  content = $state('');
  error = $state<string | null>(null);

  /** Baseline of the last loaded/saved content; `dirty` means unsaved edits. */
  private baseline = $state('');
  /** Bumped on every open so a stale file_get response can't poison the dialog. */
  private generation = 0;

  constructor(private readonly send: SendCommand) {}

  get dirty(): boolean {
    return this.content !== this.baseline;
  }

  /** Opens the dialog on `path` and loads the file. A missing file opens empty (will-create). */
  async openFile(path: string, title: string): Promise<void> {
    const generation = ++this.generation;
    this.resetFileState();
    this.open = true;
    this.loading = true;
    this.path = path;
    this.title = title;
    await this.loadFile(path, generation);
  }

  /** Opens the instructions file belonging to this folder, never a relative server-cwd target. */
  async openFolderInstructions(folderPath: string, folderName?: string): Promise<void> {
    if (!folderPath) return;
    const path = `${folderPath.replace(/\/+$/, '')}/AGENTS.md`;
    const name = folderName ?? folderPath.split('/').filter(Boolean).at(-1) ?? folderPath;
    await this.openFile(path, `AGENTS.md — ${name}`);
  }

  /** Saves the full content via file_put and closes on success. Returns whether it saved. */
  async save(): Promise<boolean> {
    const path = this.path;
    // `loaded` is the truncation guard: after a failed or unfinished load
    // `content` is '' and saving would empty an existing file.
    if (!this.open || this.saving || !this.loaded || path === null) return false;
    this.saving = true;
    this.error = null;
    const content = this.content;
    try {
      const response = await this.send({ type: 'file_put', path, content });
      if (!response.success) {
        this.error = response.error ?? 'Failed to save';
        return false;
      }
      this.baseline = content;
      this.close();
      return true;
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : 'Failed to save';
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** Closes the dialog and resets all per-file state. */
  close(): void {
    this.generation += 1;
    this.resetFileState();
    this.open = false;
  }

  /** Per-file dialog state, shared by openFile and close so the two can't drift. */
  private resetFileState(): void {
    this.loading = false;
    this.saving = false;
    this.loaded = false;
    this.exists = false;
    this.path = null;
    this.resolvedPath = null;
    this.title = '';
    this.content = '';
    this.baseline = '';
    this.error = null;
  }

  private async loadFile(path: string, generation: number): Promise<void> {
    try {
      const response = await this.send({ type: 'file_get', path });
      if (generation !== this.generation) return;
      if (!response.success) {
        this.error = response.error ?? 'Failed to read file';
        return;
      }
      const data = response.data as FileGetResponseData;
      this.exists = data.exists;
      this.content = data.content;
      this.baseline = data.content;
      this.resolvedPath = data.path;
      this.loaded = true;
    } catch (cause) {
      if (generation !== this.generation) return;
      this.error = cause instanceof Error ? cause.message : 'Failed to read file';
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
}

export const fileEditorStore = new FileEditorStore((command) => connection.send(command));
