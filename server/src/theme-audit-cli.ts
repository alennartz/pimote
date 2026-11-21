import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinThemeDefinitions } from './builtin-themes.js';
import { ThemeCatalog, type ThemeCatalogOptions } from './theme-catalog.js';
import { auditClientMappings, auditThemes, declaredEditorProperties, formatThemeAudit } from './theme-audit.js';

interface CliOptions {
  files: string[];
  json: boolean;
  warningsAsErrors: boolean;
}

function parseArgs(args: readonly string[]): CliOptions {
  const files: string[] = [];
  let json = false;
  let warningsAsErrors = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--warnings-as-errors') {
      warningsAsErrors = true;
    } else if (arg === '--file') {
      const path = args[index + 1];
      if (!path) throw new Error('--file requires a path');
      files.push(path);
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      files.push(arg);
    }
  }
  return { files, json, warningsAsErrors };
}

async function loadThemes(files: readonly string[]) {
  const emptyThemeFile = JSON.stringify({ version: 1, themes: [] });
  const reader: ThemeCatalogOptions['reader'] = {
    read: async (path) => {
      if (path === '<empty>') return emptyThemeFile;
      return readFile(path, 'utf8');
    },
  };
  const catalog = new ThemeCatalog({
    builtinThemes: builtinThemeDefinitions(),
    extensionFiles: files,
    userFile: '<empty>',
    defaultThemeId: 'pimote/light',
    reader,
  });
  const snapshot = await catalog.load();
  await catalog.close();
  return snapshot;
}

function usage(): string {
  return [
    'Usage: npm run audit:themes -- [options] [theme-file ...]',
    '',
    'Audits the built-in themes by default. When a theme file is supplied, only its valid',
    'themes are audited; built-ins remain available as inheritance and palette bases.',
    '',
    'Options:',
    '  --file PATH             Add a version 1 theme file to the audit.',
    '  --json                  Print machine-readable output.',
    '  --warnings-as-errors    Exit with failure when warnings exist.',
  ].join('\n');
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

  const snapshot = await loadThemes(options.files);
  const themes = options.files.length > 0 ? snapshot.themes.filter((theme) => theme.source === 'extension') : snapshot.themes;
  const report = auditThemes(themes);
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const highlightThemeCss = await readFile(join(repositoryRoot, 'client/src/lib/highlight-theme.css'), 'utf8');
  const mappingFindings = auditClientMappings(highlightThemeCss, declaredEditorProperties());
  if (options.json) {
    console.log(JSON.stringify({ report, mappingFindings, diagnostics: snapshot.diagnostics }, null, 2));
  } else {
    console.log(formatThemeAudit(report));
    if (mappingFindings.length > 0) {
      console.log('', 'Mapping violations:');
      for (const finding of mappingFindings) console.log(`  ${finding.severity.toUpperCase()} ${finding.rule}: ${finding.message} (${finding.path})`);
    }
    if (snapshot.diagnostics.length > 0) {
      console.log('', 'Catalog diagnostics:');
      for (const diagnostic of snapshot.diagnostics) console.log(`  ${diagnostic.path}: ${diagnostic.message}`);
    }
  }

  if (
    snapshot.diagnostics.length > 0 ||
    mappingFindings.some((finding) => finding.severity === 'error') ||
    report.errorCount > 0 ||
    (options.warningsAsErrors && report.warningCount > 0)
  )
    process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
