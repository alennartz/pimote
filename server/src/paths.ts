import { join } from 'node:path';
import { homedir } from 'node:os';

function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function getXdgStateHome(): string {
  return process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
}

export const PIMOTE_CONFIG_DIR = join(getXdgConfigHome(), 'pimote');
export const PIMOTE_STATE_DIR = join(getXdgStateHome(), 'pimote');

export const PIMOTE_CONFIG_PATH = join(PIMOTE_CONFIG_DIR, 'config.json');
export const PIMOTE_PUSH_SUBSCRIPTIONS_PATH = join(PIMOTE_STATE_DIR, 'push-subscriptions.json');
export const PIMOTE_SESSION_METADATA_PATH = join(PIMOTE_STATE_DIR, 'session-metadata.json');

/** Directory scanned for user project-source modules (dynamic-imported extensible discovery). */
export const PIMOTE_PROJECT_SOURCES_DIR = join(PIMOTE_CONFIG_DIR, 'project-sources');

/** Directory holding the project registry store (`registry.json`). */
export const PIMOTE_PROJECTS_DIR = join(PIMOTE_STATE_DIR, 'projects');

/** Directory holding server-provided pi skills materialized for progressive discovery. */
export const PIMOTE_SKILLS_DIR = join(PIMOTE_STATE_DIR, 'skills');
/** Directory holding per-session static-host persistence files (`<sessionId>.json`). */
export const PIMOTE_STATIC_HOST_DIR = join(PIMOTE_STATE_DIR, 'static-host');
/** Directory holding per-session pending-download persistence files (`<sessionId>.json`). */
export const PIMOTE_FILE_DOWNLOAD_DIR = join(PIMOTE_STATE_DIR, 'file-downloads');
export const LEGACY_PIMOTE_PUSH_SUBSCRIPTIONS_PATH = join(PIMOTE_CONFIG_DIR, 'push-subscriptions.json');
