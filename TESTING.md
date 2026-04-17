# Local Testing Guide

Before pushing scraper-node changes or tagging a release, test the sidecar
locally to make sure it starts and can actually scrape.

## 1. Run the sidecar in dev mode

```bash
cd scraper-node
npm run dev
```

Expected output:
```
[agent] Auto-Scraper agent v0.4.x listening on http://127.0.0.1:9001
[agent] Loaded saved config: serverUrl=https://...
```

If no saved config: POST one first (see step 3).

## 2. Confirm it responds

```bash
curl http://127.0.0.1:9001/health
# → {"hasApiKey":true,"version":"0.4.x"}
```

`/health` is intentionally public — it's used by the Rust shell to detect sidecar readiness before the token is available.

## 2a. Get the sidecar token

All other endpoints require the `X-Sidecar-Token` header. The token is printed to the terminal on startup:

```
SIDECAR_TOKEN=a3f9c2...  ← copy this value
```

Set it in your shell for the steps below:

```bash
TOKEN=<paste token here>
```

## 3. Configure (first run or after wiping config)

```bash
curl -X POST http://127.0.0.1:9001/config \
  -H "Content-Type: application/json" \
  -H "X-Sidecar-Token: $TOKEN" \
  -d '{"apiKey":"<your-api-key>","serverUrl":"http://localhost:3000"}'
```

## 4. Trigger a scrape and watch for errors

```bash
curl -X POST http://127.0.0.1:9001/scrape/now \
  -H "X-Sidecar-Token: $TOKEN"
```

Watch the sidecar terminal. A successful scrape prints module names and
listing counts with no stack traces. Common failure signatures:

| Symptom in logs | Likely cause |
|-----------------|--------------|
| `ERR_UNKNOWN_BUILTIN_MODULE` | A `require('pkg')` survived into the SEA bundle unbundled — add an esbuild stub in `build.mjs` |
| `require.resolve is not a function` | Node ≥ 24 SEA — covered by the `requireResolvePolyfill` banner in `build.mjs` |
| `Executable doesn't exist at …` | `CHROMIUM_PATH` not set and no bundled chromium found — only matters in the built .exe, not dev mode |
| Cloudflare challenge page, 0 listings | Bot detection — check `--disable-blink-features` arg and `addInitScript` in `context.ts` |
| Timeout / no listings | Selector or network issue — run with `headless: false` in config to watch the browser |

## 5. Test the SEA build before tagging

The local Node version may differ from CI (Node 22). Build and smoke-test
the binary on the local machine first:

```bash
cd scraper-node
node build.mjs               # produces dist/scraper-node.exe
./dist/scraper-node.exe      # should print the listening line within 3 s
```

If it prints the listening line, proceed to tag.
If it crashes, fix the issue in `build.mjs` or the source before tagging.

## 6. Tag a release

Bump the version in **both** places, then commit and tag:

| File | Field |
|------|-------|
| `src-tauri/tauri.conf.json` | `"version"` — controls installer filename, Tauri `app.getVersion()`, badge in window |
| `scraper-node/src/index.ts` | `AGENT_VERSION` — sent in heartbeat calls to the server |

```bash
# Edit both files, then:
git add src-tauri/tauri.conf.json scraper-node/src/index.ts
git commit -m "chore: bump version to 0.4.x"
git tag v0.4.x
git push && git push origin v0.4.x
```

> ⚠️ **Never `git push` without also pushing a tag.** A plain `git push` does NOT trigger a CI build. The tag push (`git push origin vX.Y.Z`) is what starts the GitHub Actions workflow.

### Branch build (Windows `.exe` without tagging)

Use this when you need an installer from a **feature branch** (e.g. QA before merge to `main`). **Pushing the branch does not start CI** — you must run the workflow manually.

1. Push your branch to GitHub.
2. Open **Actions** → workflow **Release** → **Run workflow**.
3. Under **Use workflow from**, select your branch (e.g. `bishi/aut-118-pause-ack-heartbeat`).
4. Run workflow. When it finishes (~10–20+ min), either:
   - Download artifact **`auto-scraper-agent-windows`** from the run, or  
   - Use the rolling **`latest`** pre-release (manual runs attach the NSIS installer there; see URLs below).

