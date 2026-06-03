# TODO

## Agent lifecycle: align client with authoritative active-job ownership

### Done
- Update the scheduler and API client so job start, results, and failures always carry the correct per-job lifecycle signals expected by the server.
- Tighten the Supabase Realtime watcher so only command-envelope changes trigger an immediate wake-up heartbeat.
- Add tests and docs that explain the command ACK flow, active-job heartbeats, startup failure reporting, and Realtime compatibility behavior.

## Renderer: log spacing + scrape button states

### Done
- Inspect the current renderer log row layout and copy-normalization path to keep copy/paste spacing correct while tightening the visual gap.
- Update the renderer scrape controls so `Run Scrape` disables only while a scrape is running, and `Stop` disables whenever no scrape is running.
- Run the available verification for renderer-side changes and document any gaps.

### Review
- Tightened the log grid in `renderer/index.html` so the level column no longer reserves an extra dead character between `INF`/`WRN`/`ERR` and the message.
- Replaced the timer-based scrape button resets in `renderer/renderer.js` with real renderer-side running/pending state so `Run Scrape` stays disabled while a scrape is active and `Stop` stays disabled whenever nothing is running.
- Verification: `node --check renderer/renderer.js` passed. The repo script `npm run typecheck` is currently broken here because `tsc` is not installed on PATH for this repo, and `npx tsc` also cannot run because `typescript` is not installed locally.

## Agent lifecycle: remove broken visibility-hint path

### Done
- Remove the advisory cycle-visibility hint call from the agent protocol so manual and scheduled scrapes stop sending a signal that does not actually wake the dashboard in time.
- Keep the renderer scrape-control improvements intact while bumping the desktop/sidecar version forward from `0.6.23`.
- Re-run focused scheduler verification after removing the hint-specific tests.
