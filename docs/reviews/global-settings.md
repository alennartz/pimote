# Review: Global settings

**Plan:** `docs/plans/global-settings.md`
**Diff range:** `453dd20f5d5b85fe93cd4b80fcd09ebf7cf552c7..602e8fd3f2ac301a0c153d2452845935ed93078f`
**Date:** 2026-10-30

## Summary

The fix diff resolves the prior package-reload, extension-host, native-write, editor, catalog, snippet, documentation, and staging findings. The prior folder-walk performance concern remains closed by its earlier dismissal. One lifecycle leak remains in failed extension factories, and the fix duplicates snippet normalization across server and client code.

## Prior Findings Verification

|   # | Result                             | Verification                                                                                                                     |
| --: | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Resolved                           | `server/src/index.ts:365-375` reloads package settings before host discovery.                                                    |
|   2 | Resolved                           | `server/src/pimote-extensions/index.ts:73-101,235-263` catches discovery and Jiti failures and always publishes a fresh runtime. |
|   3 | Resolved                           | `server/src/config-runtime.ts:47,104-119` serializes file writes.                                                                |
|   4 | Resolved                           | `CodeEditorDialog.svelte:202-204` remounts the editor by active path.                                                            |
|   5 | Resolved                           | `README.md:65,131` describes Global Settings and the generic file-edit seam.                                                     |
|   6 | Resolved                           | `tools/manual-test/README.md:657-690` and its smoke script target the Settings gear and manifest.                                |
|   7 | Resolved                           | Codemap, SDK, config, and package metadata describe the Pimote host and source-only SDK.                                         |
|   8 | Resolved                           | `README.md:260-273` and `docs/shipped/folders.md` document the dynamic/startup matrix.                                           |
|   9 | Resolved                           | `packages/sdk/README.md:131` no longer returns the shutdown unsubscribe function.                                                |
|  10 | Resolved                           | `GlobalSettingsDialog.svelte:167-175` resets both CSS `translate` and `transform`.                                               |
|  11 | Resolved                           | `server/src/global-settings.ts:42-49` deduplicates canonical or resolved declared identities.                                    |
|  12 | Resolved                           | Server parsing, runtime snapshots, capabilities, and presentation filter and deduplicate snippets.                               |
|  13 | Dismissed                          | The folder-walk implementation is unchanged, and the prior review explicitly dismissed this concern.                             |
|  14 | Resolved                           | `pimote-extensions/index.ts:155-171,247-256` stages successful registrations and seals failed entries.                           |
|  15 | Resolved for the accepted contract | Shutdown diagnostics now propagate. The contract intentionally has no timeout and requires handlers to settle.                   |

## Findings

### 1. Failed factories discard registered shutdown handlers

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/pimote-extensions/index.ts:248-256`
- **Status:** open
- **Fix:** Run `await entryRuntime.stop()` on factory failure and merge its cleanup diagnostics before sealing the entry.

A factory can register a shutdown handler, allocate a timer or watcher, and then throw. The fix seals the staged entry without running that handler. Registrations no longer leak into the new registry, but resources created before the failure remain active across reloads.

### 2. Snippet normalization is duplicated and silently drops invalid values

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/config.ts:66,171-174`, `server/src/config-runtime.ts:19,78`, `client/src/lib/stores/server-capabilities.svelte.ts:35`, `client/src/lib/components/global-settings-presentation.ts:26`
- **Status:** open
- **Fix:** Make one server-side normalization policy authoritative, reject invalid names during config parsing, and let clients trust the validated capability payload.

The same tag-name rule is copied across server and client paths. The copies can drift. Non-string entries fail validation, but invalid string names are silently removed, so a successful save can change the configured list without telling the user.

## No Issues

- All other prior findings are resolved or explicitly dismissed as shown above.
- The verification passes found no additional plan deviations in the fix diff.
- No other correctness findings were identified in the fix diff.
