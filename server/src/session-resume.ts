import type { ExtensionAPI, ExtensionContext, ExtensionFactory, SessionEntry } from '@earendil-works/pi-coding-agent';

/** Custom entry that records a turn the agent finished on its own terms. */
export const SESSION_IDLE_MARKER = 'session-idle';
/** Custom message that starts the continuation turn of an interrupted session. */
export const SESSION_RESUME_MESSAGE = 'session-resumed';

const RESUME_TEXT = '[session resumed]';

export interface CreateSessionResumeExtensionOptions {
  /**
   * True while pimote tears runtimes down mid-turn, as during server shutdown.
   * The abort pi records then is pimote's own interruption, so the transcript
   * must stay resumable instead of ending on an idle marker.
   */
  isRuntimeTeardown: () => boolean;
}

/**
 * Whether the branch ends on a finished turn. A process that died mid-turn
 * leaves the last message as the branch tip, so the session earns one
 * continuation turn when it loads again.
 */
function endsWithIdleMarker(ctx: ExtensionContext): boolean {
  const branch: SessionEntry[] = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === 'custom' && entry.customType === SESSION_IDLE_MARKER) return true;
    // User-initiated !/!! bash results belong to the user, not to a run.
    if (entry.type === 'message' && entry.message.role === 'bashExecution') continue;
    if (entry.type === 'message' || entry.type === 'custom_message') return false;
  }
  return true;
}

/** Resume sessions that load after an interruption. */
export function createSessionResumeExtension(options: CreateSessionResumeExtensionOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on('agent_end', async () => {
      if (options.isRuntimeTeardown()) return;
      pi.appendEntry(SESSION_IDLE_MARKER, { at: new Date().toISOString() });
    });

    pi.on('session_start', async (_event, ctx) => {
      if (!ctx.sessionManager.getSessionFile()) return;
      if (ctx.sessionManager.getEntries().length === 0) return;
      if (endsWithIdleMarker(ctx)) return;

      pi.sendMessage({ customType: SESSION_RESUME_MESSAGE, content: RESUME_TEXT, display: false }, { triggerTurn: true });
    });
  };
}
