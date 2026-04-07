#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = homedir();
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8'));
const packageName = typeof rootPackage.name === 'string' ? rootPackage.name : 'pimote';
const serviceName = process.env.PIMOTE_SERVICE_NAME || 'pimote';
const xdgDataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
const installRoot = process.env.PIMOTE_INSTALL_ROOT || join(xdgDataHome, 'pimote');
const servicePath = process.env.PIMOTE_SYSTEMD_UNIT_PATH || join(xdgConfigHome, 'systemd', 'user', `${serviceName}.service`);
const envFile = process.env.PIMOTE_ENV_FILE || join(xdgConfigHome, 'pimote', 'env');
const nodePath = process.execPath;
const nodeDir = dirname(nodePath);
const packageRoot = join(installRoot, 'current', 'node_modules', ...String(packageName).split('/'));
const execScript = join(packageRoot, 'bin', 'pimote.js');

const unit = `[Unit]
Description=${serviceName} server (installed package)
After=network.target

[Service]
Type=simple
WorkingDirectory=${packageRoot}
ExecStart=${nodePath} ${execScript} start
Restart=on-failure
RestartSec=3
Environment=PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin
Environment=HOME=${home}
EnvironmentFile=-${envFile}

[Install]
WantedBy=default.target
`;

await mkdir(dirname(servicePath), { recursive: true });
await writeFile(servicePath, unit, 'utf-8');

console.log(`[pimote] Wrote systemd unit to ${servicePath}`);
console.log(`[pimote] Service will run from ${packageRoot}`);
console.log(`[pimote] Service will use node at ${nodePath}`);
