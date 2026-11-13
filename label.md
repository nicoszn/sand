# Labels

What each part does, in one sentence.

## Agent runtime

- `lib/server/agent.ts` — the step loop that calls the model, runs tools, injects workspace memory and handles follow-up turns.
- `lib/server/taskRunner.ts` — in-process queue that runs one task at a time, re-queues follow-ups and records finished work as memory.
- `lib/server/tools.ts` — the eight agent tools (search, fetch, code, recall, remember, read_task, finish) with resource caps.
- `lib/server/openrouterClient.ts` — single thin client for OpenRouter chat completions.
- `lib/server/documents.ts` — renders attached reference documents for the prompt.
- `lib/server/settingsStore.ts` — runtime settings read from and written to SQLite.
- `instrumentation.ts` — boots the worker, embeddings and memory backfill once per server process.

## Memory

- `lib/server/memory.ts` — the memory facade: hybrid retrieval, retention-aware pruning, context building and the public memory API.
- `lib/server/memoryIndex.ts` — MiniSearch BM25 index with fuzzy and prefix matching over facts and episodes.
- `lib/server/embeddings.ts` — local MiniLM sentence embeddings via Transformers.js, with graceful lexical fallback.
- `lib/server/vectors.ts` — stores fact embeddings as SQLite BLOBs and ranks them by cosine similarity.
- `lib/server/memoryGraph.ts` — the relation graph: derived and co-use edges, PageRank centrality and spreading activation.
- `lib/server/memoryModel.ts` — fits the ACT-R decay exponent and retention weights from observed usage.
- `lib/server/text.ts` — shared tokenisation, stopwords and Jaccard similarity.
- `lib/server/messages.ts` — the conversation around a task, with exactly-once consumption of unseen messages.
- `lib/server/events.ts` — shared helpers for writing steps, task fields and token spend.

## Persistence

- `lib/server/db.ts` — SQLite schema, migrations and the shared connection.
- `lib/server/types.ts` — shared row and step types.

## API

- `app/api/tasks/route.ts` — list tasks and create one with an initial message.
- `app/api/tasks/[id]/route.ts` — fetch a task with its steps, documents and memory provenance.
- `app/api/tasks/[id]/messages/route.ts` — post a follow-up or steering message and read the thread.
- `app/api/tasks/[id]/stream/route.ts` — Server-Sent Events for live step updates.
- `app/api/tasks/[id]/resume/route.ts` — resume an interrupted task from its saved conversation.
- `app/api/tasks/[id]/cancel/route.ts` — cancel a queued, running or interrupted task.
- `app/api/memory/route.ts` — search, pin and delete memory facts and episodes.
- `app/api/settings/route.ts` — read and update the limits and budgets.
- `app/api/health/route.ts` — liveness probe.

## UI

- `app/page.tsx` — task list with status, token use and follow-up counts.
- `app/new/page.tsx` — compose a task, step cap, JSON schema and documents.
- `app/tasks/[id]/page.tsx` — result, collapsible activity, memory provenance and the reply composer.
- `app/memory/page.tsx` — inspect, search, pin and prune the workspace memory.
- `app/settings/page.tsx` — edit step, token and memory budgets.
- `app/keys/page.tsx` — manage OpenRouter keys.
- `app/layout.tsx` — shell, navigation and page frame.
- `app/globals.css` — the whole theme and component styling.

## Components

- `components/ActivityItem.tsx` — one compact, expandable activity row and the step grouping behind it.
- `components/MarkdownText.tsx` — compact Markdown rendering for summaries inside cards.
- `components/NavLink.tsx` — active-aware navigation link.
- `components/StatusDot.tsx` — task status pill.
- `components/CopyButton.tsx` — clipboard copy with confirmation.

## Client and config

- `lib/api.ts` — typed fetch helpers every page uses.
- `lib/config.ts` — app-wide constants, model choice and the API key read from the environment.
- `next.config.ts` — keeps native packages out of the server bundle.
- `railpack.json` — Railway build config and start command.
- `mise.toml` — pins Node 22 and provides Python for the sandbox tool.
