/* global document, localStorage, window */

(() => {
  const prefix = 'pimote:theme:';
  const key = (user) => prefix + encodeURIComponent(user || 'default');
  const maps = {
    ui: [
      'background',
      'foreground',
      'card',
      'card-foreground',
      'popover',
      'popover-foreground',
      'primary',
      'primary-foreground',
      'secondary',
      'secondary-foreground',
      'muted',
      'muted-foreground',
      'accent',
      'accent-foreground',
      'destructive',
      'warning',
      'warning-foreground',
      'border',
      'input',
      'ring',
      'chart-1',
      'chart-2',
      'chart-3',
      'chart-4',
      'chart-5',
      'sidebar',
      'sidebar-foreground',
      'sidebar-primary',
      'sidebar-primary-foreground',
      'sidebar-accent',
      'sidebar-accent-foreground',
      'sidebar-border',
      'sidebar-ring',
      'status-active',
      'status-streaming',
      'status-connected',
      'status-error',
      'status-reconnecting',
      'surface-sunken',
      'surface-raised',
      'surface-subtle',
      'surface-hover',
      'error-accent',
      'error-surface',
      'error-foreground',
      'error-avatar-fg',
      'skill-accent',
      'skill-surface',
      'skill-foreground',
      'skill-foreground-hover',
      'bash-accent',
      'custom-accent',
      'custom-surface',
      'custom-foreground',
      'custom-foreground-hover',
      'link',
      'link-hover',
      'avatar-bg',
      'avatar-fg',
      'shadow-color',
    ],
    surface: [
      'background',
      'foreground',
      'selection',
      'cursor',
      'active-line',
      'gutter-background',
      'gutter-foreground',
      'line-number',
      'active-line-number',
      'matching-bracket',
      'search-match',
    ],
    syntax: [
      'comment',
      'doc-comment',
      'name',
      'variable',
      'parameter',
      'type',
      'tag',
      'property',
      'attribute',
      'class',
      'label',
      'namespace',
      'macro',
      'constant',
      'function',
      'built-in',
      'keyword',
      'control-keyword',
      'definition-keyword',
      'modifier',
      'operator-keyword',
      'operator',
      'punctuation',
      'separator',
      'bracket',
      'string',
      'doc-string',
      'character',
      'attribute-value',
      'number',
      'boolean',
      'null',
      'regexp',
      'escape',
      'color',
      'url',
      'content',
      'heading',
      'content-separator',
      'list',
      'quote',
      'emphasis',
      'strong',
      'link',
      'monospace',
      'strikethrough',
      'inserted',
      'deleted',
      'changed',
      'invalid',
      'meta',
      'document-meta',
      'annotation',
      'processing-instruction',
    ],
    terminal: [
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'bright-black',
      'bright-red',
      'bright-green',
      'bright-yellow',
      'bright-blue',
      'bright-magenta',
      'bright-cyan',
      'bright-white',
    ],
  };
  const complete = (value, names) => value && typeof value === 'object' && names.every((name) => typeof value[name] === 'string' && value[name]);
  const valid = (theme) =>
    theme &&
    typeof theme.id === 'string' &&
    typeof theme.name === 'string' &&
    (theme.colorScheme === 'light' || theme.colorScheme === 'dark') &&
    complete(theme.ui, maps.ui) &&
    complete(theme.editor?.surface, maps.surface) &&
    complete(theme.editor?.syntax, maps.syntax) &&
    complete(theme.editor?.terminal, maps.terminal);
  const apply = (theme) => {
    if (!valid(theme)) return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.ui)) root.style.setProperty('--pimote-ui-' + name, value);
    for (const [name, value] of Object.entries(theme.editor.surface)) root.style.setProperty('--pimote-editor-' + name, value);
    for (const [name, value] of Object.entries(theme.editor.syntax)) root.style.setProperty('--pimote-editor-' + name, value);
    for (const [name, value] of Object.entries(theme.editor.terminal)) root.style.setProperty('--pimote-terminal-' + name, value);
    root.classList.toggle('dark', theme.colorScheme === 'dark');
    root.style.colorScheme = theme.colorScheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.ui.background);
  };
  const read = (user) => {
    try {
      const raw = localStorage.getItem(key(user));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  let user = 'default';
  try {
    user = localStorage.getItem('pimote:user') || 'default';
  } catch {
    /* fallback */
  }
  apply(read(user));
  const onStorage = (event) => {
    if (event.key === 'pimote:user') {
      user = event.newValue || 'default';
      apply(read(user));
    } else if (event.key === key(user)) {
      try {
        apply(event.newValue ? JSON.parse(event.newValue) : null);
      } catch {
        // Ignore malformed cross-tab cache data.
      }
    }
  };
  window.addEventListener('storage', onStorage);
  window.PimoteThemeBridge = { startReportThemeBridge: () => () => window.removeEventListener('storage', onStorage) };
})();
