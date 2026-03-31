/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import * as smd from 'streaming-markdown';
import { createRenderer } from './smd-renderer.js';

/** Helper: render complete markdown in one shot */
function renderComplete(markdown: string): HTMLDivElement {
  const container = document.createElement('div');
  const renderer = createRenderer(container);
  const p = smd.parser(renderer);
  smd.parser_write(p, markdown);
  smd.parser_end(p);
  return container;
}

/** Helper: render markdown by streaming one character at a time */
function renderStreamed(markdown: string): HTMLDivElement {
  const container = document.createElement('div');
  const renderer = createRenderer(container);
  const p = smd.parser(renderer);
  for (const char of markdown) {
    smd.parser_write(p, char);
  }
  smd.parser_end(p);
  return container;
}

describe('createRenderer', () => {
  // ---------------------------------------------------------------------------
  // Basic rendering
  // ---------------------------------------------------------------------------
  describe('basic markdown rendering', () => {
    it('renders a paragraph from plain text', () => {
      const container = renderComplete('Hello world');
      const p = container.querySelector('p');
      expect(p).not.toBeNull();
      expect(p!.textContent).toBe('Hello world');
    });

    it('renders bold text', () => {
      const container = renderComplete('**bold**');
      const strong = container.querySelector('strong');
      expect(strong).not.toBeNull();
      expect(strong!.textContent).toBe('bold');
    });

    it('renders italic text', () => {
      const container = renderComplete('*italic*');
      const em = container.querySelector('em');
      expect(em).not.toBeNull();
      expect(em!.textContent).toBe('italic');
    });

    it('renders inline code', () => {
      const container = renderComplete('use `foo()` here');
      const code = container.querySelector('code');
      expect(code).not.toBeNull();
      expect(code!.textContent).toBe('foo()');
    });

    it('renders headings', () => {
      const container = renderComplete('# Heading 1\n\n## Heading 2');
      expect(container.querySelector('h1')?.textContent).toBe('Heading 1');
      expect(container.querySelector('h2')?.textContent).toBe('Heading 2');
    });

    it('renders unordered lists', () => {
      const container = renderComplete('- one\n- two\n- three');
      const items = container.querySelectorAll('li');
      expect(items.length).toBe(3);
      expect(items[0].textContent).toBe('one');
      expect(items[1].textContent).toBe('two');
      expect(items[2].textContent).toBe('three');
    });

    it('renders links', () => {
      const container = renderComplete('[click here](https://example.com)');
      const link = container.querySelector('a');
      expect(link).not.toBeNull();
      expect(link!.textContent).toBe('click here');
      expect(link!.getAttribute('href')).toBe('https://example.com');
    });

    it('renders blockquotes', () => {
      const container = renderComplete('> quoted text');
      const bq = container.querySelector('blockquote');
      expect(bq).not.toBeNull();
      expect(bq!.textContent).toContain('quoted text');
    });
  });

  // ---------------------------------------------------------------------------
  // Code blocks with syntax highlighting
  // ---------------------------------------------------------------------------
  describe('code block syntax highlighting', () => {
    it('renders a fenced code block with language and applies highlighting', () => {
      const md = '```typescript\nconst x: number = 42;\n```';
      const container = renderComplete(md);

      const pre = container.querySelector('pre');
      expect(pre).not.toBeNull();

      const code = pre!.querySelector('code');
      expect(code).not.toBeNull();
      // highlight.js adds the hljs class when it highlights an element
      expect(code!.classList.contains('hljs')).toBe(true);
      // The content should still contain the source text
      expect(code!.textContent).toContain('const');
      expect(code!.textContent).toContain('42');
    });

    it('applies highlighting with a language alias (ts → typescript)', () => {
      const md = '```ts\nconst x = 1;\n```';
      const container = renderComplete(md);
      const code = container.querySelector('pre code');
      expect(code).not.toBeNull();
      expect(code!.classList.contains('hljs')).toBe(true);
    });

    it('renders a code block without a language specifier', () => {
      const md = '```\nsome code\n```';
      const container = renderComplete(md);
      const code = container.querySelector('pre code');
      expect(code).not.toBeNull();
      // Should still have content, even without language-specific highlighting
      expect(code!.textContent).toContain('some code');
    });

    it('applies highlighting for python code blocks', () => {
      const md = '```python\ndef greet(name):\n    print(f"Hello {name}")\n```';
      const container = renderComplete(md);
      const code = container.querySelector('pre code');
      expect(code).not.toBeNull();
      expect(code!.classList.contains('hljs')).toBe(true);
      expect(code!.textContent).toContain('def greet');
    });

    it('renders multiple code blocks independently', () => {
      const md = '```js\nlet a = 1;\n```\n\nSome text\n\n```python\nx = 2\n```';
      const container = renderComplete(md);
      const codeBlocks = container.querySelectorAll('pre code');
      expect(codeBlocks.length).toBe(2);
      // Both should be highlighted
      expect(codeBlocks[0].classList.contains('hljs')).toBe(true);
      expect(codeBlocks[1].classList.contains('hljs')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Streaming behavior
  // ---------------------------------------------------------------------------
  describe('streaming behavior', () => {
    it('produces the same structure whether text is streamed or rendered at once', () => {
      const md = 'Hello **world**, this is `code`.\n\n- item 1\n- item 2';
      const complete = renderComplete(md);
      const streamed = renderStreamed(md);

      // Compare the structural output (element tags and text content)
      expect(streamed.querySelectorAll('p').length).toBe(complete.querySelectorAll('p').length);
      expect(streamed.querySelectorAll('strong').length).toBe(complete.querySelectorAll('strong').length);
      expect(streamed.querySelectorAll('code').length).toBe(complete.querySelectorAll('code').length);
      expect(streamed.querySelectorAll('li').length).toBe(complete.querySelectorAll('li').length);
      // Text content should match
      expect(streamed.textContent).toBe(complete.textContent);
    });

    it('applies syntax highlighting on streamed code blocks when they close', () => {
      const md = '```typescript\nconst x: number = 42;\n```';
      const container = renderStreamed(md);
      const code = container.querySelector('pre code');
      expect(code).not.toBeNull();
      expect(code!.classList.contains('hljs')).toBe(true);
    });

    it('incrementally builds DOM — feeding partial text creates partial output', () => {
      const container = document.createElement('div');
      const renderer = createRenderer(container);
      const p = smd.parser(renderer);

      smd.parser_write(p, 'Hello ');
      // Should have started building content
      expect(container.textContent).toContain('Hello');

      smd.parser_write(p, '**world**');
      expect(container.textContent).toContain('world');

      smd.parser_end(p);
      // Final state should have bold
      expect(container.querySelector('strong')?.textContent).toBe('world');
    });

    it('only appends — existing text nodes are not modified by later writes', () => {
      const container = document.createElement('div');
      const renderer = createRenderer(container);
      const p = smd.parser(renderer);

      smd.parser_write(p, 'First sentence. ');
      const initialNodes = container.querySelectorAll('*').length;
      const initialText = container.textContent;

      smd.parser_write(p, 'Second sentence.');
      // Should have at least as many nodes (only adding)
      expect(container.querySelectorAll('*').length).toBeGreaterThanOrEqual(initialNodes);
      // Initial text should still be there
      expect(container.textContent).toContain(initialText!);

      smd.parser_end(p);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty text', () => {
      const container = renderComplete('');
      expect(container.children.length).toBe(0);
    });

    it('handles text with only whitespace', () => {
      const container = renderComplete('   \n\n   ');
      // Should not crash, content may be empty
      expect(container).toBeDefined();
    });

    it('handles markdown with special HTML characters safely', () => {
      const container = renderComplete('Use <script>alert("xss")</script> tags');
      // smd uses createTextNode for text content — inherently safe
      expect(container.textContent).toContain('alert');
    });

    it('handles a code block with no closing fence gracefully', () => {
      const container = document.createElement('div');
      const renderer = createRenderer(container);
      const p = smd.parser(renderer);

      smd.parser_write(p, '```typescript\nconst x = 1;\n');
      // No closing fence yet — should still have content
      expect(container.textContent).toContain('const x = 1;');

      smd.parser_end(p);
      // After end, content should still be present
      expect(container.textContent).toContain('const x = 1;');
    });

    it('handles deeply nested markdown structures', () => {
      const md = '> - **bold in a list in a blockquote**\n> - *italic*';
      const container = renderComplete(md);
      expect(container.querySelector('blockquote')).not.toBeNull();
      expect(container.querySelector('li')).not.toBeNull();
      expect(container.querySelector('strong')?.textContent).toBe('bold in a list in a blockquote');
    });
  });
});
