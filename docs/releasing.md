# Releasing Pimote

## Prerequisites

- npm account with publish access to the `pimote` package
- Node.js 22+
- Clean working tree (recommended)

## Local verification

```bash
npm run build
make test
npm pack --dry-run
```

Optional smoke test using the packed tarball:

```bash
TMPDIR=$(mktemp -d)
npm pack
cd "$TMPDIR"
npm init -y
npm install /path/to/pimote-<version>.tgz
npx pimote help
# or directly from the registry name:
npx @pimote/pimote help
```

## Publish

1. Bump `version` in `package.json`.
2. Commit the release changes.
3. Publish from the repo root:

```bash
npm publish
```

## Notes

- `prepack` rebuilds the app before packaging.
- The published package includes the built client, built server, CLI entrypoint, and runtime patches.
- Pimote is currently in the `0.x` phase, so treat minor versions as potentially breaking.
