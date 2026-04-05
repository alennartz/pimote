import { describe, expect, it } from 'vitest';
import { widgetLinesToCard } from './widget-cards.js';

describe('widgetLinesToCard', () => {
  it('uses the first line as title when multiple lines are present', () => {
    expect(widgetLinesToCard('build-status', ['Build status', 'Passed', '42 tests'])).toEqual({
      id: 'widget:build-status',
      header: { title: 'Build status' },
      body: [
        { content: 'Passed', style: 'text' },
        { content: '42 tests', style: 'text' },
      ],
    });
  });

  it('falls back to the key as title for single-line widgets', () => {
    expect(widgetLinesToCard('widget-a', ['Only body line'])).toEqual({
      id: 'widget:widget-a',
      header: { title: 'widget-a' },
      body: [{ content: 'Only body line', style: 'text' }],
    });
  });

  it('renders all body lines uniformly as text', () => {
    expect(widgetLinesToCard('diff', ['Result', '  const x = 1;'])).toEqual({
      id: 'widget:diff',
      header: { title: 'Result' },
      body: [{ content: '  const x = 1;', style: 'text' }],
    });
  });
});
