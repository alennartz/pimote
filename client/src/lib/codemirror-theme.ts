import type { Extension } from '@codemirror/state';
import type { ResolvedTheme } from '@pimote/shared';

/** Create an editor theme that can be installed or reconfigured in a CodeMirror compartment. */
export function createCodeMirrorTheme(_theme: ResolvedTheme): Extension {
  throw new Error('not implemented');
}
