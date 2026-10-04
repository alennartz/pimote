import type { FileGetResponseData, PimoteCommand, PimoteResponse } from '@pimote/shared';
import { connection } from '$lib/stores/connection.svelte.js';
import { isValidTagName } from '$lib/tag-wrap.js';

/** Wire transport seam — the store talks to the server through this alone. */
export type SendCommand = (command: PimoteCommand) => Promise<PimoteResponse>;

export const AGENT_INSTRUCTIONS_PATH = '~/.pi/agent/AGENTS.md';
const PIMOTE_CONFIG_PATH = '~/.config/pimote/config.json';

/**
 * Pure. Lenient `tagSnippets` extraction from the pimote config file's text:
 * invalid JSON, a missing key, or a non-array key yields no snippets, and
 * non-string entries and invalid tag names are dropped.
 */
export function parseTagSnippets(configText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const snippets = (parsed as { tagSnippets?: unknown }).tagSnippets;
  if (!Array.isArray(snippets)) return [];
  return snippets.filter((entry): entry is string => typeof entry === 'string' && isValidTagName(entry));
}

/**
 * State and operations for the config-file editor dialog (first citizen:
 * `~/.pi/agent/AGENTS.md`). File reads/writes are last-write-wins `file_get` /
 * `file_put` round trips; `close()` is unconditional — the unsaved-changes
 * confirmation is the dialog's concern.
 */
export class FileEditorStore {
  open = $state(false);
  loading = $state(false);
  saving = $state(false);
  exists = $state(false);
  path = $state<string | null>(null);
  resolvedPath = $state<string | null>(null);
  title = $state('');
  content = $state('');
  error = $state<string | null>(null);
  snippets = $state<string[]>([]);

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
    this.open = true;
    this.loading = true;
    this.saving = false;
    this.exists = false;
    this.path = path;
    this.resolvedPath = null;
    this.title = title;
    this.content = '';
    this.baseline = '';
    this.error = null;
    this.snippets = [];
    void this.loadSnippets(generation);
    await this.loadFile(path, generation);
  }

  /** Saves the full content via file_put and closes on success. Returns whether it saved. */
  async save(): Promise<boolean> {
    const path = this.path;
    if (!this.open || this.saving || path === null) return false;
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
    this.open = false;
    this.loading = false;
    this.saving = false;
    this.exists = false;
    this.path = null;
    this.resolvedPath = null;
    this.title = '';
    this.content = '';
    this.baseline = '';
    this.error = null;
    this.snippets = [];
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
    } catch (cause) {
      if (generation !== this.generation) return;
      this.error = cause instanceof Error ? cause.message : 'Failed to read file';
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  /** Fire-and-forget snippet palette load; any failure means simply no snippet buttons. */
  private async loadSnippets(generation: number): Promise<void> {
    try {
      const response = await this.send({ type: 'file_get', path: PIMOTE_CONFIG_PATH });
      if (!response.success || generation !== this.generation) return;
      const data = response.data as FileGetResponseData;
      if (!data.exists) return;
      this.snippets = parseTagSnippets(data.content);
    } catch {
      // Lenient by design: snippet problems never block the editor.
    }
  }
}

export const fileEditorStore = new FileEditorStore((command) => connection.send(command));
