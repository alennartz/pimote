# Durable Apps

Durable **Apps** expose long-lived web applications on dedicated subdomains (for example `https://<slug>.apps.example.com`). Unlike session-scoped static hosts (`/s/<slug>/`), an App outlives the session that registered it and appears globally on the Pimote Home screen.

## Architecture

Pimote stays unaware of DNS, TLS, and external authentication. The deployment configures two static routes on its external reverse proxy:

- Pimote's public origin routes to Pimote.
- A wildcard app domain (for example `*.apps.example.com`) routes to an external Caddy sidecar.

Pimote persists the App catalog in `$XDG_STATE_HOME/pimote/apps.json` (default `~/.local/state/pimote/apps.json`) and reconciles one dedicated HTTP server block in Caddy through Caddy's loopback admin API. Caddy forwards HTTP, streaming, and WebSocket traffic directly to each App's target origin.

## Configuration

Add an `apps` block to `$XDG_CONFIG_HOME/pimote/config.json`:

```json
{
  "roots": ["/srv/repos"],
  "apps": {
    "publicUrlTemplate": "https://{slug}.apps.example.com",
    "caddyAdminUrl": "http://127.0.0.1:2019",
    "caddyListen": "127.0.0.1:8080",
    "caddyServerName": "pimote_apps"
  }
}
```

| Field               | Required | Default          | Rules                                                                                                    |
| ------------------- | -------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| `publicUrlTemplate` | Yes      | none             | `http://` or `https://` origin with no path, query, or hash. Contains `{slug}` once inside the hostname. |
| `caddyAdminUrl`     | Yes      | none             | Loopback `http://` origin (`localhost`, `127.0.0.1`, or `[::1]`) without credentials or path.            |
| `caddyListen`       | No       | `127.0.0.1:8080` | Listen address for the Pimote-managed Caddy HTTP server.                                                 |
| `caddyServerName`   | No       | `pimote_apps`    | Caddy server key under `/config/apps/http/servers/<name>`.                                               |

When `apps` is omitted, Pimote hides the Apps Pi tools and the Home screen Apps section. Changes to `apps` apply only at server restart.

## Target rules

Each App targets an HTTP or HTTPS origin reachable from the Pimote host:

- Scheme must be `http://` or `https://`.
- Embedded credentials, query strings, fragments, and paths other than `/` are rejected.
- Loopback ports owned by Pimote, Caddy's admin API, or Caddy's `caddyListen` address are blocked.
- Link-local and cloud metadata addresses (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `metadata.google.internal`, `metadata.goog`) are blocked.

Pimote does not supervise app processes. Start and maintain the upstream process outside Pimote (for example with systemd, Docker, or a remote host).

## Pi tools

When the Apps gateway is configured, three tools load in every session:

- `pimote_app_register`: registers a durable App by `slug` (1 to 63 lowercase letters, digits, and single hyphens), `title`, `target`, optional `description`, and optional `overwrite` (default `false`). Returns `{app, sync}`.
- `pimote_app_list`: returns all registered Apps sorted by title then slug plus `{sync}`.
- `pimote_app_remove`: removes a registered App by `slug`, reconciles Caddy, and returns `{removed, sync}`.

## Sync and reload behavior

Pimote does not poll upstream targets for health. It reports only Caddy route sync state (`synced` or `error`).

- If Caddy is unreachable at boot or during a change, Pimote keeps the App catalog on disk, sets `sync.status` to `error`, and continues running. Click **Resync** on the Home screen (or trigger another change) after Caddy recovers.
- Reconciling Caddy updates the HTTP server config and triggers a Caddy reload. Active WebSocket connections on Apps close after Caddy's configured grace period, so apps that use WebSockets need normal reconnect logic.
- Unmatched hostnames reaching Caddy's Pimote server receive HTTP `404` (`Unknown Pimote app`).
