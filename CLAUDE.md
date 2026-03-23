# auto-scraper-agent — Claude Code Instructions

This file contains project-specific instructions for Claude Code when working in this repository.

---

## Repo Layout

```
scraper-node/        ← Node.js sidecar (Playwright scraper, HTTP on :9001)
  src/
    modules/         ← avto-net, bolha, proteini-si (selectors / parser / index)
    scheduler.ts     ← scrape loop, pause/resume, heartbeat
    index.ts         ← HTTP server entry, AGENT_VERSION
  tests/             ← Vitest parser tests + scheduler tests
src-tauri/           ← Rust Tauri shell (tray, sidecar spawn, update flow)
renderer/            ← Setup/logs window (plain HTML/JS)
```

## Dev Workflow

- **Parser tests** (no server needed): `cd scraper-node && npm test`
- **Watch mode**: `npm run test:watch`
- **Typecheck**: `npm run typecheck:tests`
- **ALWAYS bump version + tag before pushing** — a plain `git push` does NOT trigger a GitHub Actions build. See release steps below.

## Release Steps (NEVER skip)

1. Bump `"version"` in `src-tauri/tauri.conf.json`
2. Bump `AGENT_VERSION` in `scraper-node/src/index.ts`
3. `git add`, `git commit`
4. `git tag vX.Y.Z && git push && git push origin vX.Y.Z`

All PRs target **`main`**.

---

## Workflow Principles

### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately — don't keep pushing
- Write detailed specs upfront to reduce ambiguity

### 2. Self-Improvement Loop
- After ANY correction from the user: **IMMEDIATELY update `tasks/lessons.md` in the server repo (`C:\Github\auto-scrapper\tasks\lessons.md`) — do this BEFORE writing any more code**
- "Corrections" include: wrong assumptions, API signatures, type errors, wrong keys, UX bugs caught by the user, any moment the user says "that's wrong" or fixes your output
- At the **END of every session**: review what was corrected and add lessons for anything missed
- Write rules for yourself that prevent the same mistake

### 3. Verification Before Done
- Never mark a task complete without proving it works
- Run `npm test` and `npm run typecheck:tests` before considering a change complete
- Ask yourself: "Would a staff engineer approve this?"

### 4. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer

---

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards
- **Reuse Before You Write**: Before writing any formatting, mapping, or utility logic — search the codebase first. Key shared modules in `scraper-node/src/`: `modules/registry.ts`, any shared parser helpers. If a function already exists that covers the use case — import it. If the same logic is needed in 2+ places and no shared home exists yet — create one immediately, then use it everywhere. The user should never have to ask "did you reuse X?"

---

## Module Structure (required pattern)

Every scraper module:
- `src/modules/<name>/selectors.ts` — CSS selectors only
- `src/modules/<name>/parser.ts` — pure `parseListings(html, sourceUrl): Listing[]`
- `src/modules/<name>/index.ts` — class extending `ScraperModule`

See server repo `skills/modules.md` for full checklist.

## Sidecar Architecture Notes

- HTTP server on `127.0.0.1:9001`
- **All responses must include `Access-Control-Allow-Origin: *`** — WebView2 enforces CORS even for localhost
- **OPTIONS preflight must return `204`**
- `AGENT_VERSION` must be bumped in both `scraper-node/src/index.ts` AND `src-tauri/tauri.conf.json`
