import 'katex/dist/katex.min.css';

type KatexModule = typeof import('katex');

let katexModule: KatexModule | null = null;
let katexLoading: Promise<KatexModule> | null = null;

/** Load KaTeX only when the first equation closes. */
function ensureKatex(): Promise<KatexModule> {
  if (katexModule) return Promise.resolve(katexModule);

  katexLoading ??= import('katex')
    .then((module) => {
      katexModule = module;
      return module;
    })
    .catch((error: unknown) => {
      katexLoading = null;
      throw error;
    });

  return katexLoading;
}

export interface MathRenderer {
  render(node: HTMLElement, displayMode: boolean): void;
  dispose(): void;
}

/**
 * Render completed streaming-markdown equation nodes without touching open
 * equations. KaTeX replaces the node contents only after the parser closes it.
 */
export function createMathRenderer(): MathRenderer {
  const lifecycle = { disposed: false };

  return {
    render(node, displayMode) {
      const source = node.textContent ?? '';
      void ensureKatex()
        .then(({ default: katex }) => {
          if (lifecycle.disposed) return;

          try {
            katex.render(source, node, {
              displayMode,
              throwOnError: false,
              trust: false,
              maxExpand: 1000,
              maxSize: 1000,
            });
          } catch {
            // Keep the source text readable if KaTeX itself fails unexpectedly.
          }
        })
        .catch(() => {
          // Keep the source text readable if the optional math chunk fails to load.
        });
    },
    dispose() {
      lifecycle.disposed = true;
    },
  };
}
