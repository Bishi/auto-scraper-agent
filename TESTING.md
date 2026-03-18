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
[agent] Auto-Scraper agent v0.1.x listening on http://127.0.0.1:9001
[agent] Loaded saved config: serverUrl=https://...
```

If no saved config: POST one first (see step 3).

## 2. Confirm it responds

```bash
curl http://127.0.0.1:9001/health
# → {"hasApiKey":true,"version":"0.1.x"}
```

## 3. Configure (first run or after wiping config)

```bash
curl -X POST http://127.0.0.1:9001/config \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"<your-api-key>","serverUrl":"http://localhost:3000"}'
```

## 4. Trigger a scrape and watch for errors

```bash
curl -X POST http://127.0.0.1:9001/scrape/now
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
git commit -m "chore: bump version to 0.1.x"
git tag v0.1.x
git push && git push --tags
```

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
https://github.com/Bishi/auto-scraper-agent/releases/download/v{version}/Auto-Scraper-Agent_{version}_x64-setup.exe
```
Example:
```
https://github.com/Bishi/auto-scraper-agent/releases/download/v0.3.5/Auto-Scraper-Agent_0.3.5_x64-setup.exe
```

### Always-latest stable (GitHub redirect)
```
https://github.com/Bishi/auto-scraper-agent/releases/latest/download/Auto-Scraper-Agent_{version}_x64-setup.exe
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
https://github.com/Bishi/auto-scraper-agent/releases/download/latest/Auto-Scraper-Agent_{version}_x64-setup.exe
```
Tagged `latest`, marked pre-release. Use for testing unreleased builds.

## What to test after installing

1. App appears in system tray
2. Setup window opens (or skips if API key already saved)
3. "Run Now" tray menu item triggers a scrape
4. Dashboard shows the new scrape run with listings
