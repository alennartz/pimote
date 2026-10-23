export interface SessionSummarySource {
  extensionTitle?: string | null;
  sessionName?: string | null;
  firstMessage?: string | undefined;
  contextUsage?: {
    percent: number | null;
    contextWindow: number;
  } | null;
}

export function getSessionDisplayName(session: SessionSummarySource | null | undefined): string | null {
  if (!session) return null;
  if (session.extensionTitle) return session.extensionTitle;
  if (session.sessionName) return session.sessionName;
  if (session.firstMessage) {
    return session.firstMessage.length > 60 ? session.firstMessage.slice(0, 60) + '…' : session.firstMessage;
  }
  return null;
}

/** Total character budget for an open-session chip label. */
export const SESSION_CHIP_BUDGET = 12;

export interface SessionChipSource extends SessionSummarySource {
  projectName?: string | null;
}

function capToChipBudget(text: string): string {
  const capped = text.length > SESSION_CHIP_BUDGET ? text.slice(0, SESSION_CHIP_BUDGET) : text;
  return capped.trimEnd();
}

/**
 * Compact label for an open-session chip.
 * - An explicit name (extension title or session name) is shown as-is when it
 *   fits the budget, otherwise truncated to it.
 * - Without an explicit name, a short first message is shown as-is.
 * - Otherwise the label is `{projectName}-{first message prefix}` within the
 *   12-char budget total: the first message gets as many characters as fit.
 *   The project name yields at least one character to the message so sessions
 *   in the same project stay distinguishable.
 */
export function getSessionChipLabel(session: SessionChipSource | null | undefined): string | null {
  if (!session) return null;

  const explicit = session.extensionTitle || session.sessionName;
  if (explicit) return capToChipBudget(explicit);

  const resolved = getSessionDisplayName(session);
  if (resolved != null && resolved.length < SESSION_CHIP_BUDGET) return resolved;

  const message = session.firstMessage ?? '';
  const base = session.projectName ?? '';
  if (!base) return message ? capToChipBudget(message) : null;
  if (!message) return capToChipBudget(base);

  const head = base.slice(0, SESSION_CHIP_BUDGET - 2);
  return `${head}-${message.slice(0, SESSION_CHIP_BUDGET - head.length - 1)}`.trimEnd();
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

export function getContextDisplay(session: SessionSummarySource | null | undefined, opts: { compact?: boolean } = {}): string | null {
  const percent = session?.contextUsage?.percent;
  const contextWindow = session?.contextUsage?.contextWindow ?? 0;

  if (opts.compact) {
    if (percent != null) return `${Math.round(percent)}%`;
    if (contextWindow > 0) return formatTokenCount(contextWindow);
    return null;
  }

  if (percent != null) return `${percent.toFixed(1)}%/${formatTokenCount(contextWindow)}`;
  if (contextWindow > 0) return `?/${formatTokenCount(contextWindow)}`;
  return null;
}

export function getContextTone(percent: number | null | undefined): 'normal' | 'warning' | 'critical' {
  if (percent != null && percent > 90) return 'critical';
  if (percent != null && percent > 70) return 'warning';
  return 'normal';
}
