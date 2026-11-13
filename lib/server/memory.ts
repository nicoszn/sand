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
 * Retrieval is three-stage. MiniSearch (BM25 + prefix + fuzzy, see
 * `memoryIndex.ts`) produces lexical seeds; spreading activation over the
 * relation graph (`memoryGraph.ts`) adds facts that are linked to the seeds but
 * worded differently; then Maximal Marginal Relevance picks a result set that
 * covers different facts instead of four paraphrases of one. Small bonuses for
 * recency, completion, pinning and past usefulness break ties.
 *
 * Retention is a model, not a hardcoded cap. Every fact gets a retention score
 * from ACT-R base-level activation (uses decay as a power of time), PageRank
 * centrality in the relation graph, and observed utility (how often it was
 * actually used). The store is bounded by a character budget, and the lowest
 * scoring memories are evicted as it fills up; near-duplicates are merged.
 * Nothing expires purely because it is a certain number of days old, and
 * pinned facts are never evicted.
 */
import { randomBytes } from "node:crypto";
import { getDb, now } from "./db";
import { getSettingInt } from "./settingsStore";
import { TaskRow } from "./types";
import { jaccard, terms } from "./text";
import {
  activation,
  fitModel,
  loadParams,
  normalizedActivation,
  retentionScoreFrom,
  saveParams,
} from "./memoryModel";
import { embeddingStatus } from "./embeddings";
import { markVectorsDirty, queueEmbedding, rankByVector, vectorStats } from "./vectors";
import { markMemoryIndexDirty, searchEpisodeIndex, searchFactIndex } from "./memoryIndex";
import {
  centralityOf,
  decayCoUse,
  graphStats,
  markGraphDirty,
  neighboursOf,
  spreadActivation,
} from "./memoryGraph";

/** Episodes have no use events of their own, so their decay uses the prior. */
const EPISODE_DECAY = 0.5;

const MAX_SUMMARY_CHARS = 1600;
const CONTEXT_BUDGET_CHARS = 2000;
const EPISODE_SUMMARY_IN_CONTEXT = 320;
const FACT_CHARS_IN_CONTEXT = 240;
const MIN_SCORE = 0.12;

/** Capacity, not policy: the score decides *which* memories survive, these
 * budgets decide how much the store can hold. Overridable in Settings. */
const FACT_BUDGET_DEFAULT = 120_000; // characters of fact text (~30k tokens)
const EPISODE_BUDGET_DEFAULT = 400_000;

export function factBudgetChars() {
  return Math.max(2_000, getSettingInt("memory_budget_chars", FACT_BUDGET_DEFAULT));
}

export function episodeBudgetChars() {
  return Math.max(5_000, getSettingInt("episode_budget_chars", EPISODE_BUDGET_DEFAULT));
}

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

export interface EpisodeRow {
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

  pruneEpisodes();
  markMemoryIndexDirty();
}

/** Episodes are kept while their summaries fit the episode budget, weakest
 * activation first out - so a burst of tasks pushes out the least relevant
 * older ones, not simply the oldest. */
