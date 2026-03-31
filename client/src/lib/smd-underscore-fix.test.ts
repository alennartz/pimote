/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import * as smd from 'streaming-markdown';
import { createRenderer } from './smd-renderer.js';

function renderComplete(markdown: string): HTMLDivElement {
  const container = document.createElement('div');
  const renderer = createRenderer(container);
  const p = smd.parser(renderer);
  smd.parser_write(p, markdown);
  smd.parser_end(p);
  return container;
}

describe('streaming-markdown intraword underscore fix', () => {
  it('renders agent_complete as literal text (no em tags)', () => {
    const container = renderComplete('agent_complete');
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toContain('agent_complete');
  });

  it('renders <agent_complete ...> tag-like text without em tags', () => {
    const markdown = '<agent_complete id="test">content</agent_complete>';
    const container = renderComplete(markdown);
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toContain('agent_complete');
  });

  it('renders snake_case_name as literal text', () => {
    const container = renderComplete('snake_case_name');
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toContain('snake_case_name');
  });

  it('keeps proper underscore emphasis working', () => {
    const container = renderComplete('prefix _proper emphasis_ suffix');
    const em = container.querySelector('em');
    expect(em).not.toBeNull();
    expect(em!.textContent).toBe('proper emphasis');
  });

  it('keeps asterisk emphasis working', () => {
    const container = renderComplete('*asterisk_inside*');
    const em = container.querySelector('em');
    expect(em).not.toBeNull();
    expect(em!.textContent).toBe('asterisk_inside');
  });

  it('keeps strong underscore emphasis working when not intraword', () => {
    const container = renderComplete('__strong__');
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('strong');
  });

  it('renders foo__bar__baz as literal text (no strong or em tags)', () => {
    const container = renderComplete('foo__bar__baz');
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toContain('foo__bar__baz');
  });
});
