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

## Tests

> **Skipped.** No tests were written upfront — this is a behavior-neutral restructure (type moves,
> package rename, publish sequencing). Follow red-green TDD as you implement where a new test makes
> sense; existing suites (panels `detect.test.ts`, project-sources `builtin.test.ts` / `loader.test.ts`)
> move with their code and must keep passing. The drift guard (`server/src/sdk-twins.ts`) is a
> compile-time assertion exercised by `tsc -b` / `npm run check`, not a runtime test.

## Steps

**Pre-implementation commit:** `4b085a5a6e7514bc674f406e0476280909c87f83`

### Step 1: Tombstone `@pimote/panels` — 0.12.2 + npm deprecate

Do this **before** any tree changes: the tombstone publish needs `packages/panels/` and its workflow to still exist.

1. Add a deprecation banner as the first line of `packages/panels/README.md`:

   ```markdown
   > **DEPRECATED** — `@pimote/panels` has moved to [`@pimote/sdk`](https://www.npmjs.com/package/@pimote/sdk)
   > (panels module: `@pimote/sdk/panels`). This package will not receive further updates.
   ```

2. Bump: `npm version patch --workspace=@pimote/panels --no-git-tag-version` → 0.12.2 (updates `packages/panels/package.json` + root lockfile).
3. Validate: `npm run build --workspace=@pimote/panels && npm run test --workspace=@pimote/panels -- --run`.
4. Commit (`packages/panels/README.md`, `packages/panels/package.json`, `package-lock.json`) — message: `Bump @pimote/panels to 0.12.2 (deprecated)` — push to `main`.
5. Tag `panels-v0.12.2`, push the tag → triggers `publish-panels.yml`. Watch with `gh run watch <run-id> --exit-status`.
6. `npm deprecate @pimote/panels "@pimote/panels has moved to @pimote/sdk — import from @pimote/sdk/panels. This package will not receive further updates."`

Steps 4–6 push tags and touch the npm registry — coordinate with the user before executing them.

**Verify:** `npm view @pimote/panels version` → `0.12.2`; `npm view @pimote/panels deprecated` prints the migration message.
**Status:** blocked — publish done (CI run 36889179290, 0.12.2 live on npm); `npm deprecate` fails: local npm has no credentials (`npm whoami` → ENEEDAUTH). Needs a logged-in npm session (user action).

### Step 2: Create `packages/sdk` — panels module moved as-is, workspace swapped

1. `mkdir -p packages/sdk/src` and move the panels module unchanged:
   - `git mv packages/panels/src packages/sdk/src/panels` (carries `detect.ts`, `detect.test.ts`, `index.ts`, `types.ts` — no edits; the lock-step comment on `Card` stays accurate)
   - `git mv packages/panels/LICENSE packages/sdk/LICENSE`
2. Write `packages/sdk/tsconfig.json` — identical to the current `packages/panels/tsconfig.json` (ES2022/NodeNext, strict, composite, declaration, `rootDir: src`, `outDir: dist`, exclude `src/**/*.test.ts`).
3. Write `packages/sdk/package.json` — copy `packages/panels/package.json` as the base (description, license, author, repository/homepage/bugs, files, scripts `build`/`dev`/`test`/`prepublishOnly`, devDependencies: pi-coding-agent + typescript + vitest) with these differences:
   - `"name": "@pimote/sdk"`, `"version": "0.13.0"`
   - `repository.directory` → `packages/sdk`; homepage → `.../tree/main/packages/sdk#readme`; description → pimote extensibility SDK (panels + project sources); keywords add `sdk`, `projects`
   - Subpath exports:

     ```json
     "exports": {
       ".": "./dist/index.js",
       "./panels": "./dist/panels/index.js",
       "./projects": "./dist/projects/index.js"
     },
     "types": "./dist/index.d.ts"
     ```

   - Peer dep becomes optional:

     ```json
     "peerDependencies": {
       "@earendil-works/pi-coding-agent": "^0.99.2"
     },
     "peerDependenciesMeta": {
       "@earendil-works/pi-coding-agent": { "optional": true }
     }
     ```

4. Write the root barrel `packages/sdk/src/index.ts`:

   ```ts
   export * from './panels/index.js';
   export * from './projects/index.js';
   ```

   (The `./projects` import resolves once Step 3 lands; to keep this step independently green, either land Step 3 in the same sitting or temporarily comment the second line.)

