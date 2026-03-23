# Security & Secret Handling

## Reporting a vulnerability

**Preferred:** use [GitHub private security advisories](https://docs.github.com/en/code-security/security-advisories) on this repository if they are enabled.

**Otherwise:** follow **Reporting a security issue** at the end of this document (private contact — do not file public issues for unfixed vulnerabilities).

---

This document explains how the auto-scraper agent handles credentials, what is (and is not) embedded in the compiled binary, and how to provision secrets at runtime.

---

## What is embedded in the compiled binary?

**Nothing sensitive.** The `.exe` produced by the GitHub Actions build pipeline contains:

| Data | In binary? | Notes |
|------|-----------|-------|
| API key | ❌ No | Entered by user at first launch, stored locally |
| Server URL | ❌ No | Entered by user at first launch, stored locally |
| Database credentials | ❌ No | Never used by the agent |
| Code-signing certificate | ❌ No | Injected during CI only, not baked into the binary |
| `AGENT_VERSION` string | ✅ Yes | Version identifier only — not a secret |
| Localhost port `9001` | ✅ Yes | Internal only, not exposed to the network |

The build pipeline does not inject any environment variables or secrets into the binary. You can verify this in `.github/workflows/release.yml` — the only GitHub Secrets used (`WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`) are for Authenticode code signing and exist only for the duration of the CI job.

---

## How are credentials provisioned at runtime?

### First launch

1. The Tauri shell starts the Node.js sidecar on `127.0.0.1:9001`.
2. The sidecar generates a random 32-byte ephemeral token and writes it to stdout (`SIDECAR_TOKEN=<hex>`). The Rust watchdog captures this and stores it in memory. The renderer retrieves it via the `get_sidecar_token` Tauri command. This token is required on every HTTP request to the sidecar (see [Sidecar HTTP authentication](#sidecar-http-authentication) below).
3. The setup window opens automatically (WebView2).
4. The user enters their **Server URL** and **API key** obtained from the dashboard (`Settings → API`).
5. On submit, the Tauri shell calls `invoke("save_config", { serverUrl, apiKey })`.
6. The Rust backend POSTs `{ serverUrl, apiKey }` to `http://127.0.0.1:9001/config` with the `X-Sidecar-Token` header.
7. The sidecar writes the config to `~/.auto-scraper/agent.json` and starts the scheduler.

### Subsequent launches

1. The sidecar reads `~/.auto-scraper/agent.json` on startup.
2. If valid, it reconnects to the server without prompting the user again.
3. The setup window is skipped; only the system tray icon appears.

### Updating credentials

Open the setup window again (right-click the tray icon → **Settings**), enter new values, and save. The sidecar updates `agent.json` and restarts the scheduler.

---

## Where are credentials stored?

| Location | Format | What's in it |
|----------|--------|-------------|
| `~/.auto-scraper/agent.json` | JSON | `serverUrl` and `apiKey` only |
| Binary (`.exe`) | – | Nothing sensitive |
| Windows Registry | – | Nothing (Tauri does not write credentials to the registry) |
| Environment variables | – | Nothing (agent doesn't rely on env vars for secrets) |
| Rust process memory | In-memory only | Ephemeral sidecar token — discarded on app exit, regenerated on every sidecar start |

---

## Sidecar HTTP authentication

The sidecar HTTP server (`127.0.0.1:9001`) requires an `X-Sidecar-Token` header on every request except:

- `OPTIONS` preflight requests (browsers never include custom headers in preflights)
- `GET /health` (used by the Rust shell to detect readiness before the token is available)

The token is a random 32-byte hex string generated on each sidecar startup. It is never written to disk, never logged, and is only accessible to the Tauri process that spawned the sidecar. Any other local process attempting to call the sidecar without the token receives a `401 Unauthorized` response.

The `agent.json` file is created by the sidecar and is readable only by the current user on a standard Windows installation. Consider restricting permissions further (`icacls "%USERPROFILE%\.auto-scraper\agent.json" /inheritance:r /grant:r "%USERNAME%":F`) if you're deploying in a shared-machine environment.

---

## Build pipeline — GitHub Actions

The `release.yml` workflow:

1. Checks out the repository (no secrets committed).
2. Runs `npm audit --audit-level=high` on both `package.json` files.
3. Runs parser tests (`npm test` in `scraper-node/`).
4. Builds the Node.js SEA sidecar (`node build.mjs`).
5. Downloads the bundled Chromium headless shell.
6. Builds the Tauri installer (NSIS) with Authenticode signing:
   - `WINDOWS_CERTIFICATE` — base64-encoded `.pfx` file, stored as a GitHub Secret.
   - `WINDOWS_CERTIFICATE_PASSWORD` — password for the `.pfx`, stored as a GitHub Secret.
   - Both are used only during the `tauri build` step and are never written to disk in the repo.
7. Uploads the `.exe` installer to a versioned GitHub Release.

**No API keys, database credentials, or server URLs are used during the build.** The binary is completely credential-free.

---

## Rotating the API key

1. In the dashboard, go to **Settings → API** and generate a new key.
2. On the agent machine, right-click the tray icon → **Settings**.
3. Enter the new API key and save.
4. The sidecar overwrites `agent.json` and reconnects immediately.

The old key is invalidated server-side; the agent will fail heartbeats until the new key is saved.

---

## Reporting a security issue

Please do **not** file a public GitHub issue for security vulnerabilities. Contact the maintainer directly via email (listed on the GitHub profile) with a description of the issue and steps to reproduce.
