export interface ViewportSource {
  innerHeight: number;
  visualViewport?: { height: number } | null;
}

export function resolveAppViewportHeight({ innerHeight, visualViewport }: ViewportSource): string {
  const visualViewportHeight = visualViewport?.height;
  const height = typeof visualViewportHeight === 'number' && Number.isFinite(visualViewportHeight) && visualViewportHeight > 0 ? visualViewportHeight : innerHeight;
  return `${Math.round(height)}px`;
}
