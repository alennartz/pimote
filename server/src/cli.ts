import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH } from './config.js';
import { PIMOTE_STATE_DIR } from './paths.js';
import { main as startPimote } from './index.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface ParsedArgs {
  command: 'start' | 'init' | 'help' | 'version';
  port?: number;
  roots: string[];
  error?: string;
}

interface ExistingConfigResult {
  exists: boolean;
  data: Record<string, unknown>;
  warning?: string;
}

export async function getVersion(): Promise<string> {
  const raw = await readFile(join(ROOT_DIR, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw);
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

export function printHelp(): void {
  console.log(`pimote — browser UI for pi

Usage:
  pimote [--port <port>]             Start Pimote (runs first-time setup if needed)
  pimote start [--port <port>]       Start Pimote using your existing config
  pimote init [options]              Create or update Pimote config
  pimote help                        Show this help
  pimote version                     Show the installed version

Options:
  -p, --port <port>                  Override the server port for this run, or set it during init
  -r, --root <path>                  Add a project root during init (repeatable)
  -h, --help                         Show this help
  -v, --version                      Show the installed version

Environment:
  PORT                               Override the configured server port

Examples:
  pimote
  pimote --port 3001
  pimote init --root ~/projects --root ~/work --port 3001
`);
}

export function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function looksLikeProjectDirectory(path: string): Promise<boolean> {
  return (await pathExists(join(path, '.git'))) || (await pathExists(join(path, 'package.json')));
}

export function parsePort(raw: string | number): number {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid port: ${raw}`);
  }

  const port = Number.parseInt(text, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }

  return port;
}

export async function normalizeRoots(values: string[]): Promise<string[]> {
  const parts = values
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error('At least one project root is required.');
  }

  const uniqueRoots: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const resolved = resolve(expandHomePath(part));
    if (!(await isDirectory(resolved))) {
      throw new Error(`Project root does not exist or is not a directory: ${part}`);
    }
    if (!seen.has(resolved)) {
      seen.add(resolved);
      uniqueRoots.push(resolved);
    }
  }

  return uniqueRoots;
}

async function suggestDefaultRoot(): Promise<string> {
  const cwd = process.cwd();
  if (await looksLikeProjectDirectory(cwd)) {
    return dirname(cwd);
  }

  const candidates = [join(homedir(), 'projects'), join(homedir(), 'work'), join(homedir(), 'repos')];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }

  return cwd;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readExistingConfigObject(configPath: string): Promise<ExistingConfigResult> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return {
        exists: true,
        data: {},
        warning: `[pimote] Existing config at ${configPath} is not a JSON object. It will be replaced.`,
      };
    }
    return { exists: true, data: parsed };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { exists: false, data: {} };
    }
    return {
      exists: true,
      data: {},
      warning: `[pimote] Existing config at ${configPath} could not be read. It will be replaced.`,
    };
  }
}

function buildConfigPayload(existingConfig: Record<string, unknown>, roots: string[], port: number): Record<string, unknown> {
  return {
    ...existingConfig,
    roots,
    port,
  };
}

async function writeConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function printSetupIntro(configPath: string, stateDir: string, isUpdate: boolean): void {
  console.log(isUpdate ? '[pimote] Updating Pimote setup.' : '[pimote] Welcome to Pimote.');
  console.log('');
  console.log('Pimote runs a local web app for pi. It scans the project roots you choose,');
  console.log('starts a local server, and opens your pi sessions in the browser.');
  console.log('');
  console.log('Before you start chatting, make sure pi has at least one working provider/model');
  console.log('configured, either through API keys or your existing pi login setup.');
  console.log('');
  console.log(`Config file: ${configPath}`);
  console.log(`State dir:   ${stateDir}`);
  console.log('');
}

async function promptWithDefault(rl: ReturnType<typeof createInterface>, label: string, defaultValue: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || defaultValue;
}

async function promptForRoots(rl: ReturnType<typeof createInterface>, defaultRoots: string[]): Promise<string[]> {
  while (true) {
    const answer = await promptWithDefault(rl, 'Project roots (comma-separated parent directories to scan for repos)', defaultRoots.join(', '));

    try {
      return await normalizeRoots([answer]);
    } catch (err) {
      console.error(`[pimote] ${err instanceof Error ? err.message : err}`);
      console.error('[pimote] Example: ~/projects, ~/work');
    }
  }
}

async function promptForPort(rl: ReturnType<typeof createInterface>, defaultPort: number): Promise<number> {
  while (true) {
    const answer = await promptWithDefault(rl, 'Port', String(defaultPort));
    try {
      return parsePort(answer);
    } catch (err) {
      console.error(`[pimote] ${err instanceof Error ? err.message : err}`);
      console.error('[pimote] Enter a number between 1 and 65535.');
    }
  }
}

interface ResolveInitConfigOptions {
  interactive: boolean;
  existingConfig: Record<string, unknown>;
  configPath: string;
  stateDir: string;
  cliPort?: number;
  cliRoots: string[];
}

async function runInteractiveInit(options: ResolveInitConfigOptions): Promise<{ roots: string[]; port: number }> {
  const { configPath, stateDir, existingConfig, cliPort, cliRoots } = options;
  const existingRoots = Array.isArray(existingConfig.roots) && existingConfig.roots.every((value) => typeof value === 'string') ? existingConfig.roots : [];
  const defaultRoots = cliRoots.length > 0 ? await normalizeRoots(cliRoots) : existingRoots.length > 0 ? existingRoots : [await suggestDefaultRoot()];
  const defaultPort = cliPort ?? (typeof existingConfig.port === 'number' ? existingConfig.port : 3000);

  printSetupIntro(configPath, stateDir, Object.keys(existingConfig).length > 0);
  console.log('Tip: roots should be parent directories like ~/projects, not individual repos.');
  console.log('Pimote scans each root one level deep and picks folders containing .git or package.json.');
  console.log('');

  const rl = createInterface({ input, output });
  try {
    const roots = cliRoots.length > 0 ? defaultRoots : await promptForRoots(rl, defaultRoots);
    const port = cliPort ?? (await promptForPort(rl, defaultPort));
    return { roots, port };
  } finally {
    rl.close();
  }
}

async function resolveInitConfig(options: ResolveInitConfigOptions): Promise<{ roots: string[]; port: number }> {
  const { interactive, existingConfig, configPath, stateDir, cliPort, cliRoots } = options;

  if (cliRoots.length > 0 && !interactive) {
    return {
      roots: await normalizeRoots(cliRoots),
      port: cliPort ?? (typeof existingConfig.port === 'number' ? existingConfig.port : 3000),
    };
  }

  if (!interactive) {
    throw new Error(`No interactive terminal detected. Run \`pimote init --root /path/to/projects [--port 3000]\` or create ${configPath} manually.`);
  }

  return runInteractiveInit({
    interactive,
    existingConfig,
    configPath,
    stateDir,
    cliPort,
    cliRoots,
  });
}

