import type { UpdateAvailableEvent, UpdateStatus } from '@pimote/shared';
import { getDismissedUpdateVersion, setDismissedUpdateVersion } from './persistence.js';

export class UpdateStore {
  private statusState: UpdateStatus | null = $state(null);
  private dismissedVersion: string | null = $state(getDismissedUpdateVersion());

  get status(): UpdateStatus | null {
    return this.statusState;
  }

  get showBanner(): boolean {
    return this.statusState !== null && this.dismissedVersion !== this.statusState.latestVersion;
  }

  get showMarker(): boolean {
    return this.statusState !== null;
  }

  handleEvent(event: UpdateAvailableEvent): void {
    this.statusState = {
      currentVersion: event.currentVersion,
      latestVersion: event.latestVersion,
      releaseUrl: event.releaseUrl,
    };
  }

  dismiss(): void {
    const status = this.statusState;
    if (!status) return;

    this.dismissedVersion = status.latestVersion;
    setDismissedUpdateVersion(status.latestVersion);
  }
}

export const updateStore = new UpdateStore();
