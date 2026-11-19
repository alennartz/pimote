import type { PimoteCommand, PimoteEvent, PimoteResponse, ResolvedTheme, ThemeCatalogChangedEvent, ThemeCatalogSnapshot, UserSessionsChangedEvent } from '@pimote/shared';

export type ThemeStoreSend = (command: PimoteCommand) => Promise<PimoteResponse>;
export type ThemeStoreEventListener = (listener: (event: PimoteEvent) => void) => () => void;

export interface ThemeStoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeStoreOptions {
  user: string;
  send: ThemeStoreSend;
  onEvent?: ThemeStoreEventListener;
  storage: ThemeStoreStorage;
  apply(theme: ResolvedTheme): void;
}

/** Client-side catalog, preview, save, cancel, and user-scoped cache boundary. */
export class ThemeStore {
  catalog: ThemeCatalogSnapshot | null = null;
  selectedThemeId: string | null = null;
  previewThemeId: string | null = null;
  profileReconciled = false;
  sessionAdoptionComplete = false;

  constructor(private readonly options: ThemeStoreOptions) {}

  /** Request and retain the full PWA theme catalog. */
  async loadCatalog(): Promise<ThemeCatalogSnapshot> {
    throw new Error('not implemented');
  }

  /** Refresh after a revision-only catalog change event. */
  async handleCatalogChanged(_event: ThemeCatalogChangedEvent): Promise<void> {
    throw new Error('not implemented');
  }

  /** Reconcile the shared user selection from the profile event. */
  handleProfile(_event: UserSessionsChangedEvent): void {
    throw new Error('not implemented');
  }

  /** Select a theme or Follow server default for local preview. */
  preview(_themeId: string | null): void {
    throw new Error('not implemented');
  }

  /** Restore the saved selection and active palette. */
  cancel(): void {
    throw new Error('not implemented');
  }

  /** Persist the preview for every device using this user. */
  async save(): Promise<void> {
    throw new Error('not implemented');
  }

  /** Save stays disabled until profile reconciliation and adoption complete. */
  get saveDisabled(): boolean {
    throw new Error('not implemented');
  }

  /** Resolve the currently previewed or saved theme against the catalog. */
  get activeTheme(): ResolvedTheme | null {
    throw new Error('not implemented');
  }

  /** Expose the cache key used by the PWA and static reports. */
  cacheKey(): string {
    throw new Error('not implemented');
  }
}