function pruneEpisodes() {
  const budget = episodeBudgetChars();
  const rows = getDb()
    .prepare("SELECT task_id, summary, created_at, updated_at, outcome FROM episodes")
    .all() as { task_id: string; summary: string; created_at: number; updated_at: number; outcome: string }[];

  let used = rows.reduce((sum, row) => sum + row.summary.length, 0);
  if (used <= budget) return 0;

  const ranked = rows
    .map((row) => ({
      row,
      score:
        normalizedActivation(
          activation(
            {
              id: row.task_id,
              created_at: row.created_at,
              updated_at: row.updated_at,
              last_used_at: null,
              use_count: 0,
            },
            EPISODE_DECAY,
            now()
          )
        ) + (row.outcome === "completed" ? 0.05 : 0),
    }))
    .sort((a, b) => a.score - b.score);

  const remove = getDb().prepare("DELETE FROM episodes WHERE task_id = ?");
  const tx = getDb().transaction(() => {
    for (const entry of ranked) {
      if (used <= budget) break;
      remove.run(entry.row.task_id);
      used -= entry.row.summary.length;
    }
  });
  const before = rows.length;
  tx();
  const after = (getDb().prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n;
  return before - after;
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

export function searchEpisodes(query: string, limit = 3): EpisodeRow[] {
  if (terms(query).length === 0) return [];

  return searchEpisodeIndex(query, 30)
    .map(({ row, score }) => ({
      row,
      score: score + recencyBonus(row.updated_at) + (row.outcome === "completed" ? 0.06 : 0),
    }))
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
    markMemoryIndexDirty();
    markGraphDirty();
    queueEmbedding(duplicate.id, title, content);
    return { id: duplicate.id, updated: true, topicPath };
  }

  const id = randomBytes(6).toString("hex");
  const t = now();
  db.prepare(
    `INSERT INTO memories (id, topic_id, kind, title, content, source_task_id, pinned, use_count, created_at, updated_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL)`
  ).run(id, topicId, input.kind?.trim() || "fact", title, content, input.taskId, t, t);
  markMemoryIndexDirty();
  markGraphDirty();
  // Embedding happens off the write path so `remember` never waits on the model.
  queueEmbedding(id, title, content);
  return { id, updated: false, topicPath };
}

/** Reciprocal Rank Fusion constant. RRF (Cormack et al.) combines rankings
 * without needing the three scorers to share a scale - BM25 scores, cosine
 * similarities and activation values are not comparable, ranks are. */
const RRF_K = 60;

/**
 * Hybrid retrieval:
 *   lexical (BM25 + fuzzy + prefix)  →  rank list 1
 *   semantic (MiniLM cosine)         →  rank list 2
 *   spreading activation over edges  →  rank list 3
 * fused with RRF, then small tie-breaking bonuses, then diversified by MMR.
 * Each signal covers what the others miss: exact wording, paraphrase, and
 * association. If embeddings are unavailable the remaining two still work.
 */
async function rankedFacts(query: string): Promise<{ row: MemoryRow; score: number }[]> {
  const lexical = searchFactIndex(query, 40);
  const semantic = await rankByVector(query, 40);
  if (lexical.length === 0 && semantic.length === 0) return [];

  const seedsById = [
    ...lexical.map((seed) => ({ id: seed.row.id, score: seed.score })),
    ...semantic.slice(0, 10),
  ];
  const graph = [...spreadActivation(seedsById, 0.45).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  const fused = new Map<string, number>();
  const fuse = (ids: string[]) => {
    ids.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  };
  fuse(lexical.map((seed) => seed.row.id));
  fuse(semantic.map((entry) => entry.id));
  fuse(graph);

  const known = new Map(lexical.map((seed) => [seed.row.id, seed.row]));
  const missing = [...fused.keys()].filter((id) => !known.has(id));
  if (missing.length > 0) {
    const placeholders = missing.map(() => "?").join(",");
    const rows = getDb().prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...missing) as MemoryRow[];
    for (const row of rows) known.set(row.id, row);
  }

  const top = Math.max(...fused.values(), 1e-9);
  const t = now();
  return [...fused.entries()]
    .filter(([id]) => known.has(id))
    .map(([id, base]) => {
      const row = known.get(id)!;
      return {
        row,
        score:
          base / top +
          (row.pinned ? 0.15 : 0) +
          Math.min(0.08, Math.log1p(row.use_count) * 0.03) +
          Math.max(0, 1 - Math.max(0, t - (row.last_used_at ?? row.updated_at)) / 86400 / 60) * 0.05,
      };
    })
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
}

/** Maximal Marginal Relevance: greedily pick the highest scoring fact that is
 * still *different* from what was already picked, so the injected context
 * covers distinct facts rather than paraphrases of one. */
function diversify(entries: { row: MemoryRow; score: number }[], limit: number, lambda = 0.65): MemoryRow[] {
  const pool = entries.map((entry) => ({ ...entry, tokens: terms(`${entry.row.title} ${entry.row.content}`) }));
  const chosen: MemoryRow[] = [];
  const chosenTerms: string[][] = [];

  while (chosen.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const similarity = chosenTerms.length
        ? Math.max(...chosenTerms.map((tokens) => jaccard(tokens, pool[i].tokens)))
        : 0;
      const value = lambda * pool[i].score - (1 - lambda) * similarity;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    chosen.push(pool[bestIndex].row);
    chosenTerms.push(pool[bestIndex].tokens);
    pool.splice(bestIndex, 1);
  }
  return chosen;
}

export async function searchMemory(query: string, limit = 4): Promise<MemoryRow[]> {
  if (terms(query).length === 0) {
    // No usable query: fall back to the most recently useful, pinned-first facts.
    return (
      getDb()
        .prepare("SELECT * FROM memories ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC LIMIT ?")
        .all(limit) as MemoryRow[]
    ).slice(0, limit);
  }
  return diversify(await rankedFacts(query), limit);
}

export async function listMemories(query?: string): Promise<(MemoryRow & { topic_path: string | null })[]> {
  const db = getDb();
  const rows = (
    query && query.trim()
      ? await searchMemory(query, 100)
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
    degree: neighboursOf(row.id).length,
  }));
}

