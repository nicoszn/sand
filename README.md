# Agent Sandbox (TypeScript, single service)

Give it a task; it plans, searches the web, runs Python/JS, and reports back —
running in the background on Railway whether or not the UI is open.

This is the TypeScript rewrite: one Next.js 16.3 app instead of a separate
Python backend + Next.js frontend. API routes replace FastAPI, `better-sqlite3`
replaces `aiosqlite`, and the background worker runs inside the same
long-lived Node process via `instrumentation.ts`. Python is still available
at runtime, but only as a sandboxed *execution target* for the `run_python`
tool — the orchestrator itself is 100% TypeScript.

## Architecture

```
app/
  page.tsx, new/, tasks/[id]/, keys/, settings/   UI pages
  api/                                             Route Handlers = the backend
lib/
  api.ts            client-side fetch helpers
  server/            agent loop, key pool, tools, task queue, SQLite
instrumentation.ts   starts the background worker once at server boot
railpack.json         Railway build config (Node + Python via mise)
```

One Railway service. No CORS, no cross-service proxy — the UI and the API
are the same app on the same origin.

## Configuration

All app-wide constants live in one place: `lib/config.ts`. There are no
`process.env` reads anywhere in the app's own code - nothing here is meant
to vary per-deployment, so these are plain named values rather than
deployment variables:

| `config.*` | Value | What it controls |
|---|---|---|
| `dataDir` | `"data"` | where the SQLite file and the model cache live |
| `openrouterApiUrl` | OpenRouter's chat completions endpoint | - |
| `model` | `"openrouter/free"` | the one model the agent uses |
| `openrouterKeyFile` | `data/openrouter.key` | where the credential is read from |
| `embeddingsEnabled` | `true` | local semantic memory search; set `false` to skip the model |
| `embeddingsModel` | `Xenova/all-MiniLM-L6-v2` | 384-d encoder used for memory |

The OpenRouter key is read from `data/openrouter.key` (a single line holding
the key) instead of being written into `config.ts`, because this repository is
public: a literal key in a tracked file would be a published credential, and
git history keeps it even after a later removal. `data/` is git-ignored, so on
a deployment the key sits on the same volume as the database. It is read once
at startup, so rotating it means restarting the service.

The only environment read left in the project is `package.json`'s start script
(`next start -p ${PORT:-3000}`), which Railway requires at the shell level to
route traffic to the service.

## Attaching documents to a task

A task can carry reference text that the agent reads before doing anything
else - paste `.txt`/`.md`/`.csv`/`.json`/`.log` files in on the **New task**
page, or pass `documents: [{name, content}]` to `POST /api/tasks`. Content
is injected into the agent's first message, capped (20k chars/doc, 40k
total) so one task can't blow the whole token budget. Binary files and
file parsing (PDF, DOCX, etc.) aren't supported - plain text only, by
design, to stay inside the resource budget this app runs in.

## Surviving a restart

A task stuck in `running` when the server starts didn't fail - it was cut
off mid-task by a redeploy, crash, or OOM. The old behavior just marked it
`failed` and threw the work away. Now:

- Every step persists the full message history to the task's
  `conversation_json` column, not just the human-readable log.
- On boot, `instrumentation.ts` → `initTaskRunner()` finds any `running`
  task and marks it **`interrupted`** - and stops there. Nothing resumes
  automatically. Silently continuing a task after a restart, with no one
  having asked for that, isn't something this app does without consent.
- An interrupted task shows up on the **tasks list** with its own banner
  ("N tasks were interrupted... waiting on you") and inline **resume** /
  **cancel** buttons right on the row - no need to click into it. The same
  two actions are on the task detail page too.
- **Resume** (`POST /api/tasks/[id]/resume`) continues from the exact
  saved conversation and step count - picks up with the next model call,
  doesn't restart from scratch. **Cancel** stops it for good.
- `resume_count` is purely informational (shown as "interrupted 2x"); it
  doesn't trigger or limit anything automatically.

Verified by seeding a task mid-run with a fake saved conversation: after a
simulated restart it sat as `interrupted` with zero activity for 5+
seconds (confirmed nothing auto-fires), then both manual resume (continues
from the saved step/conversation) and manual cancel were exercised
successfully against it.

## How a task runs

1. You submit a goal (and optionally a step cap / JSON answer schema).
2. It's written to SQLite as `queued` and handed to an in-process queue
   (`lib/server/taskRunner.ts`) — this is what makes it keep running with
   the UI closed. The queue lives on `globalThis` so it survives Next.js's
   dev-mode module reloads and is a singleton across the one server process.
3. The worker loops: ask the model what to do → it calls a tool
   (`web_search`, `fetch_page`, `run_python`, `run_node`) or `finish` →
   result is logged and fed back → repeat, up to the step cap.
