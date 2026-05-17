# Agent Command Lifecycle

## Plain English

The agent listens for commands through a first-party WebSocket wake hint and
confirms all command truth through heartbeat.

Runtime API calls use the registered device credential (`X-Agent-Id` and
`X-Agent-Secret`). The dashboard profile API key is only used by setup to call
`POST /api/agent/register`; if the saved Server URL or API key changes, the
agent discards the old device credential and registers again.

WebSocket is only meant to wake the agent quickly when the server queues a new
command like:

- `scrape_now`
- `stop_scrape`
- `pause`
- `resume`
- `check_update`

For `scrape_now`, the queued command may carry an optional payload:

- no payload: scrape all enabled modules
- `{ module: "avto-net" }`: scrape exactly that one enabled module

Heartbeat is where the agent confirms:

- whether the scheduler is paused
- which command it has already applied
- which scrape job is actively running right now
- whether a specific job failed

In short:

- WebSocket is a fast hint
- heartbeat is the source of truth
- job start and job results are the source of truth for scrape lifecycle

## Technical Contract

### Command Delivery

The server queues commands in durable `agent_commands` rows and sends a
`command.available` WebSocket hint containing:

- `commandId`
- `command`

The hint is intentionally minimal. The next heartbeat fetches the authoritative
command and payload.

The agent dedupes repeated WebSocket hints by `commandId`. On reconnect it also
heartbeats immediately, so missed hints are recovered by the heartbeat path.

### ACK Behavior

The server keeps a queued command until the agent applies it and heartbeats back:

- `ackCommandId`

The scheduler sets a local pending ACK after successfully applying:

- `pause`
- `resume`
- `scrape_now`
- `stop_scrape`
- `check_update`

ACK behavior is unchanged by command payloads. A module-scoped `scrape_now` still
ACKs the same single command id.

After ACKing one command, the agent immediately heartbeats again until the server
returns no command.

### Job Lifecycle

Command ACK and job lifecycle are separate.

For scrape jobs, the correct sequence is:

1. The server schedules a job as `pending`
2. The agent calls `POST /api/agent/jobs/:id/start`
3. The server marks that exact job `running`
4. The agent heartbeats with `activeJobId`
5. The agent sends `POST /api/agent/results` for that same `jobId`
6. The server marks that exact job `completed`

The agent must never rely on heartbeat alone to imply that a job started or
completed.

### Startup Failure

If the agent cannot start a job after receiving it, it reports the failure
explicitly for that job id by heartbeating:

- `failureMsg`
- `failureJobId`
- `activeJobId` still set to that job for the failure heartbeat

That allows the server to move `pending -> failed` without pretending the job
ever reached a healthy running state.

### Running Failure

If scraping or result delivery fails after the job has already started, the
scheduler heartbeats:

- `failureMsg`
- `failureJobId`
- `activeJobId`

and only clears the local active job after sending that failure heartbeat.

### Pause And Resume

`pause` and `resume` are scheduler-level commands only.

They do not mean:

- pause the current module mid-request
- suspend one running job in place

Current meanings:

- `scrape_now`: run all enabled modules, or exactly one module when the server includes `commandPayload.module`
- `pause`: stop future scheduled scrapes
- `resume`: restore the countdown for future scheduled scrapes
- `stop_scrape`: stop the active scrape after the current module completes

## What To Watch For In Testing

- Run Scrape should look like `pending -> running -> completed`
- a module-scoped Run Scrape should only start the targeted module and should only receive one scheduled job row for that scrape cycle
- a healthy run should never flash `failed`
- startup failure should mark the specific queued job failed
- result-upload failure should fail the currently active job, not a random one
- duplicate WebSocket command hints should not cause duplicate command execution
- pause/resume should feel instant with WebSocket but still finalize through heartbeat ACK
- heartbeat fallback should discover queued commands when WebSocket is blocked
