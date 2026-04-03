import { describe, it, expect } from 'vitest';
import { markdownToSpeech } from './markdown-to-speech.js';

describe('markdownToSpeech', () => {
  describe('empty and trivial input', () => {
    it('returns empty string for empty input', () => {
      expect(markdownToSpeech('')).toBe('');
    });

    it('returns empty string for whitespace-only input', () => {
      expect(markdownToSpeech('   \n\n  \t  ')).toBe('');
    });

    it('passes through plain text unchanged', () => {
      expect(markdownToSpeech('Hello world')).toBe('Hello world');
    });

    it('normalizes excess whitespace in plain text', () => {
      const result = markdownToSpeech('Hello   world\n\n\n\nGoodbye');
      expect(result).not.toMatch(/\n{3,}/);
      expect(result).toContain('Hello');
      expect(result).toContain('world');
      expect(result).toContain('Goodbye');
    });
  });

  describe('code blocks', () => {
    it('replaces a fenced code block with language and line count', () => {
      const md = '```typescript\nconst x = 1;\nconst y = 2;\n```';
      expect(markdownToSpeech(md)).toBe('Code block, 2 lines, typescript.');
    });

    it('replaces a code block without language', () => {
      const md = '```\nfoo\nbar\nbaz\n```';
      expect(markdownToSpeech(md)).toBe('Code block, 3 lines.');
    });

    it('handles an empty code block (0 lines)', () => {
      const md = '```python\n```';
      expect(markdownToSpeech(md)).toBe('Code block, 0 lines, python.');
    });

    it('handles an empty code block without language', () => {
      const md = '```\n```';
      expect(markdownToSpeech(md)).toBe('Code block, 0 lines.');
    });

    it('counts lines correctly for single-line code block', () => {
      const md = '```js\nconsole.log("hi");\n```';
      expect(markdownToSpeech(md)).toBe('Code block, 1 lines, js.');
    });

    it('preserves surrounding text around code blocks', () => {
      const md = 'Before\n\n```ts\ncode\n```\n\nAfter';
      const result = markdownToSpeech(md);
      expect(result).toContain('Before');
      expect(result).toContain('Code block, 1 lines, ts.');
      expect(result).toContain('After');
    });
  });

  describe('formatting syntax', () => {
    it('strips bold markers', () => {
      expect(markdownToSpeech('This is **bold** text')).toBe('This is bold text');
    });

    it('strips italic markers with asterisks', () => {
      expect(markdownToSpeech('This is *italic* text')).toBe('This is italic text');
    });

    it('strips italic markers with underscores', () => {
      expect(markdownToSpeech('This is _italic_ text')).toBe('This is italic text');
    });

    it('strips strikethrough markers', () => {
      expect(markdownToSpeech('This is ~~deleted~~ text')).toBe('This is deleted text');
    });

    it('strips nested formatting (bold inside italic)', () => {
      const result = markdownToSpeech('This is *a **nested** thing*');
      expect(result).toBe('This is a nested thing');
    });

    it('strips bold-italic markers', () => {
      expect(markdownToSpeech('***bold italic***')).toBe('bold italic');
    });

    it('strips inline code backticks', () => {
      expect(markdownToSpeech('Use the `forEach` method')).toBe('Use the forEach method');
    });

    it('strips inline code backticks with multiple instances', () => {
      const result = markdownToSpeech('Call `foo()` then `bar()`');
      expect(result).toBe('Call foo() then bar()');
    });
  });

  describe('headers', () => {
    it('strips h1 marker', () => {
      expect(markdownToSpeech('# Title')).toBe('Title');
    });

    it('strips h2 marker', () => {
      expect(markdownToSpeech('## Subtitle')).toBe('Subtitle');
    });

    it('strips h3 marker', () => {
      expect(markdownToSpeech('### Section')).toBe('Section');
    });

    it('strips h6 marker', () => {
      expect(markdownToSpeech('###### Deep heading')).toBe('Deep heading');
    });

    it('preserves text after header', () => {
      const result = markdownToSpeech('# Title\n\nSome content');
      expect(result).toContain('Title');
      expect(result).toContain('Some content');
    });
  });

  describe('links', () => {
    it('replaces link with its text', () => {
      expect(markdownToSpeech('[click here](https://example.com)')).toBe('click here');
    });

    it('handles links inline with other text', () => {
      const result = markdownToSpeech('Visit [our site](https://example.com) today');
      expect(result).toBe('Visit our site today');
    });

    it('handles multiple links', () => {
      const md = '[a](http://a.com) and [b](http://b.com)';
      const result = markdownToSpeech(md);
      expect(result).toContain('a');
      expect(result).toContain('and');
      expect(result).toContain('b');
      expect(result).not.toContain('http');
    });
  });

  describe('images', () => {
    it('replaces image with alt text', () => {
      expect(markdownToSpeech('![a cute cat](cat.png)')).toBe('a cute cat');
    });

    it('skips image with no alt text', () => {
      const result = markdownToSpeech('![](image.png)');
      expect(result.trim()).toBe('');
    });

    it('handles image inline with text', () => {
      const result = markdownToSpeech('Look at this ![sunset](sunset.jpg) photo');
      expect(result).toContain('sunset');
      expect(result).not.toContain('sunset.jpg');
    });
  });

  describe('list items', () => {
    it('appends period to list item without ending punctuation', () => {
      const result = markdownToSpeech('- Buy groceries');
      expect(result).toBe('Buy groceries.');
    });

    it('does not double-add period to list item ending with period', () => {
      const result = markdownToSpeech('- Already has a period.');
      expect(result).toBe('Already has a period.');
    });

    it('does not append period when list item ends with exclamation mark', () => {
      const result = markdownToSpeech('- Watch out!');
      expect(result).toBe('Watch out!');
    });

    it('does not append period when list item ends with question mark', () => {
      const result = markdownToSpeech('- What is this?');
      expect(result).toBe('What is this?');
    });

    it('does not append period when list item ends with colon', () => {
      const result = markdownToSpeech('- Items include:');
      expect(result).toBe('Items include:');
    });

    it('handles numbered list items', () => {
      const result = markdownToSpeech('1. First item\n2. Second item');
      expect(result).toContain('First item.');
      expect(result).toContain('Second item.');
    });

    it('handles multiple unordered list items', () => {
      const result = markdownToSpeech('- Alpha\n- Beta\n- Gamma');
      expect(result).toContain('Alpha.');
      expect(result).toContain('Beta.');
      expect(result).toContain('Gamma.');
    });
  });

  describe('horizontal rules', () => {
    it('strips --- horizontal rule', () => {
      const result = markdownToSpeech('Above\n\n---\n\nBelow');
      expect(result).not.toContain('---');
      expect(result).toContain('Above');
      expect(result).toContain('Below');
    });

    it('strips *** horizontal rule', () => {
      const result = markdownToSpeech('Above\n\n***\n\nBelow');
      expect(result).not.toContain('***');
    });

    it('strips ___ horizontal rule', () => {
      const result = markdownToSpeech('Above\n\n___\n\nBelow');
      expect(result).not.toContain('___');
    });
  });

  describe('whitespace normalization', () => {
    it('collapses multiple blank lines', () => {
      const result = markdownToSpeech('Line one\n\n\n\n\nLine two');
      // Should not have more than 2 consecutive newlines
      expect(result).not.toMatch(/\n{3,}/);
      expect(result).toContain('Line one');
      expect(result).toContain('Line two');
    });

    it('trims leading and trailing whitespace', () => {
      const result = markdownToSpeech('\n\n  Hello  \n\n');
      expect(result).toBe('Hello');
    });
  });

  describe('HTML tags', () => {
    it('strips simple HTML tags', () => {
      expect(markdownToSpeech('<b>bold</b>')).toBe('bold');
    });

    it('strips self-closing HTML tags', () => {
      const result = markdownToSpeech('Before<br/>After');
      expect(result).not.toContain('<br/>');
      expect(result).toContain('Before');
      expect(result).toContain('After');
    });

    it('strips HTML tags with attributes', () => {
      const result = markdownToSpeech('<div class="fancy">content</div>');
      expect(result).toContain('content');
      expect(result).not.toContain('<div');
      expect(result).not.toContain('</div>');
    });
  });

  describe('tables', () => {
    it('converts table with headers to labeled row text', () => {
      const md = '| Name | Age |\n| --- | --- |\n| John | 30 |';
      const result = markdownToSpeech(md);
      expect(result).toContain('Name: John.');
      expect(result).toContain('Age: 30.');
    });

    it('handles multiple data rows', () => {
      const md = '| Name | Age |\n| --- | --- |\n| John | 30 |\n| Jane | 25 |';
      const result = markdownToSpeech(md);
      expect(result).toContain('Name: John.');
      expect(result).toContain('Age: 30.');
      expect(result).toContain('Name: Jane.');
      expect(result).toContain('Age: 25.');
    });

    it('handles table with header only (no data rows)', () => {
      const md = '| Name | Age |\n| --- | --- |';
      const result = markdownToSpeech(md);
      // With no data rows, there should be no crash and minimal output
      expect(result).not.toContain('undefined');
    });

    it('handles three-column table', () => {
      const md = '| Product | Price | Stock |\n| --- | --- | --- |\n| Widget | $5 | 100 |';
      const result = markdownToSpeech(md);
      expect(result).toContain('Product: Widget.');
      expect(result).toContain('Price: $5.');
      expect(result).toContain('Stock: 100.');
    });
  });

  describe('combined markdown', () => {
    it('processes a message with mixed markdown elements', () => {
      const md = [
        '# Welcome',
        '',
        'This is **important** information.',
        '',
        '- First item',
        '- Second item!',
        '',
        '```js',
        'console.log("hello");',
        '```',
        '',
        'Visit [our docs](https://docs.example.com) for more.',
        '',
        '---',
        '',
        '![logo](logo.png)',
      ].join('\n');

      const result = markdownToSpeech(md);

      // Header stripped
      expect(result).toContain('Welcome');
      expect(result).not.toContain('#');

      // Bold stripped
      expect(result).toContain('important');
      expect(result).not.toContain('**');

      // List items with punctuation
      expect(result).toContain('First item.');
      expect(result).toContain('Second item!');
      expect(result).not.toContain('Second item!.');

      // Code block replaced
      expect(result).toContain('Code block, 1 lines, js.');
      expect(result).not.toContain('console.log');

      // Link text only
      expect(result).toContain('our docs');
      expect(result).not.toContain('https://docs.example.com');

      // Horizontal rule stripped
      expect(result).not.toContain('---');

      // Image with alt text
      expect(result).toContain('logo');
      expect(result).not.toContain('logo.png');
    });
  });
});
