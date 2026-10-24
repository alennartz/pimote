import { describe, expect, it, vi } from 'vitest';
import { access, readFile } from 'node:fs/promises';
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

  it('keeps the static report pointer and shipped guide focused on document design', async () => {
    const file = PIMOTE_DOC_FILES.find((entry) => entry.path === 'docs/shipped/static-reports.md')!;
    expect(file.purpose).toMatch(/Layout and visual design.*pimote_static_host/);
    expect(file.purpose).not.toMatch(/read|before|summary|300\+/i);

    const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const guide = await readFile(join(packageRoot, file.path), 'utf-8');
    expect(guide).toMatch(/## Self-contained rendering/);
    expect(guide).toMatch(/## Visual design/);
    expect(guide).toMatch(/## Adaptive display/);
    expect(guide).not.toMatch(/300\+|chat|permission|## Hosting|Read it before/i);
  });

  it('points only at files that exist in the package', async () => {
    const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
    for (const file of PIMOTE_DOC_FILES) {
      await expect(access(join(packageRoot, file.path)), file.path).resolves.toBeUndefined();
    }
  });
});
