// The server-provided `static-report` skill. Its markdown is embedded here as
// code so it ships inside `server/dist/**/*.js` (the root package `files` list
// only packs compiled JS) and is materialized to disk at runtime by
// `ensureStaticReportSkill()` for discovery via the `resources_discover` event.
//
// Progressive disclosure: the `pimote_static_host` tool description carries
// only the always-on trigger (use it for long answers); this skill holds the
// design guidance and is read by the model only when it actually authors a
// report bundle.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STATIC_REPORT_SKILL_NAME = 'static-report';

export const STATIC_REPORT_SKILL_MARKDOWN = [
  '---',
  `name: ${STATIC_REPORT_SKILL_NAME}`,
  'description: Design guidance for HTML report bundles hosted with the pimote_static_host tool. Read it before authoring any report-style bundle.',
  '---',
  '',
  '# Static report design guide',
  '',
  "You are authoring an HTML report bundle that will be hosted with `pimote_static_host` and opened in the user's browser (phone or desktop). Follow this guide so the result reads as a designed document, not a dumped markdown page.",
  '',
  '## When NOT to build one',
  '',
  'Short answers — a sentence, a paragraph, a quick snippet, a yes/no with brief justification — belong in the chat as normal markdown. The trigger for a report is length and structure (roughly 300+ words, multiple sections), never the topic.',
  '',
  '## The report replaces the long answer',
  '',
  'Keep the chat message to a one-to-three sentence summary of the key takeaways plus the hosted card. Never paste the full report content into the chat as well.',
  '',
  '## One self-contained file',
  '',
  '- Everything lives in a single `index.html` at the bundle root: inline `<style>` and `<script>`, no build step.',
  '- No external CDNs or font downloads — the report must render offline and instantly. Use the system font stack.',
  '- Data you are presenting goes inline in the HTML (or inline JSON plus a little JS), not in side files the page fetches.',
  '',
  '## Page structure',
  '',
  '- A `<title>` matching the card title.',
  '- A header block: title, a one-line dek (subtitle), date if relevant.',
  '- A short **key takeaways** block at the top (3–5 bullets) — many readers never scroll past it.',
  '- A table of contents with anchor links when the report has 4+ sections. Keep it visible on desktop and adapt it to a compact or collapsible control on mobile.',
  '- Clearly worded section headings so the TOC entries are self-explanatory.',
  '',
  '## Visual design',
  '',
  '- Content column: `max-width: 70–80ch`, centered, generous side padding on mobile.',
  '- Body text: 16–18px, line-height 1.5–1.7, comfortable paragraph spacing.',
  '- A restrained palette: one accent color, neutral grays for text and borders. Support `prefers-color-scheme` with light and dark palettes.',
  '- Callout boxes for notes and warnings; a plain blockquote is not a callout.',
  '- Real tables: proper `<th>`, zebra striping, and a horizontal scroll wrapper for wide tables on mobile.',
  '- Code: `<pre><code>` with a monospace stack and horizontal scroll on overflow; light syntax highlighting (classed spans for keywords, strings, comments) where it aids reading.',
  '- Charts: inline SVG or a small canvas rendering; label axes; never rely on hover-only information (mobile has no hover).',
  '',
  '## Adaptive display — mandatory for mobile and desktop',
  '',
  'Do not merely shrink a desktop page. Adapt the layout and controls to the available space so the same report is comfortable to use at ~360px (phone) and ~1440px (desktop). Use fluid layouts, relative units, and media queries. On narrow screens, stack side-by-side layouts, collapse or simplify navigation, make controls easy to tap, and reflow dense content such as tables and code so it remains usable. On wider screens, use the space for readable content widths and helpful side-by-side comparisons. Mentally verify both widths before hosting: no horizontal page scroll, no text below 14px, and no essential action or information hidden behind hover.',
  '',
  '## Hosting',
  '',
  "Write the bundle to a folder, then call `pimote_static_host` with the folder's absolute path, a short slug, and a title. Call `pimote_static_host_remove` when a bundle is no longer needed.",
].join('\n');

/**
 * Materialize the `static-report` skill under `skillsDir` and return its
 * `SKILL.md` path for use in a `resources_discover` `skillPaths` result.
 *
 * Idempotent: rewrites only when the on-disk content differs, so concurrent
 * sessions sharing the directory stay read-only in the common case and version
 * upgrades still propagate.
 */
export async function ensureStaticReportSkill(skillsDir: string): Promise<string> {
  const skillDir = join(skillsDir, STATIC_REPORT_SKILL_NAME);
  const skillFile = join(skillDir, 'SKILL.md');
  await mkdir(skillDir, { recursive: true });
  const existing = await readFile(skillFile, 'utf8').catch(() => undefined);
  if (existing !== STATIC_REPORT_SKILL_MARKDOWN) {
    await writeFile(skillFile, STATIC_REPORT_SKILL_MARKDOWN, 'utf8');
  }
  return skillFile;
}
