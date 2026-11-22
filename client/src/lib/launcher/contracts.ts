import type { FolderInfo, LauncherSearchScope, LauncherSessionHit, SearchLauncherResponseData } from '@pimote/shared';

export type LauncherCategory = 'all' | 'folders' | 'sessions' | 'commands';
export type LauncherPrefix = '>' | '@' | '#';

export interface ParsedLauncherQuery {
  readonly raw: string;
  readonly category: LauncherCategory;
  readonly prefix: LauncherPrefix | null;
  readonly term: string;
}

export interface LauncherCommand {
  readonly id: string;
  readonly label: string;
  readonly keywords?: readonly string[];
  readonly shortcut?: string;
  readonly group: 'navigation' | 'session' | 'app';
  readonly isAvailable?: () => boolean;
  run(): void | Promise<void>;
}

export interface LauncherSearchTransport {
  search(params: { query: string; scope: LauncherSearchScope; limit: number; includeArchived?: boolean }): Promise<SearchLauncherResponseData>;
}

export interface LauncherSnapshot {
  readonly query: ParsedLauncherQuery;
  readonly loading: boolean;
  readonly error: string | null;
  readonly folders: readonly FolderInfo[];
  readonly sessions: readonly LauncherSessionHit[];
  readonly commands: readonly LauncherCommand[];
}

export interface CreateLauncherSearchOptions {
  readonly transport: LauncherSearchTransport;
  readonly getCommands: () => readonly LauncherCommand[];
  readonly debounceMs?: number;
  readonly limit?: number;
  readonly onChange?: (snapshot: LauncherSnapshot) => void;
}

export interface LauncherSearchController {
  readonly snapshot: LauncherSnapshot;
  open(): void;
  setQuery(raw: string): void;
  reset(): void;
  dispose(): void;
}

export interface GlobalLauncherActions {
  startSessionInFolder(folderPath: string): void | Promise<void>;
  openSession(hit: LauncherSessionHit): void | Promise<void>;
}

export interface GlobalLauncherProps {
  transport?: LauncherSearchTransport;
  getCommands?: () => readonly LauncherCommand[];
  actions?: GlobalLauncherActions;
  debounceMs?: number;
}
