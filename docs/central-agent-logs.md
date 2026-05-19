# Central Agent Logs

Central log upload is a bounded, batched diagnostic channel for agent lifecycle events. It is not a live tail and does not upload scraper progress logs from `pushScraperLog`; those remain local and run-scoped.

The enum constants and PII key list in `scraper-node/src/central-log-queue.ts` and `scraper-node/src/central-log-redaction.ts` are deliberately duplicated from the server repo. Keep them in sync with:

- `auto-scrapper/src/lib/agent-logs.ts`
- `auto-scrapper/src/lib/pii-purge.ts`

The agent redacts messages/context before writing the disk spool. The server re-redacts before insert and remains authoritative.
