---
title: Environment variables
description: Every variable the server reads, with its default.
---

Configure the server through environment variables, set in the `environment:` block of your compose file. For runtime configurable values see [Settings](/docs/using/settings/).

## Core

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Port the server listens on. |
| `VAULT_ROOT` | `/vaults` | Directory holding your vaults, one sub-folder per vault. |
| `DATA_ROOT` | `/app/data` | Directory for Ignis state: server plugin config, sync state, and tokens. |

## Obsidian

| Variable | Default | Description |
| --- | --- | --- |
| `OBSIDIAN_VERSION` | `1.12.7` | Obsidian version fetched on first run. Each release pins a known-good version. |
| `OBSIDIAN_PACKAGE` | unset | Path to a pre-placed Obsidian package (`.deb`, `.asar.gz`, or `.asar`) to unpack instead of downloading, for offline installs. |
| `OBSIDIAN_ASSETS_PATH` | `/app/obsidian-app` | Where the extracted Obsidian files live. Point it at a pre-extracted directory to skip the download. |

## File ownership

| Variable | Default | Description |
| --- | --- | --- |
| `PUID` | `1000` | User ID that owns the files Ignis writes. |
| `PGID` | `1000` | Group ID that owns the files Ignis writes. |

## Networking and security

| Variable | Default | Description |
| --- | --- | --- |
| `WS_ORIGINS` | unset | Comma-separated allowlist of `Origin` values (with scheme) matched exactly against the browser's request. Any origin is accepted when unset. |
| `PROXY_ALLOW_PRIVATE_HOSTS` | unset | Comma-separated IPs or IPv4 CIDRs the cross-origin proxy may reach despite its private-address block. When unset, the proxy reaches no private host. Reopens SSRF to the listed targets. |

For example:

```yaml
    environment:
      - WS_ORIGINS=https://ignis.example.com
      - PROXY_ALLOW_PRIVATE_HOSTS=192.168.1.10,10.0.0.0/24
```

## Startup and performance

| Variable | Default | Description |
| --- | --- | --- |
| `AUTO_CREATE_DEFAULT` | `false` | Create a "My Vault" vault on startup when none exist. |
| `WRITE_COALESCE_MS` | `0` | Debounce window in milliseconds for rapid writes. Raise it on slow filesystems such as rclone, NFS, or SMB. |

## Child process compatibility

| Variable | Default | Description |
| --- | --- | --- |
| `IGNIS_CHILD_PROCESS` | unset | Set to `enabled` to expose the trusted-plugin `child_process` compatibility path. It is disabled by default and always disabled in demo mode. |
| `IGNIS_CHILD_PROCESS_MAX_PROCESSES` | `8` | Maximum active asynchronous child processes across the server. |
| `IGNIS_CHILD_PROCESS_MAX_PROCESSES_PER_SESSION` | `4` | Maximum active asynchronous children for one browser session and vault. |
| `IGNIS_CHILD_PROCESS_MAX_TIMEOUT_MS` | `600000` | Maximum requested process timeout. |

This is not OS confinement. Enabled commands run as the server user and can access mounted files and network resources available to that user. Use authentication, `WS_ORIGINS`, container-level permissions, and a trusted-plugin policy.

---

Demo mode adds its own `DEMO_*` variables for running a public, throwaway instance. See [`examples/demo/`](https://github.com/Nystik-gh/ignis/tree/main/apps/ignis-server/examples/demo) in the repository.