export async function initializeConfig(options: {
  command: 'start' | 'init';
  cliPort?: number;
  cliRoots: string[];
}): Promise<{ configPath: string; created: boolean; port: number }> {
  const existing = await readExistingConfigObject(CONFIG_PATH);

  if (existing.warning) {
    console.warn(existing.warning);
  }

  const desired = await resolveInitConfig({
    interactive: Boolean(input.isTTY && output.isTTY),
    existingConfig: existing.data,
    configPath: CONFIG_PATH,
    stateDir: PIMOTE_STATE_DIR,
    cliPort: options.cliPort,
    cliRoots: options.cliRoots,
  });

  const config = buildConfigPayload(existing.data, desired.roots, desired.port);
  await writeConfig(CONFIG_PATH, config);

  console.log(`[pimote] Wrote config to ${CONFIG_PATH}`);
  console.log(`[pimote] Pimote will scan these roots:`);
  for (const root of desired.roots) {
    console.log(`  - ${root}`);
  }
  console.log(`[pimote] Pimote will listen on http://localhost:${desired.port}`);
  console.log(`[pimote] Runtime state will be stored in ${PIMOTE_STATE_DIR}`);

  if (options.command === 'init') {
    console.log('[pimote] Next step: run `pimote` and open the printed URL in your browser.');
  }

  return { configPath: CONFIG_PATH, created: !existing.exists, port: desired.port };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const commands = new Set(['start', 'init', 'help', 'version']);
  let command: ParsedArgs['command'] = 'start';
  let index = 0;

  if (argv[0] === '--help' || argv[0] === '-h') {
    return { command: 'help', port: undefined, roots: [] };
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    return { command: 'version', port: undefined, roots: [] };
  }

  if (argv[0] && !argv[0].startsWith('-')) {
    if (!commands.has(argv[0])) {
      return { command: 'start', roots: [], error: `Unknown command: ${argv[0]}` };
    }
    command = argv[0] as ParsedArgs['command'];
    index = 1;
  }

  let port: number | undefined;
  const roots: string[] = [];

  while (index < argv.length) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      return { command: 'help', port, roots };
    }

    if (arg === '--version' || arg === '-v') {
      return { command: 'version', port, roots };
    }

    if (arg === '--port' || arg === '-p') {
      const value = argv[index + 1];
      if (!value) return { command, port, roots, error: 'Missing value for --port' };
      try {
        port = parsePort(value);
      } catch (err) {
        return { command, port, roots, error: err instanceof Error ? err.message : String(err) };
      }
      index += 2;
      continue;
    }

    if (arg === '--root' || arg === '-r') {
      const value = argv[index + 1];
      if (!value) return { command, port, roots, error: 'Missing value for --root' };
      roots.push(value);
      index += 2;
      continue;
    }

    return { command, port, roots, error: `Unknown option: ${arg}` };
  }

  return { command, port, roots };
}

export async function ensureConfigForStart(parsed: ParsedArgs): Promise<{ created: boolean; configPath: string }> {
  if (await pathExists(CONFIG_PATH)) {
    return { created: false, configPath: CONFIG_PATH };
  }

  console.log(`[pimote] No config found at ${CONFIG_PATH}.`);
  console.log('');
  const result = await initializeConfig({ command: 'start', cliPort: parsed.port, cliRoots: parsed.roots });
  console.log('');
  console.log('[pimote] Starting server...');
  return result;
}

export async function startServer(parsed: ParsedArgs): Promise<void> {
  await ensureConfigForStart(parsed);
  await startPimote({ portOverride: parsed.port });
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.error) {
    console.error(`[pimote] ${parsed.error}`);
    console.error('Run `pimote help` for usage.');
    process.exit(1);
  }

  if (parsed.command === 'help') {
    printHelp();
    return;
  }

  if (parsed.command === 'version') {
    console.log(await getVersion());
    return;
  }

  if (parsed.command === 'init') {
    await initializeConfig({ command: 'init', cliPort: parsed.port, cliRoots: parsed.roots });
    return;
  }

  await startServer(parsed);
}
