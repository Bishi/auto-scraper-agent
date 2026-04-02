# Auto-Scraper Agent

A Windows system tray app that runs scrape jobs on a schedule and reports results back to your Auto-Scraper server.

**This repository** is open source under the MIT License. The **hosted dashboard / server** (`auto-scraper`) is a separate, **proprietary** codebase — only the agent is licensed here under MIT.

## Legal & privacy

- [LICENSE](LICENSE) — MIT
- [SECURITY.md](SECURITY.md) — vulnerability reporting and how secrets are handled
- [PRIVACY.md](PRIVACY.md) — local config and what leaves your machine

The full **End User License Agreement** text shown in the NSIS installer is in [`src-tauri/EULA.txt`](src-tauri/EULA.txt).

## Scraping disclaimer

You are solely responsible for lawful use and for complying with each target site's terms of service. Do not bypass anti-bot measures or access controls. The software is provided "as is," without warranty, for lawful monitoring only. See `EULA.txt` for the complete terms.

---

## Using the agent

### First launch

After installing, the agent window opens automatically to the **Settings** tab. Enter your Server URL and API key (from the dashboard under **Settings → API**) and click Save. The agent saves these to `~/.auto-scraper/agent.json` and starts the scheduler immediately. On all subsequent launches the window opens on the **Agent** tab instead — no re-entry needed.

### Tray icon

The agent lives in your system tray. Hover over it to see the next scheduled scrape time (updates every 30 seconds, shows "scraping now…" during a run).

**Left-click** — opens the agent window (Agent tab when configured, Settings tab otherwise).

**Right-click** menu:

| Item | What it does |
|------|-------------|
| Run Now | Triggers an immediate scrape and opens the Agent tab so you can watch progress |
| Open Dashboard | Opens your server's dashboard in the browser |
| Settings / Setup | Opens the agent window on the Settings tab to update credentials |
| Check for Updates | Checks GitHub for a newer version and prompts to download and install |
| Quit | Gracefully shuts down the scheduler and sidecar, then exits |

### Dashboard Agent page

The **Agent** tab on your server dashboard is the primary control surface. It shows the agent's online/offline status, last heartbeat time, next scrape time, and recent job history.

| Control | What it does |
|---------|-------------|
| Run scrape | Triggers an immediate scrape. The button shows a spinner and locks until the agent picks up the command on its next heartbeat (~60 s), then unlocks once a job appears. |
| Stop scrape | Aborts the active scrape. The current module finishes first, then the run stops. |
| Pause / Resume | Pauses or resumes the scheduler. The change propagates on the next heartbeat. |
| Check for updates | Sends an update-check command through the server to the agent. The agent sets a badge in its window; no dialog pops up automatically. |
| Download installer | Downloads the latest release installer directly. |

### Auto-updates

The agent silently checks GitHub 15 seconds after launch, then every 6 hours. If a newer version is found, a badge appears in the agent window — no dialog interrupts you. To install, click the badge or use **Check for Updates** from the tray. Download progress shows in the tray tooltip. The agent restarts automatically once the installer finishes.

### Crash recovery

If the Node.js sidecar crashes for any reason, the Tauri shell restarts it automatically within 3 seconds. It picks up its saved config from disk so the scheduler resumes without any user action.

---

## How it works

The agent is made of two processes that run side-by-side:

```
Tauri shell (Rust)
  └─ spawns ──► Node.js sidecar  →  http://127.0.0.1:9001
                  ├── scheduler (cron-like, heartbeats to server)
                  ├── Playwright + Chromium headless browser
                  └── scraper modules  (avto-net, bolha, proteini.si …)
```

The Rust shell handles the tray icon, setup window (WebView2), and auto-update prompts. The Node.js sidecar does all the scraping and communicates with your Auto-Scraper server over HTTP. The two processes talk to each other on `127.0.0.1:9001`, authenticated with an ephemeral shared secret generated on each sidecar startup — any other local process attempting to call the sidecar is rejected with `401 Unauthorized`.

Scraped data and heartbeats are sent to your server and surface across the dashboard — **Overview**, **Listings**, **Changes**, **Runs**, **Analytics**, and **Agent** tabs.

