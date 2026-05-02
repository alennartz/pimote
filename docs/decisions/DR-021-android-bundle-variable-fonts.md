# DR-021: Bundle Variable Fonts in the Android APK

## Status

Accepted

## Context

The Android client redesign requires Inter (UI) and JetBrains Mono (mono / call-display / status-pill numerics) to land its visual identity. The audience for the native app skews self-hosted and includes degoogled / GrapheneOS-style devices where Google Play Services is unreliable or absent.

## Decision

Ship `Inter-Variable.ttf` and `JetBrainsMono-Variable.ttf` (~700KB combined) inside the APK under `res/font/`, loaded via `Font(R.font.inter_variable, variationSettings = ...)` from the `PimoteTypography` declarations.

Rejected:

- **Google Fonts downloadable provider** (zero APK weight). Network-dependent first launch, and the provider depends on Google Play Services — unreliable on the degoogled portion of the audience. Wrong fit when the app's posture is self-hosted and offline-tolerant.
- **Roboto fallback only** (free, default). Loses the geometric / dev-tool feel the brief calls for; Pimote's identity is not Material default.

## Consequences

- ~700KB permanent APK overhead. Negligible relative to the WebRTC dependency already shipped, and the audience is small.
- First launch renders the correct fonts immediately; no FOIT/FOUT on cold start.
- Updating the fonts means re-downloading the upstream variable TTFs and bumping the resources — a manual step, but rare.
- Variable axes (weight) are exercised through `fontVariationSettings`; switching to static font files later would require regenerating the type ramp.
