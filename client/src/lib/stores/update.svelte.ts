import type { UpdateAvailableEvent, UpdateStatus } from '@pimote/shared';

export class UpdateStore {
  declare readonly status: UpdateStatus | null;
  declare readonly showBanner: boolean;
  declare readonly showMarker: boolean;

  handleEvent(_event: UpdateAvailableEvent): void {
    throw new Error('not implemented');
  }

  dismiss(): void {
    throw new Error('not implemented');
  }
}

export const updateStore = new UpdateStore();
