# Static report design guide

Design a report for comfortable reading at 360px and at 1440px. A report opens in a new tab from its session card. The reader arrives with no context beyond the card title.

`delivery.md` covers hosting, URLs, and the serving rules.

## Bundle shape

- The bundle root holds `index.html`. Every report has one.
- Put CSS, scripts, images, and fonts in the bundle, and link them with relative URLs. A leading `/` resolves against the Pimote origin and fails.
- Vendor a library into the bundle instead of loading it from a content delivery network. The report must render offline and appear at once.
- Use the system font stack. A webfont is a download the reader does not need.
- A report cannot open a WebSocket. It can fetch over HTTP and HTTPS.

## Page structure

- A `<title>` that matches the card title.
- A header block with the title, a one-line dek, and a date when the date matters.
- A key-takeaways block of 3 to 5 bullets at the top. Many readers never scroll past it.
- A table of contents with anchor links when the report has four or more sections. Keep it visible on desktop and collapse it on a phone.
- Section headings that read as complete statements, so each table-of-contents entry explains itself.

## Visual design

- Content column: `max-width` of 70 to 80 characters, centered, with generous side padding on a phone.
- Body text: 16 to 18px, line height 1.5 to 1.7, and clear paragraph spacing.
- One accent color, neutral grays for text and borders, and a light and dark palette behind `prefers-color-scheme`.
- Callout boxes for notes and warnings. A blockquote is not a callout.
- Real tables: `<th>` cells, zebra striping, and a horizontal scroll wrapper for a phone.
- Code: `<pre><code>` with a monospace stack and horizontal scroll on overflow. Add light syntax highlighting when it aids reading.
- Charts: inline SVG or a small canvas. Label every axis. A tooltip cannot carry required information, because a phone has no hover.
- For a simple chart, vendor Chart.js into the bundle. For an interactive data grid, vendor Tabulator. Neither library is served by Pimote.

## Adaptive display

Do not shrink a desktop page. Adapt the layout to the space, and check both widths before you publish.

- Use fluid layouts, relative units, and media queries instead of fixed pixel widths.
- Stack side-by-side layouts on a narrow screen, and collapse navigation that does not fit.
- Keep controls large enough to tap, and keep essential information visible without hover.
- Reflow tables and code blocks so they stay usable at 360px.
- On a wide screen, hold the content column at a readable width and use the remaining space for side-by-side comparison.

Confirm there is no horizontal page scroll at either width, and no text below 14px.
