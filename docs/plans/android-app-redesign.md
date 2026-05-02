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

## Tests

> **Skipped.** No tests were written upfront. Follow red-green TDD as you implement —
> write a focused failing test, make it pass, move on. Aim for component-boundary
> behavioral tests (inputs, outputs, observable effects), not exhaustive coverage.
>
> For this redesign specifically: the bulk is Compose styling and layout, which is
> not where behavioral tests pay off. Concentrate tests on the pure helpers that
> emerge — e.g. status-pill reason-string cleanup (`ws error:` prefix strip + 40-char
> truncation), avatar-ring state derivation from `CallController.State`, and any
> duration/format helpers extracted along the way. Keep them in `app/src/test/` as
> plain JUnit tests next to existing ones.

## Steps

**Pre-implementation commit:** `01d6594b10ce33c32e03099cbebfc6c7a4601fbb`

### Step 1: Add bundled font files

Source the two variable fonts and place them under `app/src/main/res/font/`:

- `inter_variable.ttf` — download from https://github.com/rsms/inter/releases (latest stable, `InterVariable.ttf`)
- `jetbrainsmono_variable.ttf` — download from https://github.com/JetBrains/JetBrainsMono/releases (latest stable, `JetBrainsMono[wght].ttf`)

Android `res/font/` filenames must be lowercase with underscores only. Rename on copy. No Gradle change needed — Compose loads these via `FontFamily(Font(R.font.inter_variable, variationSettings = ...))` in the theme step.

**Verify:** Both `.ttf` files appear under `app/src/main/res/font/`. `./gradlew :app:compileDebugKotlin` succeeds (no resource error).
**Status:** done

---

### Step 2: Add icon vector drawables