5. Swap the workspace: root `package.json` `workspaces` — replace `"packages/panels"` with `"packages/sdk"`.
6. Delete the leftovers: `packages/panels/` (README.md, package.json, tsconfig.json; `dist/` and `node_modules/` are untracked).
7. `npm install` to refresh the lockfile (drops the panels workspace entry, adds sdk).

**Verify:** `npm run build --workspace=@pimote/sdk && npm run test --workspace=@pimote/sdk -- --run` (moved `detect.test.ts` passes unchanged); `npm ls @pimote/sdk` resolves to `packages/sdk`; root `npm run build` still succeeds.
**Status:** done

### Step 3: Add the `projects` seam module to the SDK

1. Write `packages/sdk/src/projects/types.ts` — move the contents of `server/src/project-sources/types.ts` (all doc comments carried over), with one change: `RepoInfo` is no longer imported from shared; define the twin locally with the exact field set of `shared/src/protocol.ts` `RepoInfo`:

   ```ts
   /** Repo facts as contributed by sources. Twin of the wire `RepoInfo` in
    *  shared/src/protocol.ts — drift-guarded by server/src/sdk-twins.ts. */
   export interface RepoInfo {
     path: string;
     name: string;
     branch: string | null;
     dirty: boolean;
     /** Commits ahead of upstream; 0 when unknown. */
     ahead: number;
     behind: number;
     /** Epoch ms of last session activity in this repo, when known. */
     lastActivity?: number;
     /** True when the repo path no longer exists on disk (deleted member, broken symlink). */
     missing?: boolean;
     /** Effective tags (user + source-contributed). Absent when untagged. */
     tags?: string[];
   }
   ```

   `RepoSourceEntry extends RepoInfo` now refers to this twin. Everything else (`ProjectCreatorParamType`, `RepoSourceEntry`, `MultiRepoSourceEntry`, `SourceEntry`, `ProjectSource`, `ProjectCreatorDescriptor`, `ProjectCreator`) is byte-for-byte the moved source.

2. Write `packages/sdk/src/projects/index.ts`:

   ```ts
   export type { ProjectSource, ProjectCreator, ProjectCreatorDescriptor, ProjectCreatorParamType, SourceEntry, RepoSourceEntry, MultiRepoSourceEntry, RepoInfo } from './types.js';
   ```

**Verify:** `npm run build --workspace=@pimote/sdk` emits `dist/projects/`, `dist/panels/`, and the root barrel `dist/index.js`; `node -e "import('@pimote/sdk/projects').then(m => console.log(Object.keys(m)))"` (from repo root) prints `[]` — types only, no runtime exports.
**Status:** done

### Step 4: Write `packages/sdk/README.md`

One section per seam, replacing `packages/panels/README.md` (deleted in Step 2):

- Header/intro: pimote's extensibility SDK — what extensions import to talk to pimote; install `npm install @pimote/sdk`; peer dep note (pi-coding-agent, optional, already present in any pi extension).
- **Panels** (`@pimote/sdk/panels`): port the current `packages/panels/README.md` body — usage example, `detect(pi, key)`, `PanelHandle`, card types — with imports changed to `@pimote/sdk/panels`.
- **Projects** (`@pimote/sdk/projects`): document the discovery/creation seam for user-authored modules: export `sources: ProjectSource[]` / `creators: ProjectCreator[]` from a module in the configured project-sources dir (`~/.config/pimote/project-sources`), the `list()` / `onProjectOpen()` / `describe()` / `create()` contracts, entry shapes (`RepoSourceEntry`, `MultiRepoSourceEntry`), and the `RepoInfo` twin (mirrors the wire type; same-name export so `interface MyEntry extends RepoInfo` works against the SDK alone).

**Verify:** README renders (headings per seam, code blocks import from `@pimote/sdk/panels` / `@pimote/sdk/projects`); `npm run format:check` passes on the new file.
**Status:** done

### Step 5: Server adopts the SDK seam types

