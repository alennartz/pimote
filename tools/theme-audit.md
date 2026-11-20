# Theme audit

Run the built-in theme audit with:

```sh
npm run audit:themes
```

The command checks all built-in themes by default. Pass one or more version 1 theme files to include extension or user themes:

```sh
npm run audit:themes -- --file /path/to/themes.json
```

Use `--json` for machine-readable findings. Use `--warnings-as-errors` when a check must reject warnings as well as errors.

The audit only checks pairings declared by current consumers. A token name does not create a foreground/background contract by itself.

The audit covers:

- UI foreground and surface pairs.
- Editor foreground on the live editor background and the sunken code/diff surface.
- Editor syntax, selection, search, and bracket pairs.
- Inserted, deleted, and changed text on the editor and dedicated diff surfaces.
- Addition and deletion diff surfaces against the editor background.
- Selection foreground against the selection surface, with syntax colors audited against the normal editor background.
- Status text against tinted status surfaces.
- Streaming and needs-attention session icons against the selected session chip’s primary surface.
- Hover-surface separation for menu items and button variants.
- ANSI terminal colors against Bash output and extension status backgrounds.
- Client mapping contracts, including dedicated diff background roles.

A 4.5:1 ratio is the normal-text target. A 3:1 ratio is the lower screening threshold for small secondary labels and non-text indicators. ANSI foregrounds use a separate 2:1 minimum because terminal palettes intentionally include dim slots. Adjacent surface separation, including hover states and diff highlights, uses a 1.2:1 minimum. Alpha colors are flattened over their owning surface before the WCAG 2.1 ratio is calculated.
