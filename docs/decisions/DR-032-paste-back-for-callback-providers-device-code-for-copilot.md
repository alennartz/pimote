# DR-032: Paste-back for authorization-code providers, device-code for Copilot

## Status

Accepted

## Context

The `/login` flow has to support three OAuth providers with two fundamentally
different redirect shapes:

- **Device-code** (GitHub Copilot): show a verification URL + short user code,
  poll. No redirect, no callback server. Remote-friendly by nature, zero paste
  friction — clearly the nicer UX on a phone.
- **Authorization-code + PKCE + localhost callback** (Claude, ChatGPT): pi spins
  an HTTP server on the _pimote server's_ `localhost:<port>` as the OAuth
  `redirect_uri`. The operator's phone can't reach that localhost, so after
  authorizing, the browser lands on a "can't connect" page; the user copies the
  code/URL off it and pastes it back.

The obvious wish was to redirect OAuth back to a pimote-hosted URL so the phone
flow would be seamless, with no paste step. The question for the design was
whether that's achievable.

## Decision

Accept paste-back for Claude/ChatGPT; use device-code for Copilot. The login
modal renders whichever shape the provider emits, and for the paste-back
providers its copy **explicitly warns** that a connection-error page is expected
and instructs the user to copy the code shown (or off the page URL).

Redirecting these flows to a pimote URL is **impossible, not merely unchosen**:
pimote impersonates the first-party CLI OAuth clients — pi embeds Anthropic's and
OpenAI's privileged `client_id`s. Those clients' `redirect_uri` values are
pinned _provider-side_ to a localhost callback we don't own and can't
re-register against our PWA domain. We cannot point the provider's redirect at a
pimote URL because we don't control the OAuth client registration. Device-code
would be the strictly better UX for all three, but pi only implements the
device-code grant for Copilot; Anthropic and OpenAI are PKCE + localhost-callback
only. So paste-back is the _only_ path those two providers offer.

## Consequences

- The paste-back UX is permanently second-class (a deliberate connection-error
  page, a manual copy/paste) for Claude/ChatGPT, and the modal must keep the
  "this error page is expected" warning copy or the flow looks broken. This is a
  constraint of impersonating first-party clients, not a polish gap to be fixed.
- **Do not** attempt to "fix" the paste step by redirecting OAuth to a pimote URL
  — it cannot work without our own registered OAuth client (different
  `client_id`), which would forfeit first-party subscription access. If a future
  reader wants to revisit this, the thing that would have to change is pimote
  obtaining its own provider-registered OAuth client with a re-registerable
  redirect URI.
- If pi ever adds device-code grants for Anthropic/OpenAI, the paste-back path
  for those two could be replaced wholesale with the device-code shape the modal
  already renders for Copilot — the client UI is already general over both.
- Android is excluded from this feature partly because of this: it's voice-first
  with no real paste affordance, so the paste-back step makes no sense there (see
  DR-013 for the PWA-first stance).
