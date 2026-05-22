// Description text attached to the `pimote_static_host` tool. The string
// is visible to the model in the system prompt's tool listing and must
// substantively cover the two primary use cases, the mandatory responsive-
// layout rule (with explicit mobile + desktop breakpoints), the no-secrets
// rule, and a brief workflow note. See `docs/plans/static-resources.md`.

export const STATIC_HOST_TOOL_DESCRIPTION: string = [
  "Host a static HTML/asset bundle from a local folder so the user can view it in their browser. Returns a URL and creates a tappable card in the user's session pointing at the bundle.",
  '',
  '**When to use this:**',
  '',
  '1. **On-the-fly reports and visualisations.** Reach for this whenever you need to present information that would benefit from richer formatting than plain markdown — charts, comparison tables across many dimensions, syntax-highlighted code walkthroughs, before/after diffs, navigable trees of nested structures. A well-designed HTML report is much easier to read and navigate than a wall of markdown in the chat.',
  '2. **Ad-hoc interactive tools.** Small single-purpose tools the user can play with for a little while — calculators, form-driven explorers, lightweight UIs that call external APIs via embedded JavaScript, in-memory data playgrounds, anything where interactivity adds value beyond static text. The bundle is real same-origin JS; it can fetch, do DOM things, persist to localStorage, whatever. Use this when the user needs a temporary tool tailored to the task at hand rather than a hand-rolled answer.',
  '',
  '**Mandatory: responsive, mobile-and-desktop layout.** Always design the bundle to work equally well on both desktop and mobile form factors. The user may view the same report on either device — even the same report on both. Use fluid layouts, relative units, and media queries. Mentally test your layout at ~360px wide and ~1440px wide before considering it done.',
  '',
  '**No secrets in the bundle.** Bundle files are served verbatim to the browser. Do not embed API keys, tokens, or any other credentials, and do not build bundles that depend on calling services that require them — there is no secret-management story for static-hosted bundles. Stick to public endpoints, in-memory state, and APIs that work without auth.',
  '',
  "**Workflow.** Generate the bundle (with at minimum an `index.html`) in a folder, then call this tool with the folder's absolute path, a short descriptive slug, and a title for the card. The user sees a card in their session; tapping it navigates them to the bundle, and browser-back returns them to the main pimote UI.",
].join('\n');
