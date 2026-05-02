# DR-020: Android Extended Theme via CompositionLocal Alongside Material3

## Status

Accepted

## Context

The Pimote Android client (DR-016) needed a custom visual identity beyond Material3 defaults: a calm, dark-native, voice-first look with a deliberate four-tier surface ladder (`void`/`surface`/`surfacePlus`), state-semantic colors (`active`, `warning`, `idle`) that don't correspond to Material3 roles, and a parallel monospaced type scale (`mono14`, `mono12`, `callDisplay`) that Material3's `Typography` slots don't accommodate.

Material3 expects every theme token to land in a fixed set of slots (`primary`, `secondary`, `tertiary`, `error`, `surface`, etc.). Pimote's design has more semantic categories than slots, and its surface ladder is wider than Material3's `surface` / `surfaceVariant` pairing.

## Decision

Wrap `MaterialTheme` and provide a parallel `PimoteTheme` exposing `PimoteColors`, `PimoteTypography`, and `PimoteSpacing` through `CompositionLocal`. Map the slots that fit cleanly into Material3's `ColorScheme` (`primary` → indigo, `error` → danger, `background` → void, `surface` → surface, `onSurface` → ink, `onSurfaceVariant` → inkSecondary) so untouched Material widgets render correctly, and override the default `Typography` to Inter throughout. Pimote-specific tokens (`active`, `warning`, `idle`, `surfacePlus`, mono fonts, the 4–64dp spacing scale) are accessed via `PimoteTheme.*` instead.

Rejected: shoehorning everything into Material3's `ColorScheme` by mapping `active` → `tertiary`, `warning` → some unused slot, etc. The slot names would lie about what the colors mean, the surface ladder still wouldn't fit, and mono typography has no Material3 home at all.

This is the pattern used by Now in Android, Tivi, and Catalyst — it's the standard escape hatch for design systems that exceed Material3's vocabulary.

## Consequences

- Every Pimote composable picks between `MaterialTheme.*` and `PimoteTheme.*` tokens. Authors must know which is which; mistakes (e.g. using `MaterialTheme.colorScheme.tertiary` when meaning `active`) compile but render wrong.
- The `LocalPimoteColors`/`LocalPimoteTypography`/`LocalPimoteSpacing` defaults throw if read outside a `PimoteTheme` wrapper — root composables (`MainActivity.setContent`, `InCallActivity.setContent`) must each wrap their content.
- Material widgets used unwrapped (e.g. `OutlinedTextField`, `Snackbar`) inherit only the slots that were mapped; Pimote-specific styling requires the `PimoteOutlinedTextField` / `PimoteSnackbar` wrappers.
- If a future change adds a light theme, both the Material3 `ColorScheme` and the `PimoteColors` instance need light variants — they're independent.