1. `git rm server/src/project-sources/types.ts`.
2. `server/src/project-sources/index.ts` — replace the `from './types.js'` re-export with the SDK:

   ```ts
   export type { ProjectSource, ProjectCreator, ProjectCreatorDescriptor, ProjectCreatorParamType, SourceEntry, RepoSourceEntry, MultiRepoSourceEntry } from '@pimote/sdk/projects';
   ```

   The `loadProjectSources` / `LoadedProjectSources` exports stay as-is. The 5 importer files (`server/src/index.ts`, `project-registry.ts`, `repo-index.ts`, `server.ts`, `ws-handler.ts`) are untouched — they keep importing from `'./project-sources/index.js'`.

3. Switch the remaining direct `./types.js` importers to the SDK: `server/src/project-sources/loader.ts` (`ProjectCreator`, `ProjectSource`), `materialize.ts` (`MultiRepoSourceEntry`), `builtin.ts` (`ProjectCreator`) — each `import type { … } from '@pimote/sdk/projects';`.
4. Declare the dependency: `npm install @pimote/sdk@* --workspace=@pimote/server` (types-only — all imports are `import type`, so nothing is emitted into `server/dist`). Confirm `server/package.json` shows `"@pimote/sdk": "*"`.
5. Build ordering: add `{ "path": "../packages/sdk" }` to the `references` array in `server/tsconfig.json` (same mechanism as the existing `../shared` reference) so `tsc -b` builds the SDK before the server.

**Verify:** `npm run build --workspace=@pimote/server` succeeds (builds the sdk reference first); `npm run test --workspace=@pimote/server -- --run` passes (`builtin.test.ts`, `loader.test.ts` untouched and green).
**Status:** done

### Step 6: Panel message aliasing + drift guard

1. `server/src/panel-state.ts` — drop the hand-written mirror; keep the shared `Card` import:

   ```ts
   import type { Card } from '../../shared/dist/index.js';
   import type { PanelMessage } from '@pimote/sdk';
   export type { PanelMessage };
   ```

   Delete the `PanelBusMessage` definition (and its "mirrors" comment); `applyPanelMessage` takes `message: PanelMessage`.

2. `server/src/session-manager.ts` — line 20 import becomes `import type { PanelMessage } from './panel-state.js';`; the cast at line ~341 becomes `data as PanelMessage`.
3. New `server/src/sdk-twins.ts` (type-only, **not** a test file — test files are excluded from every type-check, so the assertions must live in `src/` to run under `tsc -b` / `npm run check`):

   ```ts
   import type { Card, RepoInfo } from '../../shared/dist/index.js';
   import type { Card as SdkCard, PanelMessage } from '@pimote/sdk/panels';
   import type { RepoInfo as SdkRepoInfo } from '@pimote/sdk/projects';

   type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

   /** Prior server-side bus-message shape; retained only for this assertion. */
   type PanelBusMessage = { type: 'cards'; namespace: string; cards: Card[] } | { type: 'clear'; namespace: string };

   const _repoInfo: AssertEqual<RepoInfo, SdkRepoInfo> = true;
   const _card: AssertEqual<Card, SdkCard> = true;
   const _panelMsg: AssertEqual<PanelMessage, PanelBusMessage> = true;
   ```

   The `_` prefixes satisfy the repo's eslint `varsIgnorePattern: '^_'`.

**Verify:** `npm run build --workspace=@pimote/server` and root `npm run check` pass (a build must precede `check` — sdk `dist/` types are resolved like `shared/dist` today). One-off sanity of the guard: temporarily rename a field in the SDK `RepoInfo` twin → `npm run check` must fail; revert.
**Status:** done — sanity run: optional-field rename needed `AssertSameKeys` key-set assertions added alongside `AssertEqual` (mutual assignability alone misses optional-field renames); verified check fails on rename, passes after revert.

### Step 7: Swap publish/CI workflows to the SDK

1. `git mv .github/workflows/publish-panels.yml .github/workflows/publish-sdk.yml`, then edit: `name: Publish @pimote/sdk`, trigger `tags: ['sdk-v*']`, `working-directory: packages/sdk`. Steps stay identical (checkout, setup-node with `@pimote` scope, root `npm ci`, build, `npx vitest --run`, `npm publish --access public`).
2. `.github/workflows/ci.yml` — the `Test panels` step becomes:

   ```yaml
   - name: Test sdk
     working-directory: packages/sdk
     run: npx vitest --run
   ```

