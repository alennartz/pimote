## Deployment

Pimote runs as a systemd user service on the host.

### Service

- **Unit**: `systemd service`
- **Port**: 3000 (from `~/.config/pimote/config.json`)
- **Env vars**: `env file` (credentials)
- **Linger**: enabled — survives logout
- **Node**: pinned to `node`

### Make targets

```
make deploy     # build + (re)start service
make redeploy   # rebuild + restart
make undeploy   # stop service
make logs       # journalctl -f
make status     # systemctl status
```

### Direct systemctl / journalctl

```bash
systemctl --user status pimote
systemctl --user restart pimote
journalctl --user -u pimote -f        # live logs
journalctl --user -u pimote --since "5 min ago"
```

### No HTTPS yet

Running plain HTTP. Push notifications and PWA install require HTTPS.
