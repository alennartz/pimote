# Releasing Pimote

## Prerequisites

- npm account with publish access to the `pimote` package
- Node.js 22+
- Clean working tree (recommended)

## Local verification

```bash
npm run build
make test
npm pack --ignore-scripts --dry-run
```

Optional smoke test using the packed tarball:

```bash
TMPDIR=$(mktemp -d)
npm pack --ignore-scripts
cd "$TMPDIR"
npm init -y
npm install --ignore-scripts /path/to/pimote-<version>.tgz
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

- `build` applies dependency patches before compiling the client and server.
- `prepack` rebuilds the app before packaging, so bundled Pi contains the patched runtime.
- The published package has no Pimote patch-install hook. A consumer install can disable scripts and still use the patched bundle.
- Pimote is currently in the `0.x` phase, so treat minor versions as potentially breaking.
