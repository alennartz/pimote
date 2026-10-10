/** Minimal facts about the conversation currently on screen. */
export interface SessionView {
  sessionId: string;
}

export type ManagerComposerAction = { action: 'continue'; sessionId: string } | { action: 'open-new' };

/** Continue only the viewed manager session. Landing or a code session opens
 * a new manager session. Hidden, previously open sessions are not resumed. */
export function managerComposerAction(viewed: SessionView | undefined, viewedIsManager: boolean): ManagerComposerAction {
  if (viewed !== undefined && viewedIsManager) return { action: 'continue', sessionId: viewed.sessionId };
  return { action: 'open-new' };
}

/** Optimistic placeholder ids (`pending-*`) are client-local fictions the
 *  server can never resolve — never address one as a prompt target. */
function isPlaceholderSessionId(sessionId: string): boolean {
  return sessionId.startsWith('pending-');
}

/** Outcome of the ordinary `open_session` command at the manager root. */
export interface OpenedManagerSession {
  success: boolean;
  sessionId?: string;
}

/** Ordinary session seams the shared submit operation drives. One operation
 *  serves every manager-area entry control; callers supply the ports. */
export interface ManagerSubmitPorts {
  /** Ordinary `open_session` at `managerRoot`; resolves the server-confirmed outcome. */
  openManagerSession(managerRoot: string): Promise<OpenedManagerSession>;
  /** Ordinary `prompt` to a session; true when the server admits it. */
  prompt(sessionId: string, message: string): Promise<boolean>;
  /** Bring the session on screen through the existing session registry. */
  switchToSession(sessionId: string): void;
}

/** The manager area's one submit operation. Passes the current view and
 *  manager identity to `managerComposerAction`, then either prompts the viewed
 *  manager session or opens a new session at `managerRoot` and prompts that.
 *  Resolves true once the prompt is admitted so the caller may clear the draft;
 *  any rejection keeps it. Never prompts a placeholder id and never selects a
 *  historical manager session. */
export async function submitManagerMessage(
  input: { viewed: SessionView | undefined; viewedIsManager: boolean; managerRoot: string; text: string },
  ports: ManagerSubmitPorts,
): Promise<boolean> {
  const message = input.text.trim();
  if (!message || !input.managerRoot) return false;

  const action = managerComposerAction(input.viewed, input.viewedIsManager);
  if (action.action === 'continue') {
    if (isPlaceholderSessionId(action.sessionId)) return false;
    return ports.prompt(action.sessionId, message);
  }

  const opened = await ports.openManagerSession(input.managerRoot);
  // Only the id the server confirmed is real — no placeholder, no guess.
  if (!opened.success || !opened.sessionId || isPlaceholderSessionId(opened.sessionId)) return false;
  const sent = await ports.prompt(opened.sessionId, message);
  if (sent) ports.switchToSession(opened.sessionId);
  return sent;
}
