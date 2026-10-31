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

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "sandbox.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    result TEXT,
    schema_json TEXT,
    max_steps INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    step_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    key_value TEXT NOT NULL,
    daily_limit INTEGER NOT NULL DEFAULT 50,
    minute_limit INTEGER NOT NULL DEFAULT 20,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS key_usage (
    key_id TEXT NOT NULL,
    day TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_id, day)
);

CREATE TABLE IF NOT EXISTS key_minute_window (
    key_id TEXT PRIMARY KEY,
    window_start REAL NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS: Record<string, string> = {
  default_model: "qwen/qwen3-coder:free",
  fallback_models: JSON.stringify(["openai/gpt-oss-20b:free", "meta-llama/llama-3.3-70b-instruct:free"]),
  max_steps_default: "12",
  max_steps_hard_cap: "25",
  daily_token_budget: "200000",
  require_json_schema_default: "false",
  tool_timeout_seconds: "20",
};

declare global {
  // eslint-disable-next-line no-var
  var __agentSandboxDb: Database.Database | undefined;
}

function createConnection(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  const insertDefault = db.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES (?, ?)");
  const tx = db.transaction((entries: [string, string][]) => {
    for (const [k, v] of entries) insertDefault.run(k, v);
  });
  tx(Object.entries(DEFAULT_SETTINGS));
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
