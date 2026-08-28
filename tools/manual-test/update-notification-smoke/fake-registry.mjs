// Preload used by update-notification-smoke.mjs. It replaces only the npm
// latest-version request; all other fetch calls retain Node's native fetch.
import { appendFileSync } from 'node:fs';

const REGISTRY_URL = 'https://registry.npmjs.org/@pimote/pimote/latest';
const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url !== REGISTRY_URL) return nativeFetch(input, init);

  const logPath = process.env.PIMOTE_FETCH_LOG;
  if (logPath) appendFileSync(logPath, `${new Date().toISOString()} ${process.env.PIMOTE_FAKE_LATEST ?? ''}\n`);

  return new Response(JSON.stringify({ version: process.env.PIMOTE_FAKE_LATEST ?? '0.0.0' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
