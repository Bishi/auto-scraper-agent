# TODO

## Agent lifecycle: align client with authoritative active-job ownership

### In progress
- Update the scheduler and API client so job start, results, and failures always carry the correct per-job lifecycle signals expected by the server.
- Tighten the Supabase Realtime watcher so only command-envelope changes trigger an immediate wake-up heartbeat.
- Add tests and docs that explain the command ACK flow, active-job heartbeats, startup failure reporting, and Realtime compatibility behavior.
