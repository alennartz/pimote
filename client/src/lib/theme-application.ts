import type { ResolvedTheme } from '@pimote/shared';

/** DOM boundary used when applying one resolved theme to a PWA document. */
export interface ThemeApplicationTarget {
  root: HTMLElement;
  themeColorMeta?: HTMLMetaElement | null;
}

/** Apply UI, editor, terminal, root-mode, and browser metadata for a theme. */
export function applyResolvedTheme(_theme: ResolvedTheme, _target: ThemeApplicationTarget): void {
  throw new Error('not implemented');
}
