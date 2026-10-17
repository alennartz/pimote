import { describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPimoteDocsExtension, PIMOTE_DOC_FILES, PIMOTE_DOCS_SECTION, pimoteDocsSection } from './index.js';

type Handler = (event: any, ctx: any) => unknown;

function setup() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
  };
  createPimoteDocsExtension()(pi as any);
  return { handlers };
}

describe('pimote-docs prompt section', () => {
  it('injects the section on every agent start', () => {
    const { handlers } = setup();
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };

    handlers.get('before_agent_start')?.[0](event, {});

    expect(event.systemPromptOptions.sections[PIMOTE_DOCS_SECTION]).toBe(pimoteDocsSection());
  });

  it('lists every shipped file by absolute path with its purpose', () => {
    const section = pimoteDocsSection('/install/root');

    for (const file of PIMOTE_DOC_FILES) {
      expect(section).toContain(`- ${join('/install/root', file.path)}: ${file.purpose}`);
    }
  });

  it('points only at files that exist in the package', async () => {
    const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
    for (const file of PIMOTE_DOC_FILES) {
      await expect(access(join(packageRoot, file.path)), file.path).resolves.toBeUndefined();
    }
  });
});