**Verify:** `grep -rn panels .github/workflows/` returns no hits; YAML well-formed (prettier `format:check` covers it).
**Status:** done

### Step 8: Update the pimote-release skill

In `.pi/skills/pimote-release/SKILL.md`, replace the panels-package material with its sdk equivalent — the skill's structure is unchanged:

- description: `@pimote/pimote` or `@pimote/sdk`; "publish `@pimote/sdk`" in the use-when list
- Release targets: **SDK package** `@pimote/sdk` at `packages/sdk/`
- Version source of truth: `packages/sdk/package.json`; bumps via `npm version <bump> --workspace=@pimote/sdk --no-git-tag-version`
- Validation: `npm run build --workspace=@pimote/sdk && npm run test --workspace=@pimote/sdk -- --run`
- Commit flow: `git add packages/sdk/package.json package-lock.json`, message `Bump @pimote/sdk to X.Y.Z`
- Tags: `sdk-vX.Y.Z` → triggers `publish-sdk.yml`; run checks via `gh run list --workflow "Publish @pimote/sdk"`; `npm view @pimote/sdk version`
- Retagging examples use `sdk-v0.1.0`

**Verify:** `grep -n panels .pi/skills/pimote-release/SKILL.md` returns nothing.
**Status:** done

### Step 9: Reference sweep + codemap

Update every live (non-historical) mention of the old package:

- `README.md` — npm badge (line 7) → `@pimote/sdk` badge/label; links line (line 13) "panels package" → "SDK package" + npm path `package/@pimote/sdk`; workspace table row (line 63) → `| @pimote/sdk | packages/sdk/ | Extensibility SDK: panels + project sources for pi extensions |`; the `## @pimote/panels` section (lines ~351–377) → `## @pimote/sdk` with `import { detect } from '@pimote/sdk';` and a link to `packages/sdk/README.md`.
- `VISION.md` (line 42) — reword the bullet: `@pimote/sdk` (`packages/sdk/`) is the extensibility package extensions import; panels card-push (`@pimote/sdk/panels`) plus the project discovery/creation seam types (`@pimote/sdk/projects`).
- `AGENTS.md` (line 3) — "published npm packages including `@pimote/sdk`".
- `codemap.md` — rename the **Panels** module to **SDK**: published `@pimote/sdk` extensibility package; responsibilities = card types, EventBus detection, namespace-scoped panel handles, project discovery/creation seam types; dependencies = pi SDK extension APIs; files `packages/sdk/src/**`. Update the mermaid `Panels` node label. In the **Server** module, note the types-only dependency on `@pimote/sdk` for the project-sources seam.
- `docs/MANUAL-TEST-PLAN.md` (lines ~1318, ~1322) and `tools/manual-test/PLAN.md` (line ~107) — `@pimote/panels` → `@pimote/sdk`.
- Leave historical records untouched: `docs/plans/*`, `docs/brainstorms/*`, `docs/decisions/DR-004*`.

**Verify:** `grep -rn "pimote/panels" --exclude-dir=node_modules --exclude-dir=dist .` hits only `docs/plans/`, `docs/brainstorms/`, and `docs/decisions/`.
**Status:** done — three tolerated extras outside the sweep's scope: the moved (immutable) `detect.test.ts` describe label, a stale npm-generated `extraneous` lockfile entry (same artifact as the pre-existing `packages/voice` ghost), and `.git/` history.

### Step 10: Full validation + publish SDK 0.13.0

1. Full gate from the repo root: `npm run build`, `make test`, `npm run test --workspace=@pimote/sdk -- --run`, `npm run check`, `npm run lint`, `npm run format:check`.
2. Commit the refactor (stage only files from Steps 2–9 — the working tree carries unrelated concurrent client changes that stay uncommitted).
3. Publish: tag `sdk-v0.13.0` on that commit (manifest already reads 0.13.0 from Step 2 — no bump needed), push the tag → `publish-sdk.yml`; `gh run watch <run-id> --exit-status`.

Tagging/pushing coordinates a registry release — coordinate with the user before step 3.

**Verify:** `npm view @pimote/sdk version` → `0.13.0`; `npm view @pimote/sdk exports` lists `.`, `./panels`, `./projects`.
**Status:** in progress
