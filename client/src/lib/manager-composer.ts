/** Minimal facts about the conversation currently on screen. */
export interface SessionView {
  sessionId: string;
}

export type ManagerComposerAction = { action: 'continue'; sessionId: string } | { action: 'open-new' };

/** Continue only the viewed manager session. Landing or a code session opens
 * a new manager session. Hidden, previously open sessions are not resumed. */
export function managerComposerAction(_viewed: SessionView | undefined, _viewedIsManager: boolean): ManagerComposerAction {
  throw new Error('not implemented');
}
