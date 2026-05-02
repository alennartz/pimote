# DR-022: Hand-Imported Vector Drawables Over `material-icons-extended`

## Status

Accepted

## Context

The Android redesign uses about ten Material Symbol icons (`folder_outlined`, `chat_bubble_outlined`, `mic_outlined`, `mic_off`, `call_end`, `call_outlined`, `dashboard_outlined`, `sync`, `signal_wifi_bad`, `wifi_off`, `error_outline`). The icon list is short and stable across the three screens.

`androidx.compose.material:material-icons-extended` provides every Material Symbol as a Compose `ImageVector` constant, but the artifact is large and historically R8 has not stripped unused icons reliably — apps shipping it have measured ~10MB of unstripped icon code in release builds.

## Decision

Source each icon individually from Google Fonts Material Symbols (Outlined, weight 400, grade 0, optical size 24), export as Android Vector Drawable XML, and check the files in under `app/src/main/res/drawable/` as `ic_*.xml`. Load with `painterResource(R.drawable.ic_<name>)`.

Rejected: depending on `material-icons-extended` permanently. The R8 stripping issue is well-known and the icon set is small and stable enough that the manual maintenance cost is lower than the APK-size risk.

## Consequences

- Adding or replacing an icon means re-exporting an XML from Material Symbols and committing it — a manual step, but it's also the moment to confirm the icon actually fits the visual brief.
- No risk of bloating the APK with thousands of unused icon constants.
- The drawable list lives in source control; `git blame` shows when each icon was added and why.
- Icon file naming follows the `ic_<symbol_name>.xml` convention (snake_case) — Android resource filename rules force this regardless.
