# Brainstorm: `@pimote/sdk` package (panels + project seams consolidated)

## The idea

Replace `@pimote/panels` with a single published package, `@pimote/sdk`, that carries **all** pimote extensibility seams — current and future. Initial version ships two modules: the existing panels library (moved as-is) and the previously-unpublished project discovery/creation seam types (`ProjectSource` / `ProjectCreator`, today at `server/src/project-sources/types.ts`). `@pimote/panels` is retired via tombstone release + npm deprecation.

## Key decisions

### RepoInfo ownership: structural twin + drift guard (not "SDK owns it")

The seam types embed `RepoInfo`, which lives in the internal wire protocol (`shared/src/protocol.ts`) — and `shared/` is not published, so external authors can't compile against it. Options were (A) move `RepoInfo` into the SDK and have server/shared import from it, or (B) SDK declares its own `RepoInfo`-shaped type with a compile-time drift guard on the server side.

**Chose B.** Reasoning: wire protocol and extension seam are two distinct vocabularies. The protocol is mirrored by hand in Kotlin, so coupling it to the SDK's churn is a liability; keeping `shared/` self-contained preserves that boundary. TypeScript structural typing makes the twin free at runtime, and the drift guard catches shape divergence at CI time.

### Seam types are dogfooded: SDK is the single source of truth

`ProjectSource`, `ProjectCreator`, `SourceEntry`, etc. move **into** `packages/sdk`; the server's `project-sources/` module imports them from the workspace SDK package. Zero drift for the seam itself, and the server acts as the SDK's first consumer — contract changes break the server build. The loader/builtin/materialize machinery stays in the server; that's server infra, not the public contract.

### Export layout: subpath exports + root barrel

`@pimote/sdk/panels`, `@pimote/sdk/projects`, with root `@pimote/sdk` re-exporting both. Each seam is a stable, independently documentable path; future seams (interception, voice, …) slot in as new subpaths without touching existing ones. Second module named `projects` (not `project-sources`) because it covers both discovery and creation.

### Retirement of `@pimote/panels`: tombstone release + deprecate

Publish `0.12.2` whose only change is a "DEPRECATED — use `@pimote/sdk`" README banner (code untouched, **no re-export stub** — old installs stay self-contained), then `npm deprecate @pimote/panels "<migration message>"`. This makes the rename discoverable on the registry page itself. In-repo consumers drop to zero via the refactor, so the old package is purely an external artifact.

**Sequencing:** tombstone-**first** — publish 0.12.2 from the current tree while `packages/panels/` still exists, then refactor and delete the directory, then publish SDK 0.13.0. (Handed to architect to finalize.)

### Initial version: 0.13.0

Encodes the aggregation point: carries the panels API (0.12 lineage) plus the seam born in the 0.13 generation, while staying 0.x (both seams young; 1.0.0 premature). Versions drift independently from the app package, same as panels did.

### Peer dependency on `pi-coding-agent`: optional

Panels' pi imports are types-only, so the peer dep matters only for TS compilation. Mark `peerDependenciesMeta: { "@earendil-works/pi-coding-agent": { optional: true } }`. Panel authors have pi installed anyway (it's their host); project-source authors install nothing extra. Note: peer deps are package-wide — subpath exports cannot scope dependencies.

## Direction

1. **Tombstone `@pimote/panels`:** README banner + version 0.12.2, build/test, publish, `npm deprecate` with migration message.
2. **Create `packages/sdk`:** move panels src unchanged (no API changes — keeps the diff reviewable and the deprecation message honest), add `projects` module (seam types), optional peer dep, subpath exports + root barrel, README with per-seam sections.
3. **Server:** delete `server/src/project-sources/types.ts`, import seam types from `@pimote/sdk/projects`; add RepoInfo drift guard.
4. **Reference sweep (live config/docs only):**
   - `.github/workflows/ci.yml` — "Test panels" step → `packages/sdk`
   - `.github/workflows/publish-panels.yml` → new `publish-sdk.yml` (`sdk-v*` tags, `packages/sdk` dir, `@pimote/sdk` name)
   - `.pi/skills/pimote-release/SKILL.md` — panels section → sdk (bump commands, `sdk-vX.Y.Z` tags, workflow name, validation)
   - root `package.json` workspaces
   - root `README.md`, `VISION.md`, `AGENTS.md`, `codemap.md`
   - `docs/MANUAL-TEST-PLAN.md`, `tools/manual-test/PLAN.md`
5. **Publish `@pimote/sdk` 0.13.0** via `sdk-v0.13.0` tag.

Historical records (`docs/decisions/DR-004-*`, old `docs/plans/*`) are left untouched.

## Open questions

### Sharp (→ architecting)

- Exact drift-guard mechanism for the RepoInfo twin: type-level assertion (e.g. `satisfies`/assignability check compiled in CI) vs runtime test. Where it lives (server tests vs SDK tests) given the SDK cannot import `shared/`.
- Publish sequencing detail: confirm tombstone-first ordering fits the release workflows (panels workflow must still exist and run for the 0.12.2 tag before `publish-sdk.yml` replaces it).
- Whether `server/src/project-sources/index.ts` re-exports move to SDK paths wholesale or keep a thin local barrel for server-internal import ergonomics.

### Fog

None flagged.
