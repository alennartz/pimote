# Plan: Android App Redesign

## Context

Redesign the three existing Compose screens of the native Android client (`mobile/android/app/src/main/kotlin/com/pimote/android/ui/{setup,contacts,call}`) to match the visual brief in `docs/designs/android-app.md`. The current screens are functional but visually bare — Material3 defaults, emoji as icons, full-width connection banner, debug-log-style in-call screen. The redesign introduces a custom theme system, shared components, and a deliberate visual direction (calm, dark-native, voice-first).

Scope is **all three screens plus the supporting theme/component layer**. No protocol changes, no new module boundaries beyond internal `ui/` reorganization. DR-016 (native Kotlin/Compose), DR-017 (network-layer auth), DR-019 (ContactsContract sync) remain in force and are not touched.

Brainstorm was skipped at the user's direction; the design brief at `docs/designs/android-app.md` plus this plan are the source of truth. Reduced motion / "Remove animations" support is **explicitly out of scope** — animations always run.

## Architecture

### Impacted Modules

**Android Client** is the only impacted module.

- `ui/setup/SetupScreen.kt` — restyled to the brief: typography, palette, outlined text field treatment, in-line connection error surfacing, primary/secondary button variants. ViewModel logic unchanged.
- `ui/contacts/ContactsScreen.kt` — restyled: full-width `ConnectionBanner` replaced with a `StatusPill` (auto-collapsing on Connected), emoji icons replaced with vector drawables, contact rows reshaped to the brief (`ContactRow` component), empty/error states handled by an `EmptyState` component. ViewModel logic unchanged.
- `ui/call/InCallScreen.kt` — substantially restructured into three vertical zones (header / avatar / actions). Replaces the current debug-log column with `AvatarRing` + `CallActionButton`s. ViewModel logic unchanged.

No changes to `app/`, `accounts/`, `contacts/`, `protocol/`, `net/`, `settings/`, `session/`, `telephony/`, `voice/`, or `call/` packages. ViewModels and `AppContainer` wiring are untouched.

### New Modules

Two new internal sub-packages within the existing Android Client module:

- **`ui/theme/`** — Pimote design tokens and the `PimoteTheme` Composable wrapper. Owns palette, typography, and spacing tokens. Wraps Material3's `MaterialTheme` (so `MaterialTheme.colorScheme.primary` etc. still works for the small set of slots that map cleanly: `primary` = Indigo, `error` = Danger, `background` = Void, `surface` = Surface) and adds parallel `PimoteColors` / `PimoteTypography` / `PimoteSpacing` via `CompositionLocal` for the semantics Material3 doesn't model (`active`, `warning`, `idle`, `surfacePlus`, `inkSecondary`, `inkDisabled`, `mono14`, `mono12`, `callDisplay`, the 4–64 dp spacing scale).

- **`ui/components/`** — shared composables consumed by all three screens: `StatusPill`, `ContactRow`, `EmptyState`, `AvatarRing`, `PimoteButton`, `PimoteOutlinedTextField`, `PimoteSnackbar`. Each is theme-driven (reads from `PimoteTheme`) and stateless w.r.t. app state — they take parameters and emit callbacks.

