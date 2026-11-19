import type { PimoteCommand, PimoteEvent, PimoteResponse, ResolvedTheme, ThemeCatalogChangedEvent, ThemeCatalogSnapshot, UserSessionsChangedEvent } from '@pimote/shared';
import { themeCacheKey } from '../theme-bridge.js';

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
  catalog: ThemeCatalogSnapshot | null = $state(null);
  selectedThemeId: string | null = $state(null);
  previewThemeId: string | null = $state(null);
  profileReconciled = $state(false);
  sessionAdoptionComplete = $state(false);
  private previewing = false;
  private stopEvents: (() => void) | undefined;

  constructor(private readonly options: ThemeStoreOptions) {
    if (options.onEvent) {
      this.stopEvents = options.onEvent((event) => {
        if (event.type === 'theme_catalog_changed') void this.handleCatalogChanged(event as ThemeCatalogChangedEvent);
      });
    }
  }

  /** Request and retain the full PWA theme catalog. */
  async loadCatalog(): Promise<ThemeCatalogSnapshot> {
    const response = await this.options.send({ type: 'get_theme_catalog' });
    if (!response.success || !response.data) throw new Error(response.error ?? 'Failed to load theme catalog');
    const catalog = response.data as ThemeCatalogSnapshot;
    this.catalog = catalog;
    this.applyActive();
    return catalog;
  }

  /** Refresh after a revision-only catalog change event. */
  async handleCatalogChanged(event: ThemeCatalogChangedEvent): Promise<void> {
    if (this.catalog && event.revision <= this.catalog.revision) return;
    await this.loadCatalog();
  }

  /** Reconcile the shared user selection from the profile event. */
  handleProfile(event: UserSessionsChangedEvent): void {
    this.selectedThemeId = event.selectedThemeId ?? null;
    this.profileReconciled = true;
    this.applyActive();
  }

  /** Select a theme or Follow server default for local preview. */
  preview(themeId: string | null): void {
    if (themeId !== null && !this.catalog?.themes.some((theme) => theme.id === themeId)) return;
    this.previewThemeId = themeId;
    this.previewing = true;
    this.applyActive();
  }

  /** Restore the saved selection and active palette. */
  cancel(): void {
    this.previewing = false;
    this.previewThemeId = this.selectedThemeId;
    this.applyActive();
  }

  /** Persist the preview for every device using this user. */
  async save(): Promise<void> {
    if (this.saveDisabled || !this.previewing) return;
    const themeId = this.previewThemeId;
    const response = await this.options.send({ type: 'set_theme', themeId });
    if (!response.success) throw new Error(response.error ?? 'Failed to save theme');
    this.selectedThemeId = themeId;
    this.previewing = false;
    this.applyActive();
  }

  /** Reset connection-scoped facts before a reconnect or user switch. */
  resetConnection(): void {
    this.catalog = null;
    this.profileReconciled = false;
    this.sessionAdoptionComplete = false;
    this.previewing = false;
    this.previewThemeId = null;
  }

  /** Save stays disabled until profile reconciliation and adoption complete. */
  get saveDisabled(): boolean {
    return !this.profileReconciled || !this.sessionAdoptionComplete || !this.previewing;
  }

  /** Resolve the currently previewed or saved theme against the catalog. */
  get activeTheme(): ResolvedTheme | null {
    const themes = this.catalog?.themes ?? [];
    if (themes.length === 0) return null;
    const requested = this.previewing ? this.previewThemeId : this.selectedThemeId;
    return (
      (requested ? themes.find((theme) => theme.id === requested) : undefined) ??
      themes.find((theme) => theme.id === this.catalog?.defaultThemeId) ??
      themes.find((theme) => theme.id === 'pimote/light') ??
      themes[0] ??
      null
    );
  }

  /** Expose the cache key used by the PWA and static reports. */
  cacheKey(): string {
    return themeCacheKey(this.options.user);
  }

  private applyActive(): void {
    const theme = this.activeTheme;
    if (!theme) return;
    this.options.apply(theme);
    if (this.profileReconciled) {
      try {
        this.options.storage.setItem(this.cacheKey(), JSON.stringify(theme));
      } catch {
        // Storage is optional. The in-memory theme remains active.
      }
    }
  }

  dispose(): void {
    this.stopEvents?.();
    this.stopEvents = undefined;
  }
}
