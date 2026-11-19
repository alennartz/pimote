/* global document, localStorage */

(() => {
  const keys = {
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
  function validMap(value, required) {
    return value && typeof value === 'object' && !Array.isArray(value) && required.every((key) => typeof value[key] === 'string' && value[key]);
  }
  function validTheme(value) {
    return (
      value &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      typeof value.name === 'string' &&
      (value.colorScheme === 'light' || value.colorScheme === 'dark') &&
      (value.source === 'builtin' || value.source === 'extension' || value.source === 'user') &&
      validMap(value.ui, keys.ui) &&
      validMap(value.editor?.surface, keys.surface) &&
      validMap(value.editor?.syntax, keys.syntax) &&
      validMap(value.editor?.terminal, keys.terminal)
    );
  }
  function apply(theme) {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.ui)) root.style.setProperty('--pimote-ui-' + name, value);
    for (const [name, value] of Object.entries(theme.editor.surface)) root.style.setProperty('--pimote-editor-' + name, value);
    for (const [name, value] of Object.entries(theme.editor.syntax)) root.style.setProperty('--pimote-editor-' + name, value);
    for (const [name, value] of Object.entries(theme.editor.terminal)) root.style.setProperty('--pimote-terminal-' + name, value);
    root.classList.toggle('dark', theme.colorScheme === 'dark');
    root.style.colorScheme = theme.colorScheme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme.ui.background;
  }
  try {
    const user = localStorage.getItem('pimote:user') || 'default';
    const value = localStorage.getItem('pimote:theme:' + encodeURIComponent(user));
    if (value) {
      const theme = JSON.parse(value);
      if (validTheme(theme)) apply(theme);
    }
  } catch {
    // Keep the CSS fallback when storage is unavailable or malformed.
  }
})();