**Why Playwright?** avto.net and bolha.com use Cloudflare and Radware Bot Manager respectively, which block plain HTTP requests. Playwright drives a real Chromium instance to bypass these protections. Sites without bot protection (e.g. proteini.si) use `fetch()` instead and don't touch the browser.

---

## Running without an `.exe` (dev mode)

You only need Node.js — no Rust, no Tauri, no compiled binary.

### Prerequisites

- [Node.js](https://nodejs.org/) **22 or later**
- Your running Auto-Scraper server with an API key

### 1. Install dependencies

```bash
git clone https://github.com/Bishi/auto-scraper-agent.git
cd auto-scraper-agent

npm install
cd scraper-node && npm install && cd ..
```

### 2. Set up Chromium

The bundled Chromium headless shell needs to be downloaded once before building. It gets placed in `src-tauri/binaries/` where Tauri can bundle it into the installer.

```bash
cd scraper-node
node setup-chromium.mjs
cd ..
```

### 3. Build

```bash
npm run build
```

This runs two steps in sequence:

1. `build:sidecar` — compiles the Node.js source into a [Single Executable Application](https://nodejs.org/api/single-executable-applications.html) (`src-tauri/binaries/scraper-node-x86_64-pc-windows-msvc.exe`)
2. `build:tauri` — packages everything (sidecar + Chromium + Tauri shell) into an NSIS installer

The finished installer lands at:

```
src-tauri/target/release/bundle/nsis/Auto-Scraper.Agent_<version>_x64-setup.exe
```

### Code signing (optional)

Without a certificate the installer will build and run fine, but Windows SmartScreen will show an "Unknown publisher" warning on first launch. To sign:

1. Obtain a Windows code-signing certificate (`.pfx`). An EV certificate from DigiCert or Sectigo avoids SmartScreen warnings immediately; an OV certificate builds reputation over time.
2. Sign the sidecar before the Tauri build, then sign the NSIS installer:

```powershell
signtool sign /f cert.pfx /p <password> `
  /tr http://timestamp.digicert.com /td sha256 /fd sha256 `
  src-tauri\binaries\scraper-node-*.exe

# then run the Tauri build, then sign the output installer:
signtool sign /f cert.pfx /p <password> `
  /tr http://timestamp.digicert.com /td sha256 /fd sha256 `
  "src-tauri\target\release\bundle\nsis\*.exe"
```

The CI pipeline handles both signing rounds automatically when `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` secrets are set in the GitHub repository.

### Using CI instead (recommended for releases)

Push a version tag to trigger the full pipeline:

```bash
# Bump version in both places first:
#   src-tauri/tauri.conf.json  → "version"
#   scraper-node/src/index.ts  → AGENT_VERSION

git add src-tauri/tauri.conf.json scraper-node/src/index.ts
git commit -m "chore: bump version to 0.5.x"
git tag v0.5.x
git push && git push origin v0.5.x
```

> A plain `git push` does **not** start CI. The tag push is what triggers the build.

For a test build from a feature branch without tagging, go to **Actions → Release → Run workflow** and select your branch. The artifact is uploaded to the rolling `latest` pre-release.

---

## Testing

See [TESTING.md](TESTING.md) for the full manual and automated test checklist, including how to test the SEA binary, the auto-update flow, and what to verify after installing a new build.
For the command, ACK, heartbeat, and Supabase Realtime contract specifically, see [docs/agent-command-lifecycle.md](docs/agent-command-lifecycle.md).

```bash
# Unit tests (parser tests, runs in Node via Vitest)
cd scraper-node
npm test
```

---

## Security

Credentials are never baked into the binary. The API key and server URL are entered at first launch and saved only to `~/.auto-scraper/agent.json` on the local machine. The local sidecar HTTP server is protected by an ephemeral token so other processes on the machine cannot read your API key or trigger scrapes.

See [SECURITY.md](SECURITY.md) for the full credential model, sidecar authentication, what is and isn't in the compiled binary, and how to report a vulnerability.

---

## License

[MIT](LICENSE)