**CLI** (requires [`gh`](https://cli.github.com/) and repo access):

```bash
cd /path/to/auto-scraper-agent
gh workflow run "Release" --ref your-branch-name
```

**Notes**

- The **“Sync version from tag”** CI step only runs for **`v*.*.*` tags**. Branch builds use whatever version is already in `src-tauri/tauri.conf.json` and `AGENT_VERSION` in `scraper-node/src/index.ts` on that branch.
- Same full pipeline as a tag build (tests, SEA sidecar, Tauri NSIS); signing runs if `WINDOWS_CERTIFICATE` is configured.

## 7. Testing the auto-update flow

The agent checks for updates 15 seconds after launch via the GitHub Releases API. To test locally without a full release cycle:

1. Temporarily change `check_for_update()` in `src-tauri/src/lib.rs` to return a hardcoded fake tag (e.g. `Some("v99.0.0".to_string())`).
2. Run `cargo tauri dev` — after ~15 s a dialog should appear offering to download.
3. Revert the change before committing.

CI builds the NSIS installer and attaches it to a versioned GitHub Release.
Download from the Releases page and run the installer.

> **Version fields are synced automatically from the git tag by CI.**
> You still need to bump both files manually before tagging so the version
> shows correctly in local dev (`npm run dev`), but a mismatch will never
> ship — the CI "Sync version from tag" step overwrites both files before the
> build and the release upload.

## Release download URLs

### Specific version (stable)
```
https://github.com/Bishi/auto-scraper-agent/releases/download/v{version}/Auto-Scraper.Agent_{version}_x64-setup.exe
```
Example:
```
https://github.com/Bishi/auto-scraper-agent/releases/download/v0.5.27/Auto-Scraper.Agent_0.5.27_x64-setup.exe
```

### Always-latest stable (GitHub redirect)
```
https://github.com/Bishi/auto-scraper-agent/releases/latest/download/Auto-Scraper.Agent_{version}_x64-setup.exe
```
⚠️ The filename still contains the version number, so this URL changes with every release.
Use the GitHub API for a truly static download URL:

### GitHub API (machine-readable)
```
GET https://api.github.com/repos/Bishi/auto-scraper-agent/releases/latest
```
Returns JSON — `assets[0].browser_download_url` is the direct `.exe` link.
Useful for building an auto-update check: compare `tag_name` against the
running `AGENT_VERSION` to know if an update is available.

### Rolling pre-release (manual `workflow_dispatch` build)
```
https://github.com/Bishi/auto-scraper-agent/releases/download/latest/Auto-Scraper.Agent_{version}_x64-setup.exe
```
Tagged `latest`, marked pre-release. Use for testing unreleased builds.

## What to test after installing

See [`docs/agent-command-lifecycle.md`](docs/agent-command-lifecycle.md) for the expected Realtime + heartbeat behavior and job-state contract behind these checks.

### Persistence checks

1. Resize and move the setup window, close it, reopen the agent, and confirm the same bounds are restored
2. Maximize the setup window, close it, reopen the agent, and confirm it restores maximized
3. If `~/.auto-scraper/window-state.json` is missing or contains invalid dimensions, the window falls back to the default centered size
4. Pause the schedule from the agent UI, restart the agent, and confirm it stays paused on first launch without immediately scraping
5. Resume the schedule from the agent UI, restart the agent, and confirm the paused state stays cleared
6. Install an update while paused and confirm the relaunched agent still shows the schedule as paused
7. Install an update after resizing/maximizing the window and confirm the relaunched agent restores the last saved window state

### Existing lifecycle checks

1. App appears in system tray
2. Setup window opens (or skips if API key already saved)
3. "Run Now" tray menu item triggers a scrape
4. Dashboard shows the new scrape run with listings
5. Tray tooltip shows next scrape time (updates after each completed run)
6. Pause/Resume from the server dashboard propagates within one heartbeat (~60 s); resuming does **not** trigger an immediate scrape — the countdown is restored
7. **Trigger scrape** / **Stop scrape** (dashboard or server `/agent` page): server keeps the command until the sidecar heartbeats **`ackCommandId`** after applying (if a scrape is already running, `scrape_now` stays queued until the scheduler can start — not lost on first heartbeat)
8. Admin **Check for Updates** (fleet): same ack path as other commands — agent logs `Server command: check_update` and sets the update-check flag
9. "Check for Updates" in tray shows "up to date" dialog when on latest version

### Startup splash and schedule-state checks

1. On automatic startup, a splash window appears immediately and the setup window stays hidden until the first successful authenticated `/schedule` response
2. The splash opens already centered on the display with no visible jump, including when Windows display scaling is above 100%
3. The splash stays visible for at least 2 seconds even if startup finishes faster than that
4. Configured users still land on the Logs tab after the splash closes; unconfigured users still land on the default setup tab
5. When the setup window appears, the pause button never flashes the wrong state: it starts disabled, then enables as `Resume Schedule` if paused or `Pause Schedule` if not paused
6. Opening the app from the tray while the splash is still visible is allowed: the setup window may show early, and the later readiness handshake should only close the splash without breaking the window

### Single-instance checks

1. Launching the app twice produces only one tray icon
2. A second launch does not spawn a second sidecar or hit the `127.0.0.1:9001` collision path
3. If the second launch happens while the splash is visible, the existing splash window is brought to the front
4. If the second launch happens after startup, the existing setup window is restored/focused without changing the current tab
