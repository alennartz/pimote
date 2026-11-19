import { bootstrapCachedTheme } from './lib/theme-bootstrap.js';

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try {
    const storage = window.localStorage;
    const user = storage.getItem('pimote:user')?.trim() || 'default';
    bootstrapCachedTheme(user, storage, {
      root: document.documentElement,
      themeColorMeta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]'),
    });
  } catch {
    // Browser storage is optional. The CSS fallback remains active.
  }
}
