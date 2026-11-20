# Theme demo

The theme demo is a standalone visual review page. It does not ship in the PWA.

Run it from the repository root:

```sh
npm run theme-demo
```

Open <http://localhost:4173> in a browser. Pass a port as the second argument:

```sh
npm run theme-demo -- 4174
```

The server loads the current built-in definitions from `server/src/builtin-themes.ts`, resolves them through the real `ThemeCatalog`, and reads the current client mapping from `client/src/lib/highlight-theme.css`. It does not copy color values into the demo. Restart the server after source edits.

The page mirrors the current consumer contracts from the button, status bar, session rail, context menu, message callout, markdown link, CodeMirror editor, edit diff, Bash output, and extension status components. It includes their UI surfaces, hover states, status states, editor syntax, selection, search markers, matching brackets, diffs, terminal output, and the current audit findings for the selected theme.

## Publish a static snapshot

The demo server serves live source data. Pimote can host a static snapshot of the same page when a browser review link must remain available after the server stops.

Start the demo server:

```sh
npm run theme-demo
```

Create a bundle directory, copy the page, and fetch the generated theme payload:

```sh
bundle=/tmp/pimote-theme-demo-snapshot
rm -rf "$bundle"
mkdir -p "$bundle"
cp tools/theme-demo/index.html "$bundle/index.html"
curl --fail --silent --show-error http://localhost:4173/themes.json > "$bundle/themes.json"
```

The bundle must contain both `index.html` and `themes.json`. The page requests `themes.json` with a relative URL, so keep both files in the same directory.

Publish that directory with Pimote's `pimote_static_host` tool. Pass the bundle path, a slug, and a title. The hosted page is a snapshot. Repeat the copy and fetch steps after source or theme changes, then publish the refreshed bundle.
