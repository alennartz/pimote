import type { RestoreMode } from '@pimote/shared';

export function getRestoreModeLabel(mode: RestoreMode | null | undefined): string | null {
  switch (mode) {
    case 'incremental_replay':
      return 'Replaying from offset';
    case 'full_resync_cursor_stale':
      return 'Full resync (offset too old)';
    case 'disk_full_resync':
      return 'Reopening from disk';
    case 'full_resync_no_cursor':
      return 'Full resync';
    default:
      return null;
  }
}
