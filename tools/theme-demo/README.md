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
