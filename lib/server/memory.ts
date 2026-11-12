/**
 * Workspace memory: what this app has learned, available to every task.
 *
 * Two layers that work together:
 *
 *  - Episodic (relational): one `episodes` row per finished task - goal,
 *    outcome, a summary of the answer, which tools ran, cost. Later tasks can
 *    find relevant episodes and build on that work instead of redoing it.
 *  - Semantic (hierarchical): `memory_topics` form a tree ("crypto/prices"),
 *    and `memories` hang off them as durable facts the agent saved with the
 *    `remember` tool. Facts are deduplicated, pinned, and usage-tracked.
 *
 * Retrieval is lexical (there is no embedding endpoint here, and adding one
 * would mean a second provider): query terms are matched against each record
 * with a Dice-style overlap, then ranked with small bonuses for recency,
 * completion, pinning and past usefulness. That is deterministic, instant and
 * works offline, which suits a single-service app on a small budget.
 */
import { randomBytes } from "node:crypto";
import { getDb, now } from "./db";
import { TaskRow } from "./types";

const MAX_EPISODES = 500;
const MAX_SUMMARY_CHARS = 1600;
const CONTEXT_BUDGET_CHARS = 3500;
const EPISODE_SUMMARY_IN_CONTEXT = 420;
const FACT_CHARS_IN_CONTEXT = 320;
const MIN_SCORE = 0.12;

export interface MemoryRef {
  type: "task" | "memory";
  id: string;
  title: string;
  score: number;
}

export interface MemoryContext {
  block: string;
  refs: MemoryRef[];
}

interface EpisodeRow {
  task_id: string;
  goal: string;
  outcome: "completed" | "failed";
  summary: string;
  tags: string;
  tools: string;
  step_count: number;
  tokens: number;
  created_at: number;
  updated_at: number;
}

export interface MemoryRow {
  id: string;
  topic_id: string | null;
  kind: string;
  title: string;
  content: string;
  source_task_id: string | null;
  pinned: number;
  use_count: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

const STOPWORDS = new Set(
  "a an the and or but if then than that this these those for from with without into onto over under about after before between of to in on at by is are was were be been being do does did done have has had it its as not no you your we our they their them he she his her i me my what which who whom how why when where all any each more most some such only own same so too very can will just should now also".split(
    " "
  )
);

/** Lower-cased content terms, deduplicated, stopwords and bare numbers dropped
 * so "2025" or "the" don't create false matches. */
export function terms(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(raw);
  }
  return [...out];
}

function overlap(query: string[], doc: string[]): number {
  if (query.length === 0 || doc.length === 0) return 0;
  const docSet = new Set(doc);
  let hits = 0;
  for (const term of query) if (docSet.has(term)) hits++;
  const coverage = hits / query.length;
  const dice = (2 * hits) / (query.length + doc.length);
  return coverage * 0.7 + dice * 0.3;
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const term of A) if (B.has(term)) shared++;
  return shared / (A.size + B.size - shared);
}

function recencyBonus(timestamp: number): number {
  const ageDays = Math.max(0, (now() - timestamp) / 86400);
  return Math.max(0, 1 - ageDays / 60) * 0.12;
}

