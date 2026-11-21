import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinThemeDefinitions } from '../../server/src/builtin-themes.js';
import { ThemeCatalog } from '../../server/src/theme-catalog.js';
import { auditClientMappings, auditThemes, declaredEditorProperties } from '../../server/src/theme-audit.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? process.argv[2] ?? 4173);
const emptyThemeFile = JSON.stringify({ version: 1, themes: [] });

async function loadPayload(): Promise<object> {
  const catalog = new ThemeCatalog({
    builtinThemes: builtinThemeDefinitions(),
    extensionFiles: [],
    userFile: '<empty>',
    defaultThemeId: 'pimote/light',
    reader: { read: async () => emptyThemeFile },
  });
  const snapshot = await catalog.load();
  const definitions = builtinThemeDefinitions();
  const css = await readFile(join(root, '../../client/src/lib/highlight-theme.css'), 'utf8');
  const payload = {
    themes: snapshot.themes,
    palettes: Object.fromEntries(definitions.map((definition) => [definition.id, definition.palette ?? {}])),
    audit: auditThemes(snapshot.themes),
    mappingFindings: auditClientMappings(css, declaredEditorProperties()),
  };
  await catalog.close();
  return payload;
}

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(await readFile(join(root, 'index.html')));
      return;
    }
    if (path === '/themes.json') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(await loadPayload()));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
});

server.listen(port, () => {
  console.log(`Theme demo: http://localhost:${port}`);
  console.log('Theme data loads from the current server/src and client/src files on every request.');
});
