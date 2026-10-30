import type { PimoteExtensionHost, PimoteExtensionHostOptions } from './types.js';

export type {
  PimoteConfiguredPackage,
  PimoteExtensionDiagnostic,
  PimoteExtensionHost,
  PimoteExtensionHostOptions,
  PimoteExtensionModule,
  PimoteExtensionRegistry,
  PimotePackageManager,
  PimotePackageScope,
} from './types.js';

/**
 * Construct the process-global Pimote extension host.
 *
 * The implementation owns discovery, jiti loading, registration context
 * invalidation, shutdown handlers, module-cache reset, diagnostics, and
 * serialized replacement. This phase exposes only the seam.
 */
export function createPimoteExtensionHost(_options: PimoteExtensionHostOptions): PimoteExtensionHost {
  throw new Error('not implemented');
}
