import type { PimoteResponse } from '@pimote/shared';

/** The client cancelled a placeholder while its open request was still in flight. */
export function isSessionOpenCancelledResponse(response: Pick<PimoteResponse, 'success' | 'error'>): boolean {
  return response.success === false && response.error === 'session_open_cancelled';
}
