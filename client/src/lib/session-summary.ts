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
