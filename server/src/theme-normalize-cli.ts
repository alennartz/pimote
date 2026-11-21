import { readFile, writeFile } from 'node:fs/promises';
import type { ThemeDefinition } from '../../shared/dist/index.js';
import { builtinThemeDefinitions } from './builtin-themes.js';
import { parseThemeFile, resolveThemeDefinitions } from './theme-catalog.js';
import { normalizeThemeFile } from './theme-normalize.js';

interface CliOptions {
  files: string[];
  write: boolean;
  check: boolean;
  report: boolean;
  expand: boolean;
  json: boolean;
}

const RESOLVE_PATH = '<normalize>';

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { files: [], write: false, check: false, report: false, expand: false, json: false };
  for (const arg of args) {
    if (arg === '--write') options.write = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--report') options.report = true;
    else if (arg === '--expand') options.expand = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  if (options.files.length === 0) throw new Error('name at least one theme file');
  return options;
}

function usage(): string {
  return [
    'Usage: npm run theme:normalize -- [options] <theme-file ...>',
    '',
    'Rewrites theme files into the smallest form that resolves to the same palette,',
    'using the built-in themes as inheritance bases.',
    '',
    'Options:',
    '  --write     Rewrite each file in place.',
    '  --check     Exit with failure when a file is not in normalized form.',
    '  --report    Print each theme level, histogram, and reach.',
    '  --expand    Print every resolved token instead of the minimal form.',
    '  --json      Print machine-readable output.',
  ].join('\n');
}

function expandFile(raw: string): ThemeDefinition[] {
  const parsed = parseThemeFile(raw, RESOLVE_PATH);
  if (!parsed.valid) return [];
  const resolution = resolveThemeDefinitions([
    ...builtinThemeDefinitions().map((definition) => ({ definition, source: 'builtin' as const, path: '<builtin>' })),
    ...parsed.definitions.map((definition) => ({ definition, source: 'user' as const, path: RESOLVE_PATH })),
  ]);
  const ids = new Set(parsed.definitions.map((definition) => definition.id));
  return resolution.themes
    .filter((theme) => ids.has(theme.id))
    .map((theme) => ({ id: theme.id, name: theme.name, colorScheme: theme.colorScheme, ui: theme.ui, editor: theme.editor }));
}

function formatProfile(id: string, depth: Record<string, number>, histogram: Record<string, readonly number[]>, reach: readonly string[]): string[] {
  const lines = [`  ${id}`];
  for (const [namespace, level] of Object.entries(depth)) {
    const spread = (histogram[namespace] ?? []).map((count, index) => `${index}:${count}`).join(' ');
    lines.push(`    ${namespace} level ${level} (${spread})`);
  }
  if (reach.length > 0) lines.push(`    reaches past unstated parents: ${reach.join(', ')}`);
  return lines;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  let failed = false;
  const report: Array<Record<string, unknown>> = [];
  for (const path of options.files) {
    const raw = await readFile(path, 'utf8');
    const result = normalizeThemeFile(raw, { builtinThemes: builtinThemeDefinitions(), path });
    const themes = options.expand ? expandFile(raw) : result.themes;
    const text = options.expand ? `${JSON.stringify({ version: 1, themes }, null, 2)}\n` : result.text;
    if (result.diagnostics.length > 0) {
      failed = true;
      for (const diagnostic of result.diagnostics) console.error(`${diagnostic.path}: ${diagnostic.message}`);
    }
    if (options.check && result.changed) failed = true;
    if (options.write && result.changed) await writeFile(path, result.text);
    report.push({ path, changed: result.changed, profiles: result.profiles, diagnostics: result.diagnostics, text: options.check || options.write ? undefined : text });

    if (options.json || options.check || options.write) continue;
    if (options.files.length > 1) console.log(`# ${path}`);
    if (options.report) {
      for (const [id, profile] of Object.entries(result.profiles)) for (const line of formatProfile(id, profile.depth, profile.histogram, profile.reach)) console.log(line);
    } else {
      process.stdout.write(text);
    }
  }

  if (options.json) console.log(JSON.stringify(report, null, 2));
  if (options.check && failed) console.error('theme files are not in normalized form');
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
