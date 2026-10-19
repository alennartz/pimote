# Static report design guide

Design guide for HTML report bundles hosted with `pimote_static_host` and opened in the user's browser, on a phone or a desktop. Read it before you author any report-style bundle. Follow it so the result reads as a designed document, not a dumped markdown page.

## When NOT to build one

Short answers belong in the chat as normal markdown. These include a sentence, a paragraph, a quick snippet, or a yes or no with brief justification. The trigger for a report is length and structure, roughly 300+ words or multiple sections. The topic never triggers it.

## The report replaces the long answer

Keep the chat message to a one-to-three sentence summary of the key takeaways plus the hosted card. Never paste the full report content into the chat as well.

## Self-contained rendering

- The bundle root holds `index.html`, with inline `<style>` and `<script>` and no build step.
- No external CDNs or font downloads. The report must render offline and instantly. Use the system font stack.

## Page structure

- A `<title>` matching the card title.
- A header block with the title, a one-line dek (subtitle), and a date if relevant.
- A short **key takeaways** block at the top, 3 to 5 bullets. Many readers never scroll past it.
- A table of contents with anchor links when the report has four or more sections. Keep it visible on desktop. Adapt it to a compact or collapsible control on mobile.
- Clear section headings, so the TOC entries are self-explanatory.

## Visual design

- Content column: `max-width: 70–80ch`, centered, with generous side padding on mobile.
- Body text: 16–18px, line-height 1.5–1.7, comfortable paragraph spacing.
- A restrained palette: one accent color, neutral grays for text and borders. Support `prefers-color-scheme` with light and dark palettes.
- Callout boxes for notes and warnings. A plain blockquote is not a callout.
- Real tables: proper `<th>`, zebra striping, and a horizontal scroll wrapper for wide tables on mobile.
- Code: `<pre><code>` with a monospace stack and horizontal scroll on overflow. Use light syntax highlighting, with classed spans for keywords, strings, and comments, where it aids reading.
- Charts: inline SVG or a small canvas rendering. Label the axes. Never rely on hover-only information, because mobile has no hover.

## Adaptive display

Do not merely shrink a desktop page. Adapt the layout and controls to the available space, so the same report is comfortable at about 360px (phone) and 1440px (desktop). Use fluid layouts, relative units, and media queries.

On narrow screens, stack side-by-side layouts. Collapse or simplify navigation. Make controls easy to tap. Reflow dense content, such as tables and code, so it stays usable. On wide screens, use the space for readable content widths and helpful side-by-side comparisons.

Before you host, check both widths. Confirm there is no horizontal page scroll, no text below 14px, and no essential action or information hidden behind hover.

## Hosting

Write the bundle to a folder. Then call `pimote_static_host` with the folder's absolute path, a short slug, and a title. Call `pimote_static_host_remove` when a bundle is no longer needed.