Create the following 11 files under `app/src/main/res/drawable/`, sourced from [Google Fonts Material Symbols](https://fonts.google.com/icons) (Outlined style, weight 400, grade 0, optical size 24). Export each as an Android Vector Drawable XML and rename to the `ic_` convention:

| File                          | Material Symbol name |
| ----------------------------- | -------------------- |
| `ic_folder_outlined.xml`      | Folder (Outlined)    |
| `ic_chat_bubble_outlined.xml` | Chat Bubble Outline  |
| `ic_mic_outlined.xml`         | Mic (Outlined)       |
| `ic_mic_off.xml`              | Mic Off              |
| `ic_call_end.xml`             | Call End             |
| `ic_call_outlined.xml`        | Call (Outlined)      |
| `ic_dashboard_outlined.xml`   | Dashboard (Outlined) |
| `ic_sync.xml`                 | Sync                 |
| `ic_signal_wifi_bad.xml`      | Signal Wifi Bad      |
| `ic_wifi_off.xml`             | Wifi Off             |
| `ic_error_outline.xml`        | Error Outline        |

Alternatively: use the Material Icons Extended artifact temporarily for prototyping, then replace with hand-imported XMLs before final build. The architecture rejects `material-icons-extended` as a permanent dependency (R8 stripping issue), so XMLs are required for the final state.

**Verify:** All 11 `ic_*.xml` files exist under `drawable/`. `./gradlew :app:compileDebugKotlin` succeeds. Loading any icon with `painterResource(R.drawable.ic_folder_outlined)` in a Preview composable renders correctly.
**Status:** done

---

### Step 3: Create theme data classes

Create three new files in `app/src/main/kotlin/com/pimote/android/ui/theme/`:

**`PimoteColors.kt`** — `@Immutable data class PimoteColors(...)` with all 13 tokens from the architecture's `PimoteColors` interface (exact field names and hex values as specified).

**`PimoteTypography.kt`** — `@Immutable data class PimoteTypography(...)` with 9 `TextStyle` fields: `callDisplay`, `titleLarge`, `titleMedium`, `bodyLarge`, `bodyMedium`, `bodySmall`, `labelMedium`, `mono14`, `mono12`. Each is a `TextStyle` instance with `fontSize`, `lineHeight`, `fontWeight`, `letterSpacing` filled from the brief's type table. Font families are placeholder `FontFamily.Default` at this step (wired to Inter/JetBrains Mono in Step 4).

**`PimoteSpacing.kt`** — `@Immutable data class PimoteSpacing(...)` with 9 `Dp` fields: `xs=4.dp`, `s=8.dp`, `sm=12.dp`, `m=16.dp`, `ml=20.dp`, `l=24.dp`, `xl=32.dp`, `xxl=48.dp`, `xxxl=64.dp`.

No `CompositionLocal` wiring yet — that happens in Step 4.

**Verify:** All three files compile. Each data class can be instantiated in a unit test or Preview with default values.
**Status:** done

---

### Step 4: Create PimoteTheme composable and CompositionLocals

Create `app/src/main/kotlin/com/pimote/android/ui/theme/PimoteTheme.kt` containing:

1. **`LocalPimoteColors`**, **`LocalPimoteTypography`**, **`LocalPimoteSpacing`** — three `compositionLocalOf` / `staticCompositionLocalOf` declarations, each with a default that throws (no default palette should ever be consumed outside a `PimoteTheme`).

2. **`PimoteTheme` object** — provides static accessors:

   ```kotlin
   object PimoteTheme {
       val colors: PimoteColors @Composable get() = LocalPimoteColors.current
       val typography: PimoteTypography @Composable get() = LocalPimoteTypography.current
       val spacing: PimoteSpacing @Composable get() = LocalPimoteSpacing.current
   }
   ```

3. **`PimoteTheme` composable** — builds the full dark-theme token set, assembles Material3's `ColorScheme` mapping the 6 slots from the architecture (`primary` → indigo, `error` → danger, `background` → void, `surface` → surface, `onSurface` → ink, `onSurfaceVariant` → inkSecondary), and wraps `MaterialTheme` with the Inter-based `Typography` override so untouched Material widgets render in Inter. Provides `LocalPimoteColors`, `LocalPimoteTypography`, `LocalPimoteSpacing` via `CompositionLocalProvider`.

For fonts: construct `FontFamily` using `Font(R.font.inter_variable)` and `Font(R.font.jetbrainsmono_variable)`. Use `fontVariationSettings` if weight variation is needed. All `PimoteTypography` `TextStyle` instances receive their respective font families here (UI fields → inter, mono fields → jetbrainsmono).

**Verify:** `PimoteTheme { Text("hello") }` compiles and renders correctly in a Compose Preview. `PimoteTheme.colors.indigo` is accessible inside the content lambda.
**Status:** done

---

### Step 5: Create StatusPill pure helper and unit test

Create `app/src/main/kotlin/com/pimote/android/ui/components/StatusPillHelpers.kt` with a single top-level function:

```kotlin
/**
 * Cleans a raw reason string for display in the StatusPill:
 * - Strips a leading "ws error:" prefix (case-insensitive, including trailing space).
 * - Truncates to 40 characters, appending "…" if truncated.
 */
fun cleanStatusReason(raw: String): String
```

Write failing test first in `app/src/test/kotlin/com/pimote/android/ui/components/StatusPillHelpersTest.kt` using JUnit 5 `@Test`. Cases to cover:

- `"ws error: connection refused"` → `"connection refused"` (no truncation)
- `"WS Error: abc"` → `"abc"` (case-insensitive prefix strip)
- A 45-char string with no prefix → first 40 chars + `"…"`
- A string exactly 40 chars → returned as-is
- `"ws error: " + 50-char string` → first 40 chars of the 50-char string + `"…"`
- Empty string → empty string

Make the test pass by implementing the function.

**Verify:** `./gradlew :app:test` passes including the new `StatusPillHelpersTest`.
**Status:** done

---

### Step 6: Create StatusPill component

Create `app/src/main/kotlin/com/pimote/android/ui/components/StatusPill.kt`.

Define `sealed interface StatusPillState` with the 5 variants from the architecture: `Connected`, `Connecting`, `Reconnecting(val attempt: Int)`, `Failed(val reason: String)`, `Disconnected`.

Implement `@Composable fun StatusPill(state: StatusPillState, onTap: () -> Unit = {}, modifier: Modifier = Modifier)`:

- **Layout:** A `Row` pill with `12.dp` horizontal / `8.dp` vertical padding, `12.dp` rounded corner, `PimoteTheme.colors.surfacePlus` background. Leading: 6dp filled circle (`Canvas` or `Box` + `CircleShape`) in the state color. Trailing: `Text` in `PimoteTheme.typography.labelMedium` with `FontFamily` from `PimoteTheme.typography.mono14.fontFamily`. Both wrapped in a `clickable { onTap() }` with `48.dp` minimum height via `Modifier.heightIn(min = 48.dp)`.
- **State color mapping:** Connected → `active`, Connecting/Reconnecting → `warning`, Failed → `danger`, Disconnected → `idle`.
- **Label text:** Connected → `"Connected"`, Connecting → `"Connecting…"`, Reconnecting → `"Reconnecting · attempt ${r.attempt}"`, Failed → `"Failed: ${cleanStatusReason(f.reason)}"`, Disconnected → `"Disconnected"`.
- **Auto-collapse when Connected:** Use `LaunchedEffect(state)`. When `state == Connected`, start a 3000ms delay then set a local `var collapsed by remember { mutableStateOf(false) }` to `true`. When state changes away from Connected (detected by `LaunchedEffect(state)` cancelling and restarting), reset `collapsed = false`. When `collapsed == true`, render only the 6dp dot (no text) and align the pill to the trailing edge so it appears near the app bar's trailing area.
- **Tap-to-expand when collapsed:** `onTap` is called when the dot is tapped; in the collapsed branch, tap sets `collapsed = false` and restarts the 3s collapse timer via a `LaunchedEffect` keyed on an incrementing counter.
- **State transitions:** Cross-fade between the expanded and collapsed forms using `AnimatedContent` with a `fadeIn + fadeOut` spec at 150ms.

**Verify:** Compose Preview shows pill in all 5 states. `StatusPillHelpersTest` still passes.
**Status:** done

---

### Step 7: Create ContactRow component

Create `app/src/main/kotlin/com/pimote/android/ui/components/ContactRow.kt`.

Define `enum class ContactKind { Project, Session }`.

Implement `@Composable fun ContactRow(title: String, subtitle: String, kind: ContactKind, isLoading: Boolean = false, onTap: () -> Unit, modifier: Modifier = Modifier)`:

- **Layout:** Full-width `Row`, `Modifier.fillMaxWidth().clickable { onTap() }.heightIn(min = 72.dp).padding(horizontal = PimoteTheme.spacing.ml, vertical = PimoteTheme.spacing.m)`. `verticalAlignment = Alignment.CenterVertically`, `horizontalArrangement = Arrangement.spacedBy(PimoteTheme.spacing.sm)`.
- **Leading icon (24dp):** When `isLoading == true`, replace with `CircularProgressIndicator(modifier = Modifier.size(20.dp), color = PimoteTheme.colors.indigo)`. When not loading: `Icon(painter = painterResource(if kind == Project R.drawable.ic_folder_outlined else R.drawable.ic_chat_bubble_outlined), tint = PimoteTheme.colors.indigo, modifier = Modifier.size(24.dp))`.
- **Text column:** `Column(modifier = Modifier.weight(1f))`. `Text(title, style = PimoteTheme.typography.titleMedium, color = PimoteTheme.colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)`. `Text(subtitle, style = PimoteTheme.typography.bodySmall, color = PimoteTheme.colors.inkSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)`.
- **Trailing chevron (16dp):** `Icon(Icons.Default.ChevronRight, tint = PimoteTheme.colors.inkSecondary, modifier = Modifier.size(16.dp))`.
- **Press feedback:** Use `Modifier.indication` or `Modifier.clickable { ... }` with a custom `Indication` — or wrap in `Surface(onClick = onTap, color = PimoteTheme.colors.void)` with `interactionSource` to apply a `surfacePlus` background flash at 100ms. Simplest approach: use `Modifier.clickable(onClick = onTap)` with `rememberRipple(color = PimoteTheme.colors.surfacePlus)` as the indication.

> **Note:** `ContactsScreen.kt` currently defines a private `data class ContactRow` with the same name. Rename that private class to `ContactRowData` when updating `ContactsScreen` in Step 15 to avoid a naming conflict.

**Verify:** Compose Preview renders a Project row and a Session row. Loading state shows spinner.
**Status:** done

---

### Step 8: Create EmptyState component

Create `app/src/main/kotlin/com/pimote/android/ui/components/EmptyState.kt`.

Define `data class EmptyStateCta(val label: String, val onClick: () -> Unit)`.

Implement `@Composable fun EmptyState(icon: Painter, primary: String, secondary: String, cta: EmptyStateCta? = null, iconAnimating: Boolean = false, modifier: Modifier = Modifier)`:

- **Layout:** `Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center)`. Inside: `Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center)` with spacings as specified (`4.dp` gap after icon, `8.dp` after primary, `16.dp` before CTA).
- **Icon (48dp):** `Image(painter = icon, modifier = Modifier.size(48.dp), contentDescription = null, colorFilter = ColorFilter.tint(PimoteTheme.colors.idle))`. When `iconAnimating == true`, apply an infinite rotation animation: `val rotation by rememberInfiniteTransition().animateFloat(0f, 360f, infiniteRepeatable(tween(1200, easing = LinearEasing)))`, then `Modifier.graphicsLayer { rotationZ = rotation }`.
- **Primary text:** `Text(primary, style = PimoteTheme.typography.bodyLarge, color = PimoteTheme.colors.ink, textAlign = TextAlign.Center)`.
- **Secondary text:** `Text(secondary, style = PimoteTheme.typography.bodyMedium, color = PimoteTheme.colors.inkSecondary, textAlign = TextAlign.Center)`.
- **CTA:** When `cta != null`, render `PimoteButton(label = cta.label, onClick = cta.onClick, variant = PimoteButtonVariant.Secondary)`. This creates a forward dependency on Step 10 — either define `PimoteButton` before `EmptyState`, or stub the button call and fill it in during Step 10. Simplest: swap Steps 8 and 10 if needed, or inline a `TextButton` as a placeholder and replace in Step 10.

**Verify:** Compose Preview shows Connected empty state (no CTA), Disconnected state (with CTA), and Connecting state with spinning icon.
**Status:** done

---

### Step 9: Create AvatarRing component and call-state helpers

Create two files:

**`app/src/main/kotlin/com/pimote/android/ui/components/AvatarRing.kt`**

Define `sealed interface AvatarRingState` with 4 variants:

```kotlin
sealed interface AvatarRingState {
    data class Connecting(val phaseLabel: String) : AvatarRingState
    data class Active(val durationSeconds: Long) : AvatarRingState
    data object EndedOk : AvatarRingState
    data class EndedError(val reason: String) : AvatarRingState
}
```

Implement `@Composable fun AvatarRing(monogram: String, state: AvatarRingState, isMuted: Boolean = false, modifier: Modifier = Modifier)`:

- **Circle:** 120dp `Box` with `PimoteTheme.colors.surfacePlus` fill and a 2dp ring stroke via `Modifier.drawWithContent { ... }` or `Canvas`. Ring color: `active` (Connecting states), `indigo` (Active), `idle` (EndedOk), `danger` (EndedError).
- **Connecting ring:** Replace solid stroke with dashed stroke arc (`PathEffect.dashPathEffect`) rotating 360°/1200ms via `rememberInfiniteTransition().animateFloat(0f, 360f, infiniteRepeatable(tween(1200, LinearEasing)))`.
- **Active ring:** Solid indigo stroke with scale+opacity pulse: `animateFloat(1.0f, 1.06f, infiniteRepeatable(tween(2400, easing = FastOutSlowInEasing), RepeatMode.Reverse))` for scale; `animateFloat(1.0f, 0.65f, ...)` for alpha.
- **Monogram:** Centered `Text(monogram.firstOrNull()?.uppercaseChar()?.toString() ?: "P", style = PimoteTheme.typography.callDisplay, color = PimoteTheme.colors.inkSecondary)`.
- **Below-circle content:** `Connecting` → phase label in `labelMedium` / `indigo`. `Active` → `formatCallDuration(state.durationSeconds)` in `mono14` / `active`. `EndedError` → `state.reason` in `bodySmall` / `danger`.
- **Mute badge:** When `isMuted == true`, an `Icon(painterResource(R.drawable.ic_mic_off), tint = PimoteTheme.colors.warning, modifier = Modifier.size(12.dp))` appears below the below-circle content.

**`app/src/main/kotlin/com/pimote/android/ui/call/CallStateHelpers.kt`**

Two top-level functions:

```kotlin
/** Maps a CallState to the AvatarRingState the in-call screen displays. durationSeconds is only used for Active. */
fun deriveAvatarRingState(state: CallState, durationSeconds: Long = 0L): AvatarRingState

/** Formats a duration in seconds as "MM:SS". */
fun formatCallDuration(seconds: Long): String
```

Mapping for `deriveAvatarRingState`:

- `Idle` → `Connecting("Idle")` (shouldn't be visible but needs a mapping)
- `Dialing` → `Connecting("Dialing…")`
- `Binding` → `Connecting("Connecting…")`
- `Negotiating` → `Connecting("Connecting…")`
- `Active` → `Active(durationSeconds)`
- `Ended` with `USER_HANGUP`, `REMOTE_HANGUP`, `DISPLACED`, `SERVER_ENDED` → `EndedOk`
- `Ended` with `PEER_FAILED`, `BIND_FAILED` → `EndedError(describeEndReason(reason))`

Write tests in `app/src/test/kotlin/com/pimote/android/ui/call/CallStateHelpersTest.kt`:

- `deriveAvatarRingState(Active("id"), 75L)` → `AvatarRingState.Active(75L)`
- `deriveAvatarRingState(Ended("id", USER_HANGUP))` → `EndedOk`
- `deriveAvatarRingState(Ended("id", PEER_FAILED))` → `EndedError(...)` (non-blank reason)
- `formatCallDuration(0)` → `"00:00"`
- `formatCallDuration(75)` → `"01:15"`
- `formatCallDuration(3661)` → `"61:01"`

**Verify:** `./gradlew :app:test` passes including `CallStateHelpersTest`. AvatarRing Compose Preview renders all states.
**Status:** done

---

### Step 10: Create PimoteButton component

Create `app/src/main/kotlin/com/pimote/android/ui/components/PimoteButton.kt`.

Define `enum class PimoteButtonVariant { Primary, Secondary, Destructive, Ghost }`.

Implement `@Composable fun PimoteButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, variant: PimoteButtonVariant = Primary, enabled: Boolean = true, isLoading: Boolean = false, leadingIcon: Painter? = null)`:

- **Shape:** `RoundedCornerShape(12.dp)`.
- **Height:** `52.dp` via `Modifier.height(52.dp)` or `Button(contentPadding = PaddingValues(horizontal = 24.dp, vertical = 0.dp))`.
- **Colors per variant:**
  - Primary: container = `indigo`, content = `Color(0xFF000000)`
  - Secondary: container = `surfacePlus`, content = `ink`, border = `1.dp line`
  - Destructive: container = `danger`, content = `Color.White`
  - Ghost: container = `Color.Transparent`, content = `indigo`
- **Disabled:** `0.38f` alpha via `Modifier.alpha(if (enabled) 1f else 0.38f)` combined with `enabled = enabled` on the underlying `Button`.
- **Loading state:** When `isLoading == true`, replace `leadingIcon` with `CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)` in the variant's content color. Width is kept stable by `Modifier.widthIn(min = ...)` or fixed width.
- **Press feedback:** Use `interactionSource` + `scaleX/scaleY` animation at 0.98 on press, 1.0 on release, at 100ms `spring` spec.
- **Label:** `Text(label, style = PimoteTheme.typography.labelMedium)`.

Use `Button` or `Surface` + `clickable` as the underlying primitive — Material3 `Button` is fine but override its `ButtonDefaults.buttonColors(...)` with the above tokens.

**Verify:** Compose Preview shows all 4 variants in default, disabled, and loading states.
**Status:** done

---

### Step 11: Create PimoteOutlinedTextField component

Create `app/src/main/kotlin/com/pimote/android/ui/components/PimoteOutlinedTextField.kt`.

Implement `@Composable fun PimoteOutlinedTextField(value: String, onValueChange: (String) -> Unit, label: String, placeholder: String, modifier: Modifier = Modifier, enabled: Boolean = true, isError: Boolean = false, errorMessage: String? = null, singleLine: Boolean = true)` as a thin wrapper around Material3 `OutlinedTextField`:

- `shape = RoundedCornerShape(12.dp)`
- `colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = PimoteTheme.colors.indigo, unfocusedBorderColor = PimoteTheme.colors.line, errorBorderColor = PimoteTheme.colors.danger, focusedLabelColor = PimoteTheme.colors.indigo, unfocusedLabelColor = PimoteTheme.colors.inkSecondary, errorLabelColor = PimoteTheme.colors.danger, cursorColor = PimoteTheme.colors.indigo, focusedTextColor = PimoteTheme.colors.ink, unfocusedTextColor = PimoteTheme.colors.ink, disabledTextColor = PimoteTheme.colors.inkDisabled, unfocusedContainerColor = PimoteTheme.colors.surfacePlus, focusedContainerColor = PimoteTheme.colors.surfacePlus)`
- `textStyle = PimoteTheme.typography.bodyLarge`
- `label = { Text(label) }`, `placeholder = { Text(placeholder, color = PimoteTheme.colors.inkDisabled) }`
- `isError = isError`
- Below the field: when `isError && errorMessage != null`, render `Text(errorMessage, style = PimoteTheme.typography.bodySmall, color = PimoteTheme.colors.danger, modifier = Modifier.padding(start = 16.dp, top = 4.dp))`.

Wrap the `OutlinedTextField` + error text in a `Column`.

**Verify:** Compose Preview shows default, focused, error (with message), and disabled states. Error message appears only when `isError = true && errorMessage != null`.
**Status:** done

---

### Step 12: Create PimoteSnackbar component

Create `app/src/main/kotlin/com/pimote/android/ui/components/PimoteSnackbar.kt`.

Define `enum class PimoteSnackbarVariant { Error, Info }`.

Implement `@Composable fun PimoteSnackbarHost(hostState: SnackbarHostState, variant: PimoteSnackbarVariant = Info, modifier: Modifier = Modifier)` as a wrapper around `SnackbarHost`:

- Pass `hostState` to `SnackbarHost`.
- Provide a custom `snackbar` lambda that renders a `Snackbar` with:
  - `shape = RoundedCornerShape(12.dp)`
  - `containerColor = PimoteTheme.colors.surfacePlus`
  - `contentColor = PimoteTheme.colors.ink`
  - `modifier = Modifier.padding(16.dp).height(52.dp).border(1.dp, PimoteTheme.colors.line, RoundedCornerShape(12.dp))`
  - When `variant == Error`: a leading `Icon(painterResource(R.drawable.ic_error_outline), tint = PimoteTheme.colors.danger, modifier = Modifier.size(16.dp))` prepended to the message row.
- `modifier = modifier.padding(16.dp)` on the `SnackbarHost` to produce the 16dp edge margin.

**Verify:** Compose Preview shows Error and Info variants. Error variant has the danger icon; Info has no leading icon.
**Status:** done

---

### Step 13: Wrap root composables in PimoteTheme

Two call sites need wrapping:

1. **`mobile/android/app/src/main/kotlin/com/pimote/android/app/MainActivity.kt`** — Find the `setContent { ... }` call. Wrap the existing content lambda body in `PimoteTheme { ... }`. Import `com.pimote.android.ui.theme.PimoteTheme`.

2. **`mobile/android/app/src/main/kotlin/com/pimote/android/ui/call/InCallScreen.kt`** — In `InCallActivity.onCreate`, the `setContent { InCallScreen(vm, onClose = { finish() }) }` call. Wrap: `setContent { PimoteTheme { InCallScreen(vm, onClose = { finish() }) } }`.

Do not wrap `InCallScreen` internally — the theme wraps at the Activity level so both `MainActivity` subtree and `InCallActivity` subtree each get one `PimoteTheme` root.

**Verify:** `./gradlew :app:compileDebugKotlin` succeeds. All three screens still compile. Material3 components in the existing screens now render with the Pimote palette (indigo primary, void background) automatically.
**Status:** not started

---

### Step 14: Restyle SetupScreen

Edit `app/src/main/kotlin/com/pimote/android/ui/setup/SetupScreen.kt`:

1. **TopAppBar title:** Change `Text("Pimote setup")` to `Text("Settings")` (per design brief).
2. **TopAppBar background:** Add `colors = TopAppBarDefaults.topAppBarColors(containerColor = PimoteTheme.colors.surfacePlus)` to the `TopAppBar`.
3. **Instruction text:** Change `style` to `PimoteTheme.typography.bodyMedium`, `color` to `PimoteTheme.colors.inkSecondary`.
4. **Replace `OutlinedTextField` with `PimoteOutlinedTextField`:** Pass `value = origin`, `onValueChange = { origin = it }`, `label = "Pimote server URL"`, `placeholder = "https://pimote.example.com"`, `singleLine = true`, `enabled = !inFlight`, `isError = connectError != null`, `errorMessage = connectError`. Remove the old `OutlinedTextField` import.
5. **Add inline error state:** Replace the current snackbar-only error path with an inline error. Add `var connectError by remember { mutableStateOf<String?>(null) }`. In the `launch` block: on failure, set `connectError = "Connect failed: $msg"` (and still show snackbar as supplemental). On success or on each new connect attempt, clear `connectError = null`. The `PimoteOutlinedTextField` renders this as inline error text under the field.
6. **Replace `Button` with `PimoteButton`:**
   - Primary "Connect" button: `PimoteButton(label = if (inFlight) "Connecting…" else "Connect", onClick = { ... }, variant = PimoteButtonVariant.Primary, enabled = origin.isNotBlank() && !inFlight, isLoading = inFlight)`.
   - Remove the separate `CircularProgressIndicator` next to the button (loading state is now inside `PimoteButton`).
   - "Continue to contacts" button: `PimoteButton(label = "Continue to contacts", onClick = onConnected, variant = PimoteButtonVariant.Secondary)`.
7. **ConnectionStatusBlock:** Replace with `StatusPill`. Map `WsState` to `StatusPillState` inline:
   ```kotlin
   StatusPill(
       state = when (val s = wsState) {
           WsState.Disconnected -> StatusPillState.Disconnected
           WsState.Connecting -> StatusPillState.Connecting
           WsState.Connected -> StatusPillState.Connected
           is WsState.Reconnecting -> StatusPillState.Reconnecting(s.attempt)
           is WsState.Failed -> StatusPillState.Failed(s.reason)
       },
   )
   ```
   Remove the old `ConnectionStatusBlock` private function.
8. **Content padding:** Change outer padding from `24.dp` to `PimoteTheme.spacing.ml` horizontal, `PimoteTheme.spacing.l` vertical.
9. **SnackbarHost:** Replace `SnackbarHost(snackbar)` with `PimoteSnackbarHost(snackbar, variant = PimoteSnackbarVariant.Error)` in the `Scaffold` snackbarHost slot.

**Verify:** `./gradlew :app:compileDebugKotlin` succeeds. Compose Preview shows the restyled screen. Inline error text appears under the URL field when `isError = true`.
**Status:** not started

---

### Step 15: Restyle ContactsScreen

Edit `app/src/main/kotlin/com/pimote/android/ui/contacts/ContactsScreen.kt`:

1. **Rename private data class:** `private data class ContactRow(...)` → `private data class ContactRowData(...)`. Update all 3 usages in the file (declaration site, `add(ContactRow(...))` calls, `ContactRow(row, ...)` composable call site).
2. **TopAppBar:** Add `colors = TopAppBarDefaults.topAppBarColors(containerColor = PimoteTheme.colors.surfacePlus)`. Keep Refresh + Settings icon buttons; replace `Icons.Default.Refresh` / `Icons.Default.Settings` with `painterResource(...)` variants if vector drawables are available, otherwise keep Material icons. Change `CircularProgressIndicator` color to `PimoteTheme.colors.indigo`.
3. **Remove `ConnectionBanner` and `HorizontalDivider`:** Delete the `ConnectionBanner(wsState)` and `HorizontalDivider()` lines from `ContactsScreen`. Delete the private `ConnectionBanner` composable.
4. **Add `StatusPill` below app bar:** In the `Scaffold` content column, as the first item (before the list/empty state), add:
   ```kotlin
   StatusPill(
       state = when (val s = wsState) {
           WsState.Disconnected -> StatusPillState.Disconnected
           WsState.Connecting -> StatusPillState.Connecting
           WsState.Connected -> StatusPillState.Connected
           is WsState.Reconnecting -> StatusPillState.Reconnecting(s.attempt)
           is WsState.Failed -> StatusPillState.Failed(s.reason)
       },
       modifier = Modifier.padding(horizontal = PimoteTheme.spacing.ml, vertical = PimoteTheme.spacing.s),
   )
   ```
5. **Replace private `EmptyState` with component:** Delete private `EmptyState(state: WsState)` composable. Replace its call site with `EmptyState(...)` calls keyed on `wsState`, passing the appropriate icon painter, primary, secondary, and optional `cta`:
   - `Connected` (no rows): icon = `ic_dashboard_outlined`, primary = `"No sessions yet."`, secondary = `"Open a project in Pimote on the web — it will appear here as a contact."`, cta = null.
   - `Connecting` / `Reconnecting`: icon = `ic_sync`, primary = `"Connecting to Pimote."`, secondary = `"Your sessions will appear once the connection is established."`, iconAnimating = true.
   - `Failed`: icon = `ic_signal_wifi_bad`, primary = `"Couldn't connect."`, secondary = `cleanStatusReason(state.reason)`, cta = `EmptyStateCta("Open Settings") { onEditSettings() }`.
   - `Disconnected`: icon = `ic_wifi_off`, primary = `"Not connected."`, secondary = `"Configure a server URL in Settings."`, cta = `EmptyStateCta("Open Settings") { onEditSettings() }`.
6. **Replace private `ContactRow` composable with component:** Delete the private `ContactRow(row: ContactRowData, onTap: (String) -> Unit)` composable. In the `LazyColumn`, replace its call with:
   ```kotlin
   ContactRow(
       title = row.label,
       subtitle = if (row.isProject) "New session in this project" else "Tap to call this session",
       kind = if (row.isProject) ContactKind.Project else ContactKind.Session,
       isLoading = loadingHandleId == row.handleId,
       onTap = { /* placeCall logic */ },
   )
   ```
   Add `var loadingHandleId by remember { mutableStateOf<String?>(null) }`. On tap: set `loadingHandleId = row.handleId`, call `placeCall(context, row.handleId)`, clear `loadingHandleId` in the catch blocks (or after a short delay — since `placeCall` is synchronous, clear immediately on success too; the spinner auto-clears on failure via snackbar path).
   Remove the `HorizontalDivider()` between rows — spacing is handled by the 72dp minimum row height.
7. **SnackbarHost:** Replace `SnackbarHost(snackbar)` with `PimoteSnackbarHost(snackbar, variant = PimoteSnackbarVariant.Error)`.

**Verify:** `./gradlew :app:compileDebugKotlin` succeeds. Compose Preview shows StatusPill above the contact list, Contact rows with vector icons and no emoji, and appropriate empty states.
**Status:** not started

---

### Step 16: Restyle InCallScreen

Edit `app/src/main/kotlin/com/pimote/android/ui/call/InCallScreen.kt`:

1. **Add `sessionDisplayName` to `CallViewModel`:** Add a derived `StateFlow<String?>` that looks up the session name from `SessionRepository`:

   ```kotlin
   val sessionDisplayName: StateFlow<String?> = combine(
       container.callController.state,
       container.sessionRepository.sessions,
   ) { callState, sessions ->
       when (callState) {
           is CallState.Active -> sessions.firstOrNull { it.sessionId == callState.sessionId }?.let {
               val name = it.name?.takeIf { n -> n.isNotBlank() } ?: "Untitled session"
               name
           }
           else -> null
       }
   }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)
   ```

   This is read-only derived display data from existing flows — no behavioral logic change. Import `kotlinx.coroutines.flow.combine` and `kotlinx.coroutines.flow.stateIn`.

2. **Add `FLAG_KEEP_SCREEN_ON` in `InCallActivity.onCreate`:** After `setContent { ... }`, add:

   ```kotlin
   window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
   ```

   Also observe `vm.state` to clear the flag when the call ends: when `s is CallState.Ended`, call `window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)`.

3. **Replace `InCallScreen` composable body** — replace the current `Scaffold { ... }` with a no-scaffold full-bleed layout:

   ```kotlin
   val state by viewModel.state.collectAsState()
   val sessionName by viewModel.sessionDisplayName.collectAsState()
   var muted by remember { mutableStateOf(false) }
   val isEnded = state is CallState.Ended
   val isActive = state is CallState.Active

   // Duration counter: increments every second while Active.
   var durationSeconds by remember { mutableStateOf(0L) }
   LaunchedEffect(isActive) {
       if (isActive) {
           durationSeconds = 0L
           while (true) { delay(1000); durationSeconds++ }
       }
   }

   val avatarRingState = deriveAvatarRingState(state, durationSeconds)
   val monogram = sessionName?.firstOrNull()?.uppercaseChar()?.toString() ?: "P"
   ```

4. **Header zone (top ~20%):**

   ```kotlin
   Column(
       modifier = Modifier.fillMaxWidth().padding(top = PimoteTheme.spacing.xl, bottom = PimoteTheme.spacing.m),
       horizontalAlignment = Alignment.CenterHorizontally,
   ) {
       if (isEnded) {
           IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Default.ArrowBack, ...) }
       }
       Text(sessionName ?: "Pimote", style = PimoteTheme.typography.titleLarge, color = PimoteTheme.colors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
       Text("Voice call", style = PimoteTheme.typography.bodyMedium, color = PimoteTheme.colors.inkSecondary)
   }
   ```

5. **Avatar zone (vertically centered):**

   ```kotlin
   Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
       AvatarRing(monogram = monogram, state = avatarRingState, isMuted = muted)
   }
   ```

6. **Action zone (bottom ~35%):**

   ```kotlin
   Surface(
       color = PimoteTheme.colors.surface,
       modifier = Modifier.fillMaxWidth().padding(top = PimoteTheme.spacing.l, bottom = PimoteTheme.spacing.xxl),
   ) {
       if (isEnded) {
           Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
               PimoteButton("Close", onClick = onClose, variant = PimoteButtonVariant.Secondary)
           }
       } else {
           Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, ...) {
               // Mute button: 64dp circular
               Box(Modifier.size(64.dp).clip(CircleShape)
                   .background(if (muted) PimoteTheme.colors.warning else PimoteTheme.colors.surfacePlus)
                   .clickable { muted = !muted }, contentAlignment = Alignment.Center) {
                   Icon(painterResource(if (muted) R.drawable.ic_mic_off else R.drawable.ic_mic_outlined),
                       tint = PimoteTheme.colors.ink, modifier = Modifier.size(28.dp))
               }
               Spacer(Modifier.width(PimoteTheme.spacing.l))
               // Hang up button: 72dp circular
               Box(Modifier.size(72.dp).clip(CircleShape)
                   .background(PimoteTheme.colors.danger)
                   .clickable(enabled = !isEnded) { viewModel.endCall() }, contentAlignment = Alignment.Center) {
                   Icon(painterResource(R.drawable.ic_call_end), tint = Color.White, modifier = Modifier.size(32.dp))
               }
           }
       }
   }
   ```

   Wrap the three zones in a `Column(modifier = Modifier.fillMaxSize().background(PimoteTheme.colors.void))`.

7. **Remove old `describe`, `describeReason` helpers** — they were the debug-log-style state text. The AvatarRing's phase labels and `EndedError.reason` from `deriveAvatarRingState` replace them.

**Verify:** `./gradlew :app:compileDebugKotlin` succeeds. Compose Previews show the three-zone layout for Connecting, Active (with timer placeholder), Ended-ok, and Ended-error states. `./gradlew :app:test` (all 97 existing tests + the 9 new ones) still passes.
**Status:** not started
