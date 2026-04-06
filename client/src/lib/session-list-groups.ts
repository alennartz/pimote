import type { FolderInfo, SessionInfo } from '@pimote/shared';

export interface SessionProjectGroup {
  folder: FolderInfo;
  sessions: SessionInfo[];
  lastModified: string;
}

function toTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareSessionsByRecency(a: SessionInfo, b: SessionInfo): number {
  return toTimestamp(b.modified) - toTimestamp(a.modified) || toTimestamp(b.created) - toTimestamp(a.created) || a.id.localeCompare(b.id);
}

export function buildSessionProjectGroups(folders: FolderInfo[], sessionsByFolder: ReadonlyMap<string, SessionInfo[]>): SessionProjectGroup[] {
  return folders
    .map((folder) => {
      const sessions = [...(sessionsByFolder.get(folder.path) ?? [])].sort(compareSessionsByRecency);
      if (sessions.length === 0) return null;

      return {
        folder,
        sessions,
        lastModified: sessions[0].modified,
      } satisfies SessionProjectGroup;
    })
    .filter((group): group is SessionProjectGroup => group !== null)
    .sort((a, b) => toTimestamp(b.lastModified) - toTimestamp(a.lastModified) || a.folder.name.localeCompare(b.folder.name));
}
