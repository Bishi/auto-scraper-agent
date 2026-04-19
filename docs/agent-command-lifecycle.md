# Agent Command Lifecycle

## Plain English

The agent listens for commands in two ways:

- Realtime gives it a fast nudge that "something changed"
- heartbeat is the reliable check-in where the server and agent confirm what actually happened

Those two things do different jobs.

Realtime is only meant to wake the agent up quickly when the server queues a new command like:

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

- Realtime is a fast hint
- heartbeat is the source of truth
- job start and job results are the source of truth for scrape lifecycle

## Technical Contract

### Command delivery

The server queues commands on `agent_sessions` using:

- `pending_command`
- `pending_command_id`
- optional `pending_command_payload`

The agent Realtime watcher subscribes to `agent_sessions`, but it should only trigger an immediate heartbeat when the command envelope changes:

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

### Realtime compatibility with AUT-175

AUT-175 made command pickup faster by using Supabase Realtime.

That remains correct as long as Realtime stays scoped to command-envelope changes only. If the agent starts waking up for lease refreshes or generic heartbeat writes, it can create noisy loops and duplicate work.

The intended model is:

- Realtime notices a newly queued command
- the agent sends an immediate heartbeat
- the heartbeat returns the command
- the scheduler applies it
- the next heartbeat ACKs it

## What to watch for in testing

- Run Scrape should look like `pending -> running -> completed`
- a module-scoped Run Scrape should only start the targeted module and should only receive one scheduled job row for that scrape cycle
- a healthy run should never flash `failed`
- startup failure should mark the specific queued job failed
- result-upload failure should fail the currently active job, not a random one
- lease-only session updates should not cause a Realtime-triggered heartbeat
- pause/resume should feel instant with Realtime but still finalize through heartbeat ACK
