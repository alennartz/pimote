import type { Card } from '@pimote/shared';

export function widgetLinesToCard(key: string, lines: string[]): Card {
  const cleaned = lines.map((line) => line.trimEnd());
  const firstNonEmpty = cleaned.find((line) => line.trim().length > 0);

  const title = firstNonEmpty && cleaned.length > 1 ? firstNonEmpty.trim() : key;
  const bodySource = firstNonEmpty && cleaned.length > 1 ? cleaned.slice(cleaned.indexOf(firstNonEmpty) + 1) : cleaned;
  const body = bodySource
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      content: line,
      style: 'text' as const,
    }));

  return {
    id: `widget:${key}`,
    header: { title },
    body,
  };
}
