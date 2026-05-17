# Agent Command Lifecycle

## Plain English

The agent listens for commands in two ways:

- WebSocket gives it a fast nudge that "a command is available"
- heartbeat is the reliable check-in where the server and agent confirm what actually happened

Phase 4 does not start the Supabase Realtime watcher. The server may still write
the old session projection for rollback builds, but this agent uses first-party
WebSocket wake hints plus heartbeat.

Runtime API calls use the registered device credential (`X-Agent-Id` and `X-Agent-Secret`). The dashboard profile API key is only used by setup to call `POST /api/agent/register`; if the saved Server URL or API key changes, the agent discards the old device credential and registers again.

Those two things do different jobs.

WebSocket is only meant to wake the agent up quickly when the server queues a new command like:

- `scrape_now`
- `stop_scrape`
- `pause`
- `resume`
- `check_update`

For `scrape_now`, the queued command may now carry an optional payload:

- no payload: scrape all enabled modules
- `{ module: "avto-net" }`: scrape exactly that one enabled module

Heartbeat is where the agent confirms:

- whether the scheduler is paused
- which command it has already applied
- which scrape job is actively running right now
- whether a specific job failed

That separation matters because the `agent_sessions` row changes for lots of reasons besides new commands. While a scrape is running, the server may update heartbeat timestamps, active-job lease timestamps, and cleanup fields. Those updates must not wake the agent up as if a brand-new command arrived.

In short:

- WebSocket is a fast hint
- heartbeat is the source of truth
- job start and job results are the source of truth for scrape lifecycle

## Technical Contract

### Command delivery

The server queues commands in durable `agent_commands` rows and sends a
`command.available` WebSocket hint containing:

- `commandId`
- `command`

The hint is intentionally minimal. The next heartbeat fetches the authoritative
command and payload.

For rollback support, the server may still project commands on `agent_sessions`
using:

- `pending_command`
- `pending_command_id`
- optional `pending_command_payload`

Phase 4 agents do not subscribe to `agent_sessions`. Older rollback agents that
use the Realtime watcher should only trigger an immediate heartbeat when the
command envelope changes:

- `pending_command`
- `pending_command_id`

It must ignore row churn caused by:

- `last_heartbeat`
- `active_job_id`
- `active_job_lease_at`
- job cleanup after completion/failure
- other non-command session fields

### ACK behavior

The server keeps a queued command until the agent applies it and heartbeats back:

- `ackCommandId`

The scheduler sets a local pending ACK after successfully applying:

- `pause`
- `resume`
- `scrape_now`
- `stop_scrape`
- `check_update`

ACK behavior is unchanged by command payloads. A module-scoped `scrape_now` still ACKs the same single command envelope.

The next heartbeat includes that `ackCommandId`. Once the server no longer echoes the same `commandId`, the scheduler clears the local pending ACK.

### Job lifecycle

Command ACK and job lifecycle are separate.

For scrape jobs, the correct sequence is:

1. The server schedules a job as `pending`
2. The agent calls `POST /api/agent/jobs/:id/start`
3. The server marks that exact job `running`
4. The agent heartbeats with `activeJobId`
5. The agent sends `POST /api/agent/results` for that same `jobId`
6. The server marks that exact job `completed`

The agent must never rely on heartbeat alone to imply that a job started or completed.

### Startup failure

If the agent cannot start the job after receiving it, it should report the failure explicitly for that job id.

The scheduler now does this by heartbeating:

- `failureMsg`
- `failureJobId`
- `activeJobId` still set to that job for the failure heartbeat

That allows the server to move:

- `pending -> failed`

without pretending the job ever reached a healthy running state.

### Running failure

If scraping or result delivery fails after the job has already started, the scheduler heartbeats:

- `failureMsg`
- `failureJobId`
- `activeJobId`

and only clears the local active job after sending that failure heartbeat.

That allows the server to move:

- `running -> failed`

for the correct job without racing through a false idle snapshot.

### Pause and resume

`pause` and `resume` are scheduler-level commands only.

They do not mean:

- pause the current module mid-request
- suspend one running job in place

Current meanings:

- `scrape_now`: run all enabled modules, or exactly one module when the server includes `commandPayload.module`
- `pause`: stop future scheduled scrapes
- `resume`: restore the countdown for future scheduled scrapes
- `stop_scrape`: stop the active scrape after the current module completes

### WebSocket wake compatibility with AUT-208 Phase 4

AUT-208 Phase 4 makes command pickup faster by using the first-party WebSocket.

That remains correct as long as WebSocket stays a wake hint only. If the agent
starts trusting WS payloads as command truth, it can diverge from heartbeat ACK
and durable `agent_commands` ordering.

The intended model is:

- the server commits a durable `agent_commands` row
- the server sends `command.available` to the targeted connected agent
- the agent dedupes the command id and sends an immediate heartbeat
- the heartbeat returns the command
- the scheduler applies it
- the next heartbeat ACKs it

### Supabase Realtime rollback compatibility

Supabase Realtime projection can still exist while Phase 4 soaks, but the Phase
4 agent should not start the Realtime watcher. A rollback to the previous agent
build can still use the session projection if needed.

The Phase 4 WebSocket client should:

- call `GET /api/agent/ws-token` with `X-Agent-Id` and `X-Agent-Secret`
- connect to `/api/agent/ws?token=...`
- log connect, close, token refresh, reconnect, and command wake events
- refresh by reconnecting before the token expires
- heartbeat immediately on `command.available` and after reconnect
- include heartbeat `wakeSource` diagnostics for startup, WS connect, WS command wake, ACK follow-up, and failure reporting during Phase 5 soak

## What to watch for in testing

- Run Scrape should look like `pending -> running -> completed`
- a module-scoped Run Scrape should only start the targeted module and should only receive one scheduled job row for that scrape cycle
- a healthy run should never flash `failed`
- startup failure should mark the specific queued job failed
- result-upload failure should fail the currently active job, not a random one
- duplicate WebSocket command hints should not cause duplicate command execution
- pause/resume should feel instant with WebSocket but still finalize through heartbeat ACK
- Admin Fleet should show whether the agent has an active WS connection while Admin Overview tracks wake sent/missed and command latency
