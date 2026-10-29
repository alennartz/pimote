# Static report design guide

Design HTML reports for comfortable browser reading on phones and desktops.

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
- For lightweight static reports, use Chart.js for rendering simple charts on an HTML5 Canvas. For interactive data grids, choose Tabulator; it's pure JavaScript, lightweight, and includes built in search and filtering, and can dynamically load data from local server assets or external URLs.

## Adaptive display

Do not merely shrink a desktop page. Adapt the layout and controls to the available space, so the same report is comfortable at about 360px (phone) and 1440px (desktop). Use fluid layouts, relative units, and media queries.

On narrow screens, stack side-by-side layouts. Collapse or simplify navigation. Make controls easy to tap. Reflow dense content, such as tables and code, so it stays usable. On wide screens, use the space for readable content widths and helpful side-by-side comparisons.

Check the report at both widths. Confirm there is no horizontal page scroll and no text below 14px. Keep essential actions and information available without hover.
