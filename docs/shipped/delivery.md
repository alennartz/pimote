# Delivering output to the browser

Two tools put files in front of the reader: `pimote_static_host` serves an HTML bundle as a page, and `pimote_send_file` offers a one-shot download. Both belong to extensions that load in every session.

`static-reports.md` covers how to design a report.

## Host a report

```text
pimote_static_host { slug: "build-report", folder: "/srv/work/report", title: "Build report", tag: "weekly", color: "success" }
```

The bundle root must hold `index.html`. The folder must be an absolute path to an existing directory.

`color` accepts `accent`, `active`, `success`, `warning`, `error`, or `muted`. Pimote does not validate `title` or `tag`, and an empty title leaves a blank card.

The result is `{slug, url, alreadyHosted?, message?}`. The URL is origin-relative:

```text
/s/<slug>/
```

A slug uses lowercase letters, digits, and single hyphens, with 1 to 64 characters. A different folder that asks for a taken slug gets `-2`, `-3`, and so on.

A registration does three things:

- It adds a card to the session panel, with the title, optional tag, optional color, and the report as its link.
- It asks the browser to open the report in a new tab. The request reaches the browser only while that session is on screen, and a popup blocker can drop it. The card is the permanent entry point.
- It persists the registration for the session.

The card keeps the metadata from registration. A later title change reaches only the next registration.

### Already hosted

Hosting a folder that is already hosted returns the existing entry:

```json
{ "slug": "build-report", "url": "/s/<slug>/", "alreadyHosted": true, "message": "…" }
```

This reuse crosses sessions. A second session that hosts another session's folder receives that session's slug, with no new card and no navigation, and it cannot remove that registration. Reuse the URL. Edit the source files instead of registering again.

### Live source

Pimote streams each file from disk on request, so an edit shows on the next reload without another call. Keep the bundle in place while its URL must work.

### Serving rules

| Request                                                | Response                            |
| ------------------------------------------------------ | ----------------------------------- |
| `/s/<slug>/`                                           | `index.html`.                       |
| `/s/<slug>/path/dir/`                                  | `index.html` inside that directory. |
| `/s/<slug>`                                            | `301` to `/s/<slug>/`.              |
| Unknown slug, missing file                             | `404`.                              |
| `..`, a backslash, or a symlink that leaves the bundle | `404`.                              |

There is no fallback to `index.html` inside a bundle. Link with relative URLs, because a leading `/` resolves against the Pimote origin and not the bundle.

Content type comes from a fixed table: HTML, JS, CSS, JSON, text, Markdown, SVG, PNG, JPEG, GIF, WebP, ICO, WOFF, WOFF2, TTF, and `.map`. Every other extension is served as `application/octet-stream`.

Responses carry `Cache-Control: no-cache, no-store, must-revalidate` and `X-Content-Type-Options: nosniff`. The bundle also receives `Content-Security-Policy: connect-src http: https:`.

A report cannot open a WebSocket, so it cannot drive Pimote. It can fetch over HTTP and HTTPS, and it shares the Pimote origin.

### Lifetime

A registration lives as long as its session record exists.

- The report serves while its session is open.
- A closed session drops the routes until it loads again. The registration survives.
- No expiry applies. Server boot removes registrations whose session record is gone.

Remove a registration when its card no longer belongs in the session:

```text
pimote_static_host_remove { slug: "build-report" }
```

The result is `{removed}`. `false` means the slug is unknown, already removed, or owned by another session. The source files stay.

## Offer a file

```text
pimote_send_file { path: "reports/summary.csv" }
```

The path resolves from the session working directory. An absolute path needs no containment in it, because any file the server can read is offerable. The target must be a regular file.

The result is `{id, filename, sizeBytes}`. There is no URL in the result. The browser renders the offer as a link to `/d/<id>` and shows a toast while that session is on screen.

| Property | Behavior                                                                       |
| -------- | ------------------------------------------------------------------------------ |
| Filename | The basename at offer time. A later rename does not change it.                 |
| Size     | The size at offer time.                                                        |
| Bytes    | Read from the source file when the reader clicks.                              |
| Reuse    | A click consumes the offer. One offer, one download.                           |
| Expiry   | None. An offer survives a restart and stays claimable while its session loads. |
| Cleanup  | `pimote_cancel_file_send { id }` revokes it.                                   |

`pimote_cancel_file_send` returns `{cancelled}`, and `false` for an unknown, consumed, or revoked offer, or one owned by another session.

A click that finds the source missing consumes the offer and answers `404`. Offer the file again after a failed click.

## Choose between them

| Intent                         | Tool                                 |
| ------------------------------ | ------------------------------------ |
| A report to read or to share   | `pimote_static_host`                 |
| A visual or interactive answer | `pimote_static_host`                 |
| An artifact to save or upload  | `pimote_send_file`                   |
| A short prose answer           | Neither. Answer in the conversation. |