export function setMemoryPinned(id: string, pinned: boolean) {
  getDb().prepare("UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, now(), id);
  markMemoryIndexDirty();
}

export function deleteMemory(id: string) {
  const db = getDb();
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(id);
  db.prepare("DELETE FROM memory_co_use WHERE from_id = ? OR to_id = ?").run(id, id);
  markVectorsDirty();
  markMemoryIndexDirty();
  markGraphDirty();
}

export function deleteEpisode(taskId: string) {
  getDb().prepare("DELETE FROM episodes WHERE task_id = ?").run(taskId);
  markMemoryIndexDirty();
}

export interface PruneReport {
  factsEvicted: number;
  factsMerged: number;
  episodesEvicted: number;
  topicsRemoved: number;
  budgetChars: number;
  usedChars: number;
}

/** Retention scoring with the fitted parameters: ACT-R base-level activation
 * says how strongly a memory is still retrievable, PageRank centrality says how
 * much the rest of the store depends on it, and utility says whether it has
 * actually earned its place. The decay exponent and the three weights come from
 * `memoryModel.fitModel`, not from constants. */
export function retentionScore(row: MemoryRow, params = loadParams()): number {
  return retentionScoreFrom(row, params, centralityOf(row.id));
}

/** Dynamic pruning. There is no age limit and no per-topic count: every fact is
 * scored, near-duplicates merge into the stronger one, and the rest are kept in
 * score order until the character budget is full - so the weakest memories are
 * the ones that go, and the store adapts to what the workspace actually uses.
 * Pinned facts are always kept. */
export function pruneMemory(): PruneReport {
  const db = getDb();
  const budget = factBudgetChars();
  const facts = db.prepare("SELECT * FROM memories").all() as MemoryRow[];

  // Refit from this workspace's own usage before deciding what survives, then
  // apply the fitted model. With too little data `fitModel` returns the priors.
  const params = fitModel(facts, centralityOf);
  saveParams(params);

  const ranked = facts
    .map((row) => ({ row, score: retentionScore(row, params) }))
    .sort((a, b) => b.row.pinned - a.row.pinned || b.score - a.score);

  const kept: { tokens: string[] }[] = [];
  const remove = db.prepare("DELETE FROM memories WHERE id = ?");
  let factsEvicted = 0;
  let factsMerged = 0;
  let usedChars = 0;

  const tx = db.transaction(() => {
    for (const entry of ranked) {
      const entryTerms = terms(`${entry.row.title} ${entry.row.content}`);
      if (kept.some((other) => jaccard(other.tokens, entryTerms) >= 0.8)) {
        remove.run(entry.row.id);
        factsMerged++;
        continue;
      }
      const cost = entry.row.title.length + entry.row.content.length;
      if (entry.row.pinned || usedChars + cost <= budget) {
        kept.push({ tokens: entryTerms });
        usedChars += cost;
        continue;
      }
      remove.run(entry.row.id);
      factsEvicted++;
    }
  });
  tx();

  const topicsRemoved = db
    .prepare(
      `DELETE FROM memory_topics
       WHERE id NOT IN (SELECT topic_id FROM memories WHERE topic_id IS NOT NULL)
         AND id NOT IN (SELECT parent_id FROM memory_topics WHERE parent_id IS NOT NULL)`
    )
    .run().changes;

  const episodesEvicted = pruneEpisodes();
  // Associations fade too: unused co-use edges decay on a 90-day half-life.
  decayCoUse();

  if (factsEvicted + factsMerged > 0) {
    markMemoryIndexDirty();
    markGraphDirty();
  }
  if (episodesEvicted > 0) markMemoryIndexDirty();

  return { factsEvicted, factsMerged, episodesEvicted, topicsRemoved, budgetChars: budget, usedChars };
}

export function memoryStats() {
  const db = getDb();
  const facts = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  const topics = (db.prepare("SELECT COUNT(*) AS n FROM memory_topics").get() as { n: number }).n;
  const episodes = (db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n;
  const usedChars = (db.prepare("SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content)), 0) AS n FROM memories").get() as {
    n: number;
  }).n;
  const graph = graphStats();
  return {
    facts,
    topics,
    episodes,
    usedChars,
    budgetChars: factBudgetChars(),
    links: graph.edges,
    model: loadParams(),
    vectors: vectorStats(),
    embeddings: embeddingStatus(),
  };
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
export async function buildMemoryContext(taskId: string, query: string): Promise<MemoryContext | null> {
  const episodes = searchEpisodes(query, 3);
  const memories = await searchMemory(query, 4);
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
