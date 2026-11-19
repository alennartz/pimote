import type { ThemeCatalogSnapshot, ThemeDefinition } from '../../shared/dist/index.js';

/** Read boundary used by the catalog for extension and user JSON files. */
export interface ThemeCatalogReader {
  read(path: string): Promise<string>;
}

/** Inputs owned by the host that builds one server theme catalog. */
export interface ThemeCatalogOptions {
  /** Built-ins in their fixed source order. */
  builtinThemes: readonly ThemeDefinition[];
  /** Extension registrations in deterministic host discovery order. */
  extensionFiles: readonly string[];
  /** Host-level user catalog path. */
  userFile: string;
  /** Native default theme ID. */
  defaultThemeId: string;
  /** File reader seam; watching is supplied by the host lifecycle. */
  reader: ThemeCatalogReader;
}

export type ThemeCatalogListener = (snapshot: ThemeCatalogSnapshot) => void;

/** Server boundary for built-in, extension, and user theme sources. */
export class ThemeCatalog {
  constructor(private readonly options: ThemeCatalogOptions) {}

  /** Load the initial catalog and return its revisioned snapshot. */
  async load(): Promise<ThemeCatalogSnapshot> {
    throw new Error('not implemented');
  }

  /** Re-read sources and publish a changed snapshot when valid input changes. */
  async reload(): Promise<ThemeCatalogSnapshot> {
    throw new Error('not implemented');
  }

  /** Current snapshot after a successful load or reload. */
  snapshot(): ThemeCatalogSnapshot {
    throw new Error('not implemented');
  }

  /** Subscribe to catalog revisions. Returns an unsubscribe operation. */
  onChange(_listener: ThemeCatalogListener): () => void {
    throw new Error('not implemented');
  }

  /** Apply a live native default and publish its revision. */
  async setDefaultTheme(_defaultThemeId: string): Promise<ThemeCatalogSnapshot> {
    throw new Error('not implemented');
  }

  /** Stop file watchers owned by the catalog. */
  async close(): Promise<void> {
    throw new Error('not implemented');
  }
}
