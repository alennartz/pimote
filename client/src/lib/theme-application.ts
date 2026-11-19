import type { ResolvedTheme } from '@pimote/shared';
import { setActiveTheme } from './theme-runtime.svelte.js';

/** DOM boundary used when applying one resolved theme to a PWA document. */
export interface ThemeApplicationTarget {
  root: HTMLElement;
  themeColorMeta?: HTMLMetaElement | null;
}

function writeSlots(root: HTMLElement, prefix: string, values: Record<string, string>): void {
  for (const [role, value] of Object.entries(values)) root.style.setProperty(`${prefix}-${role}`, value);
}

/** Apply UI, editor, terminal, root-mode, and browser metadata for a theme. */
export function applyResolvedTheme(theme: ResolvedTheme, target: ThemeApplicationTarget): void {
  writeSlots(target.root, '--pimote-ui', theme.ui);
  writeSlots(target.root, '--pimote-editor', theme.editor.surface);
  writeSlots(target.root, '--pimote-editor', theme.editor.syntax);
  writeSlots(target.root, '--pimote-terminal', theme.editor.terminal);
  target.root.classList.toggle('dark', theme.colorScheme === 'dark');
  target.root.style.setProperty('color-scheme', theme.colorScheme);
  const themeColorMeta = target.themeColorMeta ?? target.root.ownerDocument?.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.content = theme.ui.background;
  setActiveTheme(theme);
}
