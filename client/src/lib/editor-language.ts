import { detectHighlightedLanguage } from './syntax-highlighter.js';

export type EditorLanguage = 'typescript' | 'javascript' | 'json' | 'python' | 'shell' | 'html' | 'xml' | 'css' | 'markdown' | 'yaml' | 'sql' | 'diff';

export interface ResolvedEditorLanguage {
  id: EditorLanguage;
  label: string;
  source: 'title' | 'prefill';
  matchedPath?: string;
}

const EXTENSION_LANGUAGE_MAP: Record<string, EditorLanguage> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  html: 'html',
  htm: 'html',
  svelte: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
};

const LANGUAGE_LABELS: Record<EditorLanguage, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  python: 'Python',
  shell: 'Shell',
  html: 'HTML',
  xml: 'XML',
  css: 'CSS',
  markdown: 'Markdown',
  yaml: 'YAML',
  sql: 'SQL',
  diff: 'Diff',
};

const HIGHLIGHT_LANGUAGE_MAP: Record<string, EditorLanguage> = {
  typescript: 'typescript',
  ts: 'typescript',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  python: 'python',
  py: 'python',
  bash: 'shell',
  shell: 'shell',
  sh: 'shell',
  html: 'html',
  xml: 'xml',
  css: 'css',
  markdown: 'markdown',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  diff: 'diff',
};

const FILELIKE_PATTERN = /[~A-Za-z0-9_./+\\-]+\.[A-Za-z0-9_-]+/g;

function trimFileLikeToken(token: string): string {
  return token.replace(/^["'`([{<]+/, '').replace(/["'`)>\]}:;,!.?]+$/, '');
}

function getLanguageLabel(id: EditorLanguage): string {
  return LANGUAGE_LABELS[id];
}

function mapHighlightLanguage(language: string | null): EditorLanguage | null {
  if (!language) return null;
  return HIGHLIGHT_LANGUAGE_MAP[language.toLowerCase()] ?? null;
}

export function extractFilenameFromTitle(title: string): string | null {
  const matches = title.match(FILELIKE_PATTERN);
  if (!matches || matches.length === 0) return null;

  for (let i = matches.length - 1; i >= 0; i--) {
    const trimmed = trimFileLikeToken(matches[i]!);
    if (trimmed && /\.[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  }

  return null;
}

export function inferLanguageFromTitle(title: string): ResolvedEditorLanguage | null {
  const matchedPath = extractFilenameFromTitle(title);
  if (!matchedPath) return null;

  const extension = matchedPath.split('.').pop()?.toLowerCase();
  if (!extension) return null;

  const id = EXTENSION_LANGUAGE_MAP[extension];
  if (!id) return null;

  return {
    id,
    label: getLanguageLabel(id),
    source: 'title',
    matchedPath,
  };
}

export function inferLanguageFromContent(prefill: string): ResolvedEditorLanguage | null {
  const id = mapHighlightLanguage(detectHighlightedLanguage(prefill));
  if (!id) return null;

  return {
    id,
    label: getLanguageLabel(id),
    source: 'prefill',
  };
}

export function resolveEditorLanguage(title?: string, prefill?: string): ResolvedEditorLanguage | null {
  if (title) {
    const fromTitle = inferLanguageFromTitle(title);
    if (fromTitle) return fromTitle;
  }

  if (prefill) {
    return inferLanguageFromContent(prefill);
  }

  return null;
}
