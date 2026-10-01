# Plan: `@pimote/sdk` package (panels + project seams consolidated)

## Context

Replace `@pimote/panels` with a single published extensibility package, `@pimote/sdk`, carrying the panels seam and the (previously unpublished) project discovery/creation seam. Retire `@pimote/panels` via tombstone release + npm deprecation. Direction and reasoning: [docs/brainstorms/sdk-package.md](../brainstorms/sdk-package.md).

## Architecture

### Impacted Modules

- **Panels (codemap) → becomes the SDK module.** `packages/panels/` is deleted; its `src/` moves unchanged into `packages/sdk/src/panels/` (no API changes). The module gains subpath export `@pimote/sdk/panels` and keeps its pi-coding-agent peer dep as **optional** (`peerDependenciesMeta`). The lock-step comment on `Card` stays accurate.
- **Server (codemap).** Gains a types-only dependency on the workspace SDK. `server/src/project-sources/types.ts` is deleted — seam types now import from `@pimote/sdk/projects` via the existing local barrel. `panel-state.ts` drops its hand-written `PanelBusMessage` mirror and aliases SDK `PanelMessage`; `session-manager.ts`'s cast becomes SDK-typed. New `server/src/sdk-twins.ts` (see Interfaces) guards all structural twins. `server/package.json` declares `"@pimote/sdk": "*"` (workspace-resolved).
- **Protocol (codemap).** Unchanged. `RepoInfo` and `Card` remain owned by `shared/`; the SDK carries twins (brainstorm decision B), guarded by the drift module.
- **Development Tooling (codemap).** `.github/workflows/publish-panels.yml` → `publish-sdk.yml` (name `Publish @pimote/sdk`, trigger `sdk-v*`, working-directory `packages/sdk`); `.github/workflows/ci.yml` "Test panels" step → `packages/sdk`; `.pi/skills/pimote-release/SKILL.md` panels section → sdk section (`--workspace=@pimote/sdk` bumps, `sdk-vX.Y.Z` tags, workflow name, validation commands); root `package.json` workspaces swap `packages/panels` → `packages/sdk`; reference sweep in root `README.md`, `VISION.md`, `AGENTS.md`, `codemap.md`, `docs/MANUAL-TEST-PLAN.md`, `tools/manual-test/PLAN.md`.

### New Modules

**`@pimote/sdk`** (`packages/sdk/`, published, version starts at **0.13.0**). Pimote's single extensibility package: one subpath module per extension seam, root barrel re-exporting all of them. Responsibilities: (1) `panels` — card types, EventBus detection, namespace-scoped handles (moved as-is); (2) `projects` — discovery/creation seam types: `ProjectSource`, `ProjectCreator`, `ProjectCreatorDescriptor`, `ProjectCreatorParamType`, `SourceEntry`, `RepoSourceEntry`, `MultiRepoSourceEntry`, plus a `RepoInfo` twin documented as mirroring the wire type. Dependencies: optional peer `@earendil-works/pi-coding-agent` (panels' type-only imports); no runtime deps. Server-side machinery (jiti loader, builtin source/creator, materialization) intentionally stays in the Server module — the SDK is the public contract only. Ships its own README with one section per seam (`panels`, `projects`), replacing `packages/panels/README.md`.

### Interfaces

**SDK public surface** (package `exports` map):

```ts
// @pimote/sdk            → barrel re-exporting both modules below
// @pimote/sdk/panels    → Card, CardColor, BodySection, BodySectionStyle,
//                         PanelHandle, PanelMessage, detect()
// @pimote/sdk/projects  → ProjectSource, ProjectCreator, ProjectCreatorDescriptor,
//                         ProjectCreatorParamType, SourceEntry, RepoSourceEntry,
//                         MultiRepoSourceEntry, RepoInfo (twin)
```

`RepoSourceEntry extends RepoInfo` where `RepoInfo` is the SDK twin with the exact field set of `shared/src/protocol.ts` `RepoInfo` (`path`, `name`, `branch: string | null`, `dirty`, `ahead`, `behind`, optional `lastActivity`, `missing`, `tags`). Same-name export so extension authors write `interface MyEntry extends RepoInfo` against the SDK alone.

**Drift-guard contract** (`server/src/sdk-twins.ts`, type-only, non-test — test files are excluded from every type-check, so assertions must live in `src/` to run under `tsc -b` and `npm run check`):

```ts
// Mutual assignability assertions (both directions), e.g.:
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _repoInfo: AssertEqual<RepoInfo /*shared*/, SdkRepoInfo> = true;
const _card: AssertEqual<Card /*shared*/, SdkCard> = true;
const _panelMsg: AssertEqual<SdkPanelMessage, PanelBusMessage /*prior shape*/> = true;
```

Any field drift between wire and SDK twins fails the server build. `PanelBusMessage` is retained only inside this assertion (the name otherwise disappears from the server).

**Server-side seam consumption:** `server/src/project-sources/index.ts` remains the internal barrel and re-exports the seam types from `@pimote/sdk/projects`; its loader/materialize exports are unchanged. The 5 importer files keep importing from `'./project-sources/index.js'`.

**Publishing contract:** tombstone first — from the current tree, bump `@pimote/panels` to 0.12.2 with a deprecation-only README banner, publish via existing `panels-v0.12.2` tag, then `npm deprecate @pimote/panels "<migration message → @pimote/sdk>"`; only then delete the directory and introduce `packages/sdk`. SDK publishes via `sdk-v0.13.0` tag → `publish-sdk.yml`. Sequencing rationale: the tombstone publish needs the old package and its workflow to still exist.

### Technology Choices

None new — npm workspaces, subpath `exports`, and `peerDependenciesMeta` are all standard mechanisms already implied by the repo's tooling.

### DR Supersessions

None. DR-039 (real types over mirrors) is _followed more fully_ (server adopts SDK `PanelMessage`, twins are guarded); DR-045 (repo index orthogonal to curated projects) and DR-049 (trusted in-process TS project sources via jiti) are unaffected — the seam contract moves home, not shape.
