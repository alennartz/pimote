---
name: pimote-release
description: Release workflow for this repo's npm packages. Use when preparing or executing a new release of @pimote/pimote or @pimote/panels, deciding the next version number, bumping versions with npm, tagging the correct commit, or checking the publish GitHub Actions run.
---

# Pimote Release

This skill is specific to the `pimote` repository.

Use it when the user wants to:

- decide the next release version
- publish `@pimote/pimote`
- publish `@pimote/panels`
- retag and retry a failed publish
- verify a GitHub Actions publish run

## Release targets

There are two independently published npm packages in this repo:

1. **App package**: `@pimote/pimote`
2. **Panels package**: `@pimote/panels`

Always confirm which package is being released before making changes.

## Version source of truth

Do **not** hand-edit package manifest versions. Use `npm version ... --no-git-tag-version` so npm updates both the manifest and the root lockfile consistently.

### App package

Source of truth:

- `package.json`
- `package-lock.json` (updated by npm)

Recommended bump commands:

```bash
npm version patch --no-git-tag-version
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
npm version 0.1.2 --no-git-tag-version
```

### Panels package

Source of truth:

- `packages/panels/package.json`
- `package-lock.json` (updated by npm)

Recommended bump commands:

```bash
npm version patch --workspace=@pimote/panels --no-git-tag-version
npm version minor --workspace=@pimote/panels --no-git-tag-version
npm version major --workspace=@pimote/panels --no-git-tag-version
npm version 0.1.2 --workspace=@pimote/panels --no-git-tag-version
```

## Ask before choosing the bump

Do **not** guess the next version number.

When the user has not specified the exact version, discuss the bump first:

- patch = fixes / packaging / small polish
- minor = new user-facing capabilities
- major = intentional breaking changes

If helpful, summarize recent commits since the last relevant tag before recommending patch/minor/major.

## Validation before tagging

For **app releases** run:

```bash
npm run build
make test
npm pack --dry-run
```

Optionally smoke-test the packed app install:

```bash
TARBALL=$(node -e "const { execFileSync } = require('node:child_process'); const out = execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { encoding: 'utf8' }); const info = JSON.parse(out); console.log(info[0].filename);")
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
npm init -y >/dev/null
npm install "/absolute/path/to/$TARBALL"
npx pimote help
```

For **panels releases** run:

```bash
npm run build --workspace=@pimote/panels
npm run test --workspace=@pimote/panels -- --run
```

## Commit flow

After the version bump and validation, commit the bump before tagging.

### App release commit

```bash
git add package.json package-lock.json
git commit -m "Bump @pimote/pimote to X.Y.Z"
git push origin main
```

### Panels release commit

```bash
git add packages/panels/package.json package-lock.json
git commit -m "Bump @pimote/panels to X.Y.Z"
git push origin main
```

## Tag patterns

The tag must match the package version on that exact commit.

### App tags

```bash
git tag pimote-vX.Y.Z
git push origin pimote-vX.Y.Z
```

This triggers:

- `.github/workflows/publish-pimote.yml`

### Panels tags

```bash
git tag panels-vX.Y.Z
git push origin panels-vX.Y.Z
```

This triggers:

- `.github/workflows/publish-panels.yml`

## Checking the publish run

Use the GitHub CLI:

```bash
gh run list --workflow "Publish @pimote/pimote" --limit 5
gh run list --workflow "Publish @pimote/panels" --limit 5
```

Watch a run:

```bash
gh run watch <run-id> --exit-status
```

Inspect failures:

```bash
gh run view <run-id> --log-failed
```

Verify the published npm version:

```bash
npm view @pimote/pimote version
npm view @pimote/panels version
```

## Retagging after a failed run

If a publish attempt failed because the tagged commit needed a fix:

1. fix the issue on `main`
2. commit and push the fix
3. move the tag to the new commit

App example:

```bash
git tag -d pimote-v0.1.0
git push origin :refs/tags/pimote-v0.1.0
git tag pimote-v0.1.0
git push origin pimote-v0.1.0
```

Panels example:

```bash
git tag -d panels-v0.1.0
git push origin :refs/tags/panels-v0.1.0
git tag panels-v0.1.0
git push origin panels-v0.1.0
```

## Notes specific to this repo

- The app package published from the repo root is `@pimote/pimote`.
- The installed binary name remains `pimote`.
- The app publish workflow performs a packed-install smoke test before publish.
- The app currently relies on a repo-shipped patch for `@mariozechner/pi-coding-agent`, so keep the pinned version and patch compatibility in mind when upgrading dependencies.
- Local deployment uses installed package releases under `~/.local/share/pimote/` and is intentionally separate from publish tagging.

## Response pattern

When using this skill:

1. identify whether the release target is **app** or **panels**
2. determine whether the user wants **patch**, **minor**, **major**, or an explicit version
3. run the npm version command
4. validate
5. commit and push
6. create and push the tag
7. check the Actions run
8. confirm the npm version once published
