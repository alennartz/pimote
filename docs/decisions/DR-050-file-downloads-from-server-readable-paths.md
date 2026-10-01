# DR-050: Allow file downloads from any server-readable path

## Status

Accepted

## Context

Pimote bridges a path supplied by an agent to an explicit native browser download. The original design restricted sources to the session's current working directory, including rejecting paths and symlinks that resolved outside it. That boundary did not protect files from the agent: the agent can already read and copy files available under its runtime permissions. It only forced staging copies into the project directory before they could be offered, undermining the live-source, no-copy design.

Supersedes DR-040 (Use live, single-use HTTP registrations for file downloads), deleted at commit `30b212b4d8b011c1bdaf8674382d3d9f11952913`.

## Decision

Keep session-scoped persistent registrations for live source files. The server gives the PWA an opaque, high-entropy `/d/<id>` URL. A `GET` durably claims and removes the registration before opening and streaming the source as a native attachment. The source is not copied, moved, or deleted; its bytes are read at click time. The owning agent can cancel an unclaimed offer.

Resolve relative paths against the session's captured current working directory. Accept absolute paths regardless of whether they are inside that directory, and do not reject `..` traversal or symlinks that resolve outside it. At offer time and again when the user clicks, require the source to exist and be a regular file. Open the source before validating its descriptor and stream from that same descriptor, so the reported file facts and streamed bytes refer to the same object. A failed click-time validation still consumes the registration.

An explicit user click remains the browser acceptance boundary. Existing edge access remains the server access boundary; the one-shot URL is not bound to a browser or session.

## Consequences

- The agent can offer any regular file readable by the Pimote server process, without first copying it into the project directory.
- Relative paths retain their meaning across restart because each registration stores the session working directory; absolute paths are used as supplied.
- Missing or non-regular sources fail validation. Symlinks and paths outside the session directory are allowed when they resolve to a readable regular file.
- Pending registrations still need per-session persistence and replay, atomic claim reservation and removal, and revocation before claim.
- A copied unused URL can be redeemed by any client admitted by the existing edge access layer until its first successful claim. The PWA still does not know whether the browser saved or canceled a download after the request began.
- The Android client does not receive a download protocol or storage surface; native downloads remain a separate product decision.