function topTerms(text: string, count: number): string[] {
  const counts = new Map<string, number>();
  for (const term of terms(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([term]) => term);
}

/* ------------------------------------------------------------- episodes */

/** === Epsiode index ===
 * Writes (or refreshes) the episode for a finished task and prunes old ones. */
export function recordEpisode(taskId: string) {
  const db = getDb();
  const task = db
    .prepare(
      "SELECT id, goal, status, result, step_count, prompt_tokens, completion_tokens, created_at FROM tasks WHERE id = ?"
    )
    .get(taskId) as
    | Pick<TaskRow, "id" | "goal" | "status" | "result" | "step_count" | "created_at"> & {
        prompt_tokens: number;
        completion_tokens: number;
      }
    | undefined;

  if (!task || !task.result) return;
  if (task.status !== "completed" && task.status !== "failed") return;

  const calls = db.prepare("SELECT content FROM steps WHERE task_id = ? AND kind = 'tool_call'").all(taskId) as {
    content: string;
  }[];
  const tools = [
    ...new Set(
      calls.map((c) => {
        try {
          return String(JSON.parse(c.content).tool ?? "tool");
        } catch {
          return "tool";
        }
      })
    ),
  ];

  const summary = task.result.slice(0, MAX_SUMMARY_CHARS);
  const tags = topTerms(`${task.goal} ${task.result}`, 8).join(" ");
  const tokens = task.prompt_tokens + task.completion_tokens;
  const t = now();

  db.prepare(
    `INSERT INTO episodes (task_id, goal, outcome, summary, tags, tools, step_count, tokens, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       goal = excluded.goal,
       outcome = excluded.outcome,
       summary = excluded.summary,
       tags = excluded.tags,
       tools = excluded.tools,
       step_count = excluded.step_count,
       tokens = excluded.tokens,
       updated_at = excluded.updated_at`
  ).run(task.id, task.goal, task.status, summary, tags, tools.join(","), task.step_count, tokens, task.created_at, t);

  db.prepare(
    `DELETE FROM episodes WHERE task_id NOT IN (
       SELECT task_id FROM episodes ORDER BY updated_at DESC LIMIT ?
     )`
  ).run(MAX_EPISODES);
}

/** Existing databases predate memory: seed episodes from finished tasks once. */
export function backfillEpisodes() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.id FROM tasks t
       LEFT JOIN episodes e ON e.task_id = t.id
       WHERE e.task_id IS NULL AND t.result IS NOT NULL AND t.status IN ('completed', 'failed')`
    )
    .all() as { id: string }[];
  for (const row of rows) recordEpisode(row.id);
}

export function searchEpisodes(query: string, limit = 4): EpisodeRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM episodes ORDER BY updated_at DESC LIMIT 300")
    .all() as EpisodeRow[];
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return [];

  return rows
    .map((row) => {
      const base = overlap(queryTerms, terms(`${row.goal} ${row.tags} ${row.summary}`));
      const bonus = recencyBonus(row.updated_at) + (row.outcome === "completed" ? 0.08 : 0);
      return { row, score: base + bonus };
    })
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.row);
}

export function listEpisodes(limit = 40): EpisodeRow[] {
  return getDb()
    .prepare("SELECT * FROM episodes ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as EpisodeRow[];
}

/* -------------------------------------------------------------- memories */

interface TopicRow {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  created_at: number;
}

/** Resolves "crypto/prices" into the topic tree, creating nodes as needed. */
function resolveTopic(topicPath: string | null | undefined): string | null {
  if (!topicPath) return null;
  const segments = topicPath
    .split(/[\/>]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (segments.length === 0) return null;

  const db = getDb();
  let parentId: string | null = null;
  let full = "";

  for (const name of segments) {
    full = full ? `${full}/${name}` : name;
    const existing = db.prepare("SELECT id FROM memory_topics WHERE path = ?").get(full) as
      | { id: string }
      | undefined;
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const id = randomBytes(5).toString("hex");
    db.prepare("INSERT INTO memory_topics (id, parent_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      parentId,
      name,
      full,
      now()
    );
    parentId = id;
  }
  return parentId;
}

export function rememberFact(input: {
  taskId: string;
  title: string;
  content: string;
  topic?: string | null;
  kind?: string | null;
}): { id: string; updated: boolean; topicPath: string | null } {
  const db = getDb();
  const title = input.title.trim().slice(0, 200);
  const content = input.content.trim().slice(0, 4000);
  if (!title || !content) throw new Error("remember needs both a title and content");

  const topicId = resolveTopic(input.topic);
  const topicPath = topicId
    ? (db.prepare("SELECT path FROM memory_topics WHERE id = ?").get(topicId) as { path: string }).path
    : null;

  // Same topic + near-identical wording means this is an update, not a new fact.
  const candidates = db
    .prepare("SELECT * FROM memories WHERE topic_id IS ? OR topic_id = ?")
    .all(topicId, topicId) as MemoryRow[];
  const incoming = terms(`${title} ${content}`);
  const duplicate = candidates.find((row) => jaccard(incoming, terms(`${row.title} ${row.content}`)) >= 0.7);

  if (duplicate) {
    db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?").run(content, now(), duplicate.id);
    return { id: duplicate.id, updated: true, topicPath };
  }

  const id = randomBytes(6).toString("hex");
  const t = now();
  db.prepare(
    `INSERT INTO memories (id, topic_id, kind, title, content, source_task_id, pinned, use_count, created_at, updated_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL)`
  ).run(id, topicId, input.kind?.trim() || "fact", title, content, input.taskId, t, t);
  return { id, updated: false, topicPath };
}

export function searchMemory(query: string, limit = 5): MemoryRow[] {
  const rows = getDb().prepare("SELECT * FROM memories").all() as MemoryRow[];
  const queryTerms = terms(query);
  const t = now();

  if (queryTerms.length === 0) {
    // No usable query: fall back to the most recently useful, pinned-first facts.
    return rows
      .sort((a, b) => b.pinned - a.pinned || (b.last_used_at ?? b.updated_at) - (a.last_used_at ?? a.updated_at))
      .slice(0, limit);
  }

  const topics = new Map(
    (getDb().prepare("SELECT id, path FROM memory_topics").all() as { id: string; path: string }[]).map((row) => [
      row.id,
      row.path,
    ])
  );

  return rows
    .map((row) => {
      const path = row.topic_id ? topics.get(row.topic_id) ?? "" : "";
      const base = overlap(queryTerms, terms(`${row.title} ${row.content} ${path}`));
      const bonus =
        (row.pinned ? 0.15 : 0) +
        Math.min(0.08, Math.log1p(row.use_count) * 0.03) +
        Math.max(0, 1 - Math.max(0, t - (row.last_used_at ?? row.updated_at)) / 86400 / 60) * 0.05;
      return { row, score: base + bonus };
    })
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.row);
}

export function listMemories(query?: string): (MemoryRow & { topic_path: string | null })[] {
  const db = getDb();
  const rows = (
    query && query.trim()
      ? searchMemory(query, 100)
      : (db
          .prepare(
            "SELECT * FROM memories ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC LIMIT 200"
          )
          .all() as MemoryRow[])
  ) as MemoryRow[];

  const topics = new Map(
    (db.prepare("SELECT id, path FROM memory_topics").all() as { id: string; path: string }[]).map((row) => [
      row.id,
      row.path,
    ])
  );
  return rows.map((row) => ({
    ...row,
    topic_path: row.topic_id ? topics.get(row.topic_id) ?? null : null,
  }));
}

export function setMemoryPinned(id: string, pinned: boolean) {
  getDb().prepare("UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, now(), id);
}

export function deleteMemory(id: string) {
  getDb().prepare("DELETE FROM memories WHERE id = ?").run(id);
}

export function deleteEpisode(taskId: string) {
  getDb().prepare("DELETE FROM episodes WHERE task_id = ?").run(taskId);
}

export function memoryStats() {
  const db = getDb();
  const facts = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  const topics = (db.prepare("SELECT COUNT(*) AS n FROM memory_topics").get() as { n: number }).n;
  const episodes = (db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n;
  return { facts, topics, episodes };
}

/** Usage is tracked because frequently reused memories should rank higher. */
export function markMemoriesUsed(ids: string[]) {
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare("UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?");
  const tx = db.transaction((list: string[]) => {
    for (const id of list) stmt.run(now(), id);
  });
  tx(ids);
}

/* ---------------------------------------------------------------- context */

/** Builds the "what we already know" block injected into a new task's system
 * prompt, plus the refs the UI shows as provenance. Returns null when nothing
 * relevant is remembered, so unrelated tasks stay clean. */
export function buildMemoryContext(taskId: string, query: string): MemoryContext | null {
  const episodes = searchEpisodes(query, 4);
  const memories = searchMemory(query, 5);
  if (episodes.length === 0 && memories.length === 0) return null;

  const refs: MemoryRef[] = [];
  const parts: string[] = [];

  if (episodes.length > 0) {
    const lines = episodes.map((episode) => {
      refs.push({ type: "task", id: episode.task_id, title: episode.goal, score: 1 });
      const summary =
        episode.summary.length > EPISODE_SUMMARY_IN_CONTEXT
          ? `${episode.summary.slice(0, EPISODE_SUMMARY_IN_CONTEXT)}…`
          : episode.summary;
      return `- [task ${episode.task_id} · ${episode.outcome} · ${relativeAge(episode.updated_at)}] ${episode.goal}\n  → ${summary.replace(/\n+/g, " ")}`;
    });
    parts.push(`Earlier tasks in this workspace:\n${lines.join("\n")}`);
  }

  if (memories.length > 0) {
    const topics = new Map(
      (getDb().prepare("SELECT id, path FROM memory_topics").all() as { id: string; path: string }[]).map((row) => [
        row.id,
        row.path,
      ])
    );
    const lines = memories.map((memory) => {
      refs.push({ type: "memory", id: memory.id, title: memory.title, score: 1 });
      const path = memory.topic_id ? `[${topics.get(memory.topic_id) ?? "general"}] ` : "";
      const body =
        memory.content.length > FACT_CHARS_IN_CONTEXT
          ? `${memory.content.slice(0, FACT_CHARS_IN_CONTEXT)}…`
          : memory.content;
      return `- ${path}${memory.title}: ${body.replace(/\n+/g, " ")}`;
    });
    parts.push(`Facts saved from earlier work:\n${lines.join("\n")}`);
  }

  const header = [
    "## Workspace memory",
    "",
    "You share this workspace with earlier tasks. Use the notes below as prior knowledge:",
    "- Do not redo work that is already done and verified - build on it instead.",
    "- Anything that can change (prices, versions, dates, availability) may be stale: re-verify when it matters, and say so.",
    "- You may call `recall` for more context, `read_task` to read an earlier task in full, and `remember` to save a durable fact for later tasks.",
    "- When a result leans on earlier work, cite the task id it came from.",
    "",
  ].join("\n");

  let block = `\n\n${header}${parts.join("\n\n")}`;
  if (block.length > CONTEXT_BUDGET_CHARS) {
    block = `${block.slice(0, CONTEXT_BUDGET_CHARS)}\n… (workspace memory truncated)`;
  }

  markMemoriesUsed(memories.map((memory) => memory.id));
  return { block, refs };
}

/** Full read of a prior task, for the `read_task` tool. */
export function readTaskDigest(taskId: string): string | null {
  const db = getDb();
  const task = db
    .prepare("SELECT id, goal, status, result, created_at, step_count, prompt_tokens, completion_tokens FROM tasks WHERE id = ?")
    .get(taskId) as
    | (Pick<TaskRow, "id" | "goal" | "status" | "result" | "created_at" | "step_count"> & {
        prompt_tokens: number;
        completion_tokens: number;
      })
    | undefined;
  if (!task) return null;

  const toolCalls = db
    .prepare("SELECT step_index, content FROM steps WHERE task_id = ? AND kind = 'tool_call' ORDER BY id ASC LIMIT 40")
    .all(taskId) as { step_index: number; content: string }[];

  const tools = toolCalls
    .map((row) => {
      try {
        const parsed = JSON.parse(row.content);
        return `  step ${row.step_index}: ${parsed.tool}`;
      } catch {
        return `  step ${row.step_index}: tool`;
      }
    })
    .join("\n");

  const result = (task.result ?? "(no result)").slice(0, 5000);
  const digest = [
    `Task ${task.id} - ${task.status} - ${relativeAge(task.created_at)}`,
    `Goal: ${task.goal}`,
    `Steps: ${task.step_count}, tokens: ${task.prompt_tokens + task.completion_tokens}`,
    tools ? `Tools used:\n${tools}` : "Tools used: none",
    `Result:\n${result}`,
  ].join("\n");

  return digest.length > 6000 ? `${digest.slice(0, 6000)}\n… (truncated)` : digest;
}

export function relativeAge(timestamp: number): string {
  const seconds = Math.max(0, now() - timestamp);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
