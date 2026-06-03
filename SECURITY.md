# Security & Secret Handling

## Reporting a vulnerability

Preferred: use GitHub private security advisories on this repository if they are enabled.

Otherwise, follow **Reporting a security issue** at the end of this document. Do not file public issues for unfixed vulnerabilities.

This document explains how the Auto-Scraper Agent handles credentials, what is and is not embedded in the compiled binary, and how to provision secrets at runtime.

## What Is Embedded In The Compiled Binary?

Nothing sensitive. The binaries produced by the GitHub Actions build pipeline contain:

| Data | In binary? | Notes |
|------|------------|-------|
| Pairing code | No | Entered by the user, consumed once, never stored |
| Setup API key | No | Legacy/manual fallback only; stored locally only when that fallback is used |
| Agent ID + secret | No | Issued by the server after pairing or legacy registration, stored locally |
| Server URL | No | Entered or defaulted at first launch, stored locally |
| Database credentials | No | Never used by the agent |
| Code-signing certificate | No | Injected during CI only, not baked into the binary |
| `AGENT_VERSION` string | Yes | Version identifier only, not a secret |
| Localhost port `9001` | Yes | Internal only, not exposed to the network |

The build pipeline does not inject server credentials into the binary. Windows signing secrets are for Authenticode signing and exist only for the duration of the CI job. macOS CI currently uses ad-hoc signing for internal-test DMGs; public distribution still needs Apple Developer ID signing and notarization secrets.

## How Are Credentials Provisioned At Runtime?

### First Launch

1. The Tauri shell starts the Node.js sidecar on `127.0.0.1:9001`.
2. The sidecar generates a random 32-byte ephemeral token and writes it to stdout as `SIDECAR_TOKEN=<hex>`.
3. The Rust watchdog captures that token and stores it in memory. The renderer retrieves it via the `get_sidecar_token` Tauri command.
4. The setup window opens automatically.
5. The user generates a Mission Control pairing code in the dashboard, confirms the Server URL, and enters the code. If no URL is saved yet, the packaged UI defaults to `https://auto-scraper-develop.up.railway.app`.
6. The renderer posts `{ serverUrl, code }` to `http://127.0.0.1:9001/pairing/consume` with the `X-Sidecar-Token` header.
7. The sidecar calls `POST /api/auth/agent-pairing/consume`, receives an agent ID and one-time agent secret, writes the config to `~/.auto-scraper/agent.json`, and starts the scheduler with `X-Agent-Id` / `X-Agent-Secret`.
8. The legacy/manual API-key form remains available for older servers. When used, the sidecar calls `POST /api/agent/register` with the setup API key and then uses the returned per-device credentials for normal runtime calls.

### Subsequent Launches

1. The sidecar reads `~/.auto-scraper/agent.json` on startup.
2. If saved agent ID and secret credentials exist for the saved Server URL, it reconnects to the server without prompting the user again.
3. The sidecar mints short-lived WebSocket tokens from the server with those agent credentials when the WebSocket client connects or refreshes.
4. The setup window is skipped; only the system tray icon appears.

### Updating Credentials

Preferred path: open Mission Control, generate a new pairing code, open the agent Settings window, and pair with the new code.

Legacy fallback: open the setup window again, enter a new Server URL/API key in the legacy section, and save. If the Server URL or API key changed, the sidecar discards the saved agent ID/secret, registers a new device, updates `agent.json`, and restarts the scheduler.

## Where Are Credentials Stored?

| Location | Format | Contents |
|----------|--------|----------|
| `~/.auto-scraper/agent.json` | JSON | `serverUrl`, `agentId`, `agentSecret`, and optional legacy setup `apiKey` |
| Binary (`.exe` / `.app` / `.dmg`) | n/a | Nothing sensitive |
| Windows Registry | n/a | Nothing; Tauri does not write credentials to the registry |
| Environment variables | n/a | Nothing; the agent does not rely on env vars for secrets |
| Rust process memory | In-memory only | Ephemeral sidecar token, discarded on app exit and regenerated on every sidecar start |

## Sidecar HTTP Authentication

The sidecar HTTP server (`127.0.0.1:9001`) requires an `X-Sidecar-Token` header on every request except:

- `OPTIONS` preflight requests
- `GET /health`, used by the Rust shell to detect readiness before the token is available

The token is a random 32-byte hex string generated on each sidecar startup. It is never written to disk, never logged, and is only accessible to the Tauri process that spawned the sidecar. Any other local process attempting to call the sidecar without the token receives a `401 Unauthorized` response.

The `agent.json` file is created by the sidecar under `~/.auto-scraper/agent.json` and is intended to be readable only by the current user. On Windows shared-machine deployments, consider restricting permissions further:

```powershell
icacls "%USERPROFILE%\.auto-scraper\agent.json" /inheritance:r /grant:r "%USERNAME%":F
```

## Build Pipeline

The `release.yml` workflow:

1. Checks out the repository.
2. Runs `npm audit --audit-level=high` on both package files.
3. Runs parser tests in `scraper-node/`.
4. Builds the Node.js SEA sidecar.
5. Downloads the bundled Chromium headless shell.
6. Builds the Tauri installer:
   - Windows: NSIS with Authenticode signing when Windows signing secrets are configured.
   - macOS: DMG with ad-hoc signing for internal testing, hardened-runtime entitlements for the Node sidecar, and bundled Chromium runtime files.
7. Uploads installer assets to a versioned GitHub Release.

No API keys, database credentials, or private server secrets are used during the build. The binary is credential-free.

## Rotating Credentials

Preferred path:

1. In Mission Control, generate a new pairing code.
2. On the agent machine, right-click the tray icon and open Settings.
3. Enter the code and pair.
4. The sidecar overwrites `agent.json` with new device credentials and reconnects immediately.

Legacy API-key fallback:

1. In the dashboard, go to Settings -> API and generate a new key.
2. On the agent machine, right-click the tray icon and open Settings.
3. Enter the new API key in the legacy section and save.
4. The sidecar registers a new agent device, overwrites `agent.json`, and reconnects immediately.

## Reporting A Security Issue

Do not file a public GitHub issue for security vulnerabilities. Contact the maintainer directly via email listed on the GitHub profile with a description of the issue and steps to reproduce.