Fonts (`Inter-Variable.ttf`, `JetBrainsMono-Variable.ttf`) live under `app/src/main/assets/fonts/` (or `res/font/` — implementer's call). Icon vector drawables live under `app/src/main/res/drawable/` as `ic_*.xml`.

### Interfaces

#### Theme

```kotlin
// ui/theme/PimoteColors.kt
@Immutable
data class PimoteColors(
    val void: Color,           // #0D0F14 — primary background
    val surface: Color,        // #161922 — elevated surface
    val surfacePlus: Color,    // #1E222E — tertiary surface
    val scrim: Color,          // rgba(0,0,0,0.6)
    val ink: Color,            // #E4E8F2 — primary text
    val inkSecondary: Color,   // #7D8699
    val inkDisabled: Color,    // #3D4252
    val line: Color,           // #252934
    val indigo: Color,         // #7B9FFF — interactive accent
    val active: Color,         // #4DC896 — connected/alive
    val warning: Color,        // #F0B34C
    val danger: Color,         // #F26B6B
    val idle: Color,           // #5A6070
)

// ui/theme/PimoteTypography.kt
@Immutable
data class PimoteTypography(
    val callDisplay: TextStyle,  // 32sp/40sp Inter 400, tracking -0.5
    val titleLarge: TextStyle,   // 22sp/28sp Inter 600
    val titleMedium: TextStyle,  // 18sp/24sp Inter 600
    val bodyLarge: TextStyle,    // 16sp/24sp Inter 400
    val bodyMedium: TextStyle,   // 14sp/20sp Inter 400
    val bodySmall: TextStyle,    // 12sp/16sp Inter 400
    val labelMedium: TextStyle,  // 12sp/16sp Inter 600, tracking 0.4
    val mono14: TextStyle,       // 14sp/20sp JetBrains Mono 400
    val mono12: TextStyle,       // 12sp/16sp JetBrains Mono 400
)

// ui/theme/PimoteSpacing.kt
@Immutable
data class PimoteSpacing(
    val xs: Dp,   // 4
    val s: Dp,    // 8
    val sm: Dp,   // 12
    val m: Dp,    // 16
    val ml: Dp,   // 20  (content padding)
    val l: Dp,    // 24
    val xl: Dp,   // 32
    val xxl: Dp,  // 48
    val xxxl: Dp, // 64
)

// ui/theme/PimoteTheme.kt
object PimoteTheme {
    val colors: PimoteColors @Composable get() = LocalPimoteColors.current
    val typography: PimoteTypography @Composable get() = LocalPimoteTypography.current
    val spacing: PimoteSpacing @Composable get() = LocalPimoteSpacing.current
}

@Composable
fun PimoteTheme(content: @Composable () -> Unit)
```

`PimoteTheme` builds the Material3 `ColorScheme` from the brief's palette (mapping `primary` → indigo, `error` → danger, `background` → void, `surface` → surface, `onSurface` → ink, `onSurfaceVariant` → inkSecondary) and provides the three `CompositionLocal`s. Default Material3 `Typography` is also overridden to use Inter throughout so untouched Material widgets render correctly.

#### Components

All components are stateless presentation primitives. Behavioral state (connection state, mute, etc.) flows in via parameters; user actions exit via callbacks.

```kotlin
// ui/components/StatusPill.kt
sealed interface StatusPillState {
    data object Connected : StatusPillState
    data object Connecting : StatusPillState
    data class Reconnecting(val attempt: Int) : StatusPillState
    data class Failed(val reason: String) : StatusPillState
    data object Disconnected : StatusPillState
}

@Composable
fun StatusPill(
    state: StatusPillState,
    onTap: () -> Unit = {},  // tapping Failed/Disconnected scrolls to settings
    modifier: Modifier = Modifier,
)
```

Behavioral expectations: when `state == Connected`, the pill renders expanded for 3 seconds then collapses to a 6dp dot. Any state change from Connected back to a non-Connected state re-expands. Tapping the collapsed dot expands to the full pill for 3s then collapses again. Reason text is truncated to 40 chars with ellipsis; the `ws error:` prefix is stripped before display. The collapse-after-3s timer is internal to the component.

```kotlin
// ui/components/ContactRow.kt
@Composable
fun ContactRow(
    title: String,
    subtitle: String,
    kind: ContactKind,           // Project | Session
    isLoading: Boolean = false,  // post-tap spinner state
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
)

enum class ContactKind { Project, Session }
```

Behavioral expectations: 72dp minimum row height. Leading icon at 24dp tinted indigo (`ic_folder_outlined` for Project, `ic_chat_bubble_outlined` for Session). When `isLoading` is true, the leading icon is replaced by a 20dp `CircularProgressIndicator` in indigo. Press feedback is a 100ms background flash to `surfacePlus`. Trailing 16dp chevron. Long titles truncate with ellipsis; max 60 chars before truncation. Full-row click target.

```kotlin
// ui/components/EmptyState.kt
@Composable
fun EmptyState(
    icon: Painter,
    primary: String,
    secondary: String,
    cta: EmptyStateCta? = null,
    iconAnimating: Boolean = false,  // for Connecting/Reconnecting sync icon
    modifier: Modifier = Modifier,
)

data class EmptyStateCta(val label: String, val onClick: () -> Unit)
```

Behavioral expectations: full-screen centered column. 48dp icon (idle color unless caller passes a tinted painter). 4dp gap, primary in `bodyLarge` (ink), 8dp gap, secondary in `bodyMedium` (inkSecondary), 16dp gap, optional secondary-variant button. When `iconAnimating == true`, icon rotates continuously (1200ms linear).

```kotlin
// ui/components/AvatarRing.kt
sealed interface AvatarRingState {
    data class Connecting(val phaseLabel: String) : AvatarRingState  // dashed rotating arc
    data class Active(val durationSeconds: Long) : AvatarRingState   // solid pulsing ring
    data object EndedOk : AvatarRingState                            // static idle ring
    data class EndedError(val reason: String) : AvatarRingState      // static danger ring
}

@Composable
fun AvatarRing(
    monogram: String,            // first letter, uppercased
    state: AvatarRingState,
    isMuted: Boolean = false,    // shows a small mic_off badge below the ring
    modifier: Modifier = Modifier,
)
```

Behavioral expectations: 120dp circle, `surfacePlus` fill, 2dp ring stroke. Connecting → dashed-stroke arc rotating 360° per 1200ms. Active → solid indigo ring with scale 1.00↔1.06 and opacity 1.00↔0.65 on a 2400ms ease-in-out loop. EndedOk → static idle. EndedError → static danger. Center: monogram in `callDisplay` style, `inkSecondary`. Below the ring (within the same composable): phase label (Connecting), duration counter `MM:SS` in `mono14` active color (Active), or reason in `bodySmall` danger (EndedError). When `isMuted`, a 12dp `ic_mic_off` warning-tinted badge appears below the ring/label group.

```kotlin
// ui/components/PimoteButton.kt
enum class PimoteButtonVariant { Primary, Secondary, Destructive, Ghost }

@Composable
fun PimoteButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: PimoteButtonVariant = PimoteButtonVariant.Primary,
    enabled: Boolean = true,
    isLoading: Boolean = false,  // shows leading 16dp spinner; label may change to e.g. "Connecting…"
    leadingIcon: Painter? = null,
)
```

Behavioral expectations: 52dp height, 12dp corner radius, 24dp horizontal padding, label in `labelMedium`. Variant maps to brief's color spec. Pressed state: 16% ink overlay + 0.98 scale at 100ms. Disabled at 0.38 opacity. When `isLoading` is true, leading icon is replaced by a 16dp progress indicator and the button keeps its width (no layout jump).

```kotlin
// ui/components/PimoteOutlinedTextField.kt
@Composable
fun PimoteOutlinedTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isError: Boolean = false,
    errorMessage: String? = null,
    singleLine: Boolean = true,
)
```

Behavioral expectations: thin wrapper around Material3 `OutlinedTextField` with the brief's specified colors and 12dp corner radius. Error state: 2dp danger border + danger floating label + danger helper text below. Helper text only renders when `isError && errorMessage != null`.

```kotlin
// ui/components/PimoteSnackbar.kt
enum class PimoteSnackbarVariant { Error, Info }

@Composable
fun PimoteSnackbarHost(
    hostState: SnackbarHostState,
    variant: PimoteSnackbarVariant = PimoteSnackbarVariant.Info,
    modifier: Modifier = Modifier,
)
```

Behavioral expectations: floating pill, 16dp margin from screen edges, 12dp radius, 52dp height, `surfacePlus` background with 1dp `line` stroke. Error variant has a leading 16dp `ic_error_outline` in danger; info has no leading icon. 4-second auto-dismiss (Material default).

#### Screen-level behavior preserved from current implementation

The screens' ViewModels and the data they observe (`SetupViewModel.current`, `wsState`, `ContactsViewModel.projects/sessions/wsState`, the `CallController.state` flow that drives `InCallScreen`) are unchanged. The redesign only restyles the rendering layer and reorganizes layout — no behavioral semantics change.

### Technology Choices

- **Theme structure: Extended theme via `CompositionLocal`** — `MaterialTheme` wrapped + sibling `PimoteTheme` for non-Material semantics (`active`, `warning`, `idle`, surface ladder, mono typography). Standard pattern in Now in Android, Tivi, Catalyst. Considered shoehorning everything into Material3's `ColorScheme` (mapping `Active` → `tertiary`, etc.) but rejected: the names would lie and the surface ladder + mono typography don't fit Material3's slots at all.

- **Font delivery: bundled variable fonts** — `Inter-Variable.ttf` and `JetBrainsMono-Variable.ttf` shipped in the APK (~700KB combined). Considered Google Fonts downloadable provider (zero APK weight but flaky on degoogled phones, network-dependent first launch) and accepting Roboto fallback (free but loses the geometric/dev-tool feel). The audience is small and self-hosting; bundle cost is negligible relative to the WebRTC dependency already shipped.

- **Icon source: hand-imported vector drawables** — only ~10 icons used (`folder_outlined`, `chat_bubble_outlined`, `mic_outlined`, `mic_off`, `call_end`, `call_outlined`, `dashboard_outlined`, `sync`, `signal_wifi_bad`, `wifi_off`, `error_outline`). Sourced from Google Fonts Material Symbols, dropped into `res/drawable/` as `ic_*.xml`. Rejected `androidx.compose.material:material-icons-extended` because R8 historically does not strip it well (~10MB unstripped) and the icon list is short and stable.

### Out of Scope (Explicit Non-Goals)

- **Reduced motion / "Remove animations" support.** Animations always run regardless of system settings. The brief's reduced-motion language is intentionally not implemented.
- **App icon / launcher icon.** No brand assets exist; out of scope for this redesign. Leave the existing launcher icon untouched.
- **Light theme.** Brief specifies dark as primary and gives a light translation, but the redesign ships dark-only. If a future change adds light theme, the palette is documented in the brief.
- **Incoming-call UI.** v1 is outgoing-only; the brief notes this explicitly. No `CallStyle` notification work in this redesign.
- **Dynamic type scaling.** Fixed sp values per the brief.
