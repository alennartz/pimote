// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { AssistantRowUsage, PimoteAgentMessage } from '@pimote/shared';
import Message from './Message.svelte';

const mounted: ReturnType<typeof mount>[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
});

const rowUsage: AssistantRowUsage = {
  totalCostUsd: 0.13,
  breakdown: {
    tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, total: 170 },
    cost: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0 },
  },
};

describe('Message assistant cost layout', () => {
  it('keeps the desktop cost disclosure out of row flow and centers it with the bot icon', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(Message, {
        target,
        props: {
          message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } as PimoteAgentMessage,
          assistantRowUsage: rowUsage,
        },
      }),
    );
    await tick();

    const cost = target.querySelector<HTMLElement>('.assistant-cost');
    const meta = target.querySelector<HTMLElement>('.assistant-meta');
    expect(cost).not.toBeNull();
    expect(meta).not.toBeNull();

    // Vitest does not inject component-scoped Svelte CSS into jsdom. Keep the
    // desktop placement contract close to the component so a flex-flow change
    // cannot silently put the cost back into the row width.
    const componentPath = existsSync('src/lib/components/Message.svelte') ? 'src/lib/components/Message.svelte' : join('client', 'src/lib/components/Message.svelte');
    const source = readFileSync(componentPath, 'utf8');
    const assistantMetaRule = source.match(/\.assistant-meta \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    const desktopCostRule = source.match(/\.assistant-cost \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    expect(assistantMetaRule).toContain('align-items: flex-start');
    expect(desktopCostRule).toContain('position: absolute');
    expect(desktopCostRule).toContain('right: calc(100% + 10px)');
    expect(desktopCostRule).toContain('transform: translateY(-50%)');
    expect(desktopCostRule).not.toContain('margin-top: 8px');
    expect(source).toContain('position: static;');
    expect(source).toContain('transform: none;');
  });
});