4. Every step is written to SQLite as it happens. The UI either streams it
   live (`/api/tasks/[id]/stream`, Server-Sent Events) or just reads the log
   back later — same data either way.
5. The task ends in `completed`, `failed` (error, step cap, or exhausted
   quota), or `cancelled`.
6. On server restart, `instrumentation.ts` marks any task stuck in `running`
   as `failed` (it was interrupted) and re-enqueues anything left `queued`.

## The OpenRouter key pool

Unchanged from the original design. Free OpenRouter keys are capped around
50 requests/day and 20/minute each. Add as many as you want from **Keys &
limits** — no redeploy needed. Before every model call, the scheduler:

- skips keys that are disabled, over their daily count, or inside a
  throttled 60-second window,
- picks whichever remaining key has been used the *least* today,
- raises a clear "all keys exhausted" error (visible in the task log)
  instead of retrying forever, if nothing has headroom.

A combined **daily token budget** (Settings page) stops new work across the
whole pool once hit, independent of any single key's limit.

## Running locally

```bash
npm install
npm run dev
```

Open http://localhost:3000, go to **Keys & limits**, paste in an OpenRouter
free-tier key, then **New task**. `npm run build && npm run start` for a
production-mode run (what Railway actually runs).

## Deploying to Railway

One service this time:

1. New service → deploy from this repo.
2. Railway reads two config files at the repo root:
   - `mise.toml` pins Node 22 and adds Python 3.12 as a second runtime
     (Railpack is built on [Mise](https://mise.jdx.dev/); this is Railpack's
     own documented way to add a language alongside the auto-detected one -
     see [railpack.com/config/recommendations](https://railpack.com/config/recommendations)).
     Python is only needed as the sandboxed execution target for the
     `run_python` tool, not for anything in the app's own runtime.
   - `railpack.json` adds `build-essential` (so `better-sqlite3`'s native
     module compiles during the build) and sets the start command.
3. No environment variables are required to boot. Railway sets `PORT`
   automatically; the start script reads it directly (see "Configuration").
4. Write the OpenRouter key into `data/openrouter.key` on the service volume
   (one line: the key) and restart. It is read once at startup.

### Fitting the free trial

Same reasoning as before: the trial gives ~1GB RAM / 2 shared vCPU for 30
days, which is why there's still no headless browser — `web_search` and
`fetch_page` use plain HTTP + `cheerio` instead. Collapsing to one service
(vs. the original two) buys back a meaningful chunk of that budget.

## What changed vs. the Python version

| | Before | Now |
|---|---|---|
| Services on Railway | 2 (FastAPI + Next.js) | 1 (Next.js only) |
| Backend language | Python (FastAPI) | TypeScript (Route Handlers) |
| DB driver | `aiosqlite` | `better-sqlite3` (sync, no event-loop juggling) |
| HTML parsing | BeautifulSoup | `cheerio` |
| Subprocess resource caps | Python's `resource.setrlimit` | `ulimit` inside a `bash -c` wrapper, process-group kill on timeout |
| Build config | `Dockerfile` (×2) | `railpack.json` (×1) |

Tool behavior, the key-pool logic, the step/token caps, and the UI are
functionally the same — this was a language/infrastructure refactor, not a
feature change.

## Known limitations (unchanged — read before pointing it at anything sensitive)

- **`run_python` / `run_node` are not network-isolated.** They run as a
  subprocess with a CPU/memory cap and a timeout, but nothing stops the
  code from making outbound HTTP requests. Treat the sandbox as
  "crash-proof and resource-capped," not "secure against malicious code."
  Don't run it on untrusted goals/input.
- **No JS-rendered browsing.** Sites that require executing JavaScript to
  show content won't work with `fetchPage`.
- **One task at a time** (`taskRunner`'s queue processes serially), to stay
  well under the free-tier per-minute request limit.
- **SQLite, single instance.** Fine for one Railway service; scaling to
  multiple instances would need shared state (e.g. Postgres) instead.
- **Free-tier model quality varies.** `qwen/qwen3-coder:free` and
  `openai/gpt-oss-20b:free` are solid starting points; adjust the
  default/fallback list in Settings.

## Where the caps live (all adjustable from Settings, no redeploy)

| Setting | What it does |
|---|---|
| `default_model` / `fallback_models` | Which OpenRouter model(s) to try, in order |
| `max_steps_default` / `max_steps_hard_cap` | Per-task step ceiling |
| `daily_token_budget` | Combined prompt+completion tokens/day across the whole key pool |
| `tool_timeout_seconds` | Timeout for each `run_python`/`run_node` call |
| per-key `daily_limit` / `minute_limit` | Set per key when you add it, editable via the API |
