/**
 * SQLite persistence (better-sqlite3: synchronous, no native-flag gymnastics
 * across Node versions). Everything the agent does is written here so tasks
 * survive restarts and keep running whether or not a UI is attached.
 *
 * A single shared connection lives on globalThis so Next.js's dev-mode
 * module reloading doesn't open a new handle on every edit.
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { config } from "@/lib/config";

const DATA_DIR = path.join(process.cwd(), config.dataDir);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "sandbox.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',   -- queued|running|completed|failed|cancelled|interrupted
    result TEXT,
    schema_json TEXT,
    max_steps INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    step_count INTEGER NOT NULL DEFAULT 0,
    conversation_json TEXT,                   -- full message history, for resuming after a restart
    resume_count INTEGER NOT NULL DEFAULT 0,
    memory_refs_json TEXT,                    -- what workspace memory was injected into this task
    has_pending_input INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,     -- 0 = the agent hasn't seen this message yet
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_messages ON task_messages(task_id, id);

CREATE TABLE IF NOT EXISTS task_documents (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at REAL NOT NULL
);

-- Episodic memory: one row per finished task, so later tasks can find and
-- reuse earlier work instead of repeating it.
CREATE TABLE IF NOT EXISTS episodes (
    task_id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    outcome TEXT NOT NULL,                    -- completed | failed
    summary TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '',
    step_count INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

-- Hierarchical memory: topics form a tree, facts hang off the leaves.
CREATE TABLE IF NOT EXISTS memory_topics (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,                -- "crypto/prices"
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    topic_id TEXT,
    kind TEXT NOT NULL DEFAULT 'fact',        -- fact | note | entity | preference
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_task_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    use_count INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    last_used_at REAL
);
CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic_id);

-- Relation graph over facts: topic / shared-vocabulary / same-task edges.
-- Used for spreading-activation retrieval and centrality in the retention
-- score, and kept in SQLite so the graph is inspectable and survives restarts.
CREATE TABLE IF NOT EXISTS memory_links (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    kind TEXT NOT NULL,                       -- topic | term | task
    weight REAL NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_id);

-- Local sentence embeddings for semantic retrieval (384-d, MiniLM).
CREATE TABLE IF NOT EXISTS memory_vectors (
    memory_id TEXT PRIMARY KEY,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL,
    updated_at REAL NOT NULL
);

-- Learned associations: facts retrieved together for a task that succeeded get
-- a Hebbian edge, so co-use strengthens connections the way experience does.
CREATE TABLE IF NOT EXISTS memory_co_use (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    weight REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (from_id, to_id)
);

-- Token spend per UTC day. Budgeting from the task's created_at was wrong for
-- conversations that continue on a later day; this counts when tokens were
-- actually spent.
CREATE TABLE IF NOT EXISTS token_usage (
    day TEXT PRIMARY KEY,                     -- YYYY-MM-DD
    tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_steps_task ON steps(task_id, id);

CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS: Record<string, string> = {
  max_steps_default: "12",
  max_steps_hard_cap: "25",
  daily_token_budget: "200000",
  tool_timeout_seconds: "20",
  // Memory capacity. Which memories survive is decided by retrieval score, not
  // by these numbers; they only say how much the store may hold.
  memory_budget_chars: "120000",
  episode_budget_chars: "400000",
};

declare global {
  // eslint-disable-next-line no-var
  var __agentSandboxDb: Database.Database | undefined;
}

/** Adds a column to an existing table if it isn't there yet. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so this checks PRAGMA table_info first - lets
 * a DB created before this column existed pick it up on next boot instead
 * of needing a fresh database. */
function ensureColumn(db: Database.Database, table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function createConnection(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  ensureColumn(db, "tasks", "conversation_json", "TEXT");
  ensureColumn(db, "tasks", "resume_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "memory_refs_json", "TEXT");
  ensureColumn(db, "tasks", "has_pending_input", "INTEGER NOT NULL DEFAULT 0");

  // Settings the app no longer reads (the model and key moved to `config`).
  // Drop them so an upgraded database doesn't advertise dead config.
  db.prepare(
    "DELETE FROM settings WHERE k IN ('default_model', 'fallback_models', 'require_json_schema_default')"
  ).run();

  const insertDefault = db.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES (?, ?)");
  const tx = db.transaction((entries: [string, string][]) => {
    for (const [k, v] of entries) insertDefault.run(k, v);
  });
  tx(Object.entries(DEFAULT_SETTINGS));

  // One-off backfill so a database from before per-day accounting still knows
  // what was already spent today. Idempotent: existing days are left alone.
  db.exec(`INSERT OR IGNORE INTO token_usage (day, tokens)
           SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS day,
                  SUM(prompt_tokens + completion_tokens)
           FROM tasks
           WHERE prompt_tokens + completion_tokens > 0
           GROUP BY day`);

  return db;
}

export function getDb(): Database.Database {
  if (!globalThis.__agentSandboxDb) {
    globalThis.__agentSandboxDb = createConnection();
  }
  return globalThis.__agentSandboxDb;
}

export function now(): number {
  return Date.now() / 1000;
}

/** Today's UTC day key, e.g. "2026-11-13". */
export function dayKey(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Tokens spent today, counted at the moment they were spent. Deriving this
 * from tasks.created_at under-counted a conversation resumed on a later day and
 * over-counted one that had run the day before. */
export function tokensUsedToday(): number {
  const row = getDb().prepare("SELECT COALESCE(tokens, 0) AS used FROM token_usage WHERE day = ?").get(dayKey()) as
    | { used: number }
    | undefined;
  return row?.used ?? 0;
}
