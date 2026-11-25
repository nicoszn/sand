/**
 * Workspace memory: what this app has learned, available to every task.
 *
 * This is now a four-tier store over one typed, bi-temporal graph (`graph.ts`).
 * The tiers are a retrieval strategy, not separate databases:
 *
 *   Tier 0 - working: pinned facts and what earlier turns of this task used.
 *            Always injected, no scoring.
 *   Tier 1 - episodic: one row per finished task (goal, outcome, summary, tools)
 *            in BM25, so "we already researched this" surfaces before work starts.
 *   Tier 2 - semantic: durable facts, hybrid-ranked (BM25 + MiniLM cosine +
 *            bounded personalised PageRank over the typed graph) and fused with
 *            reciprocal rank fusion.
 *   Tier 3 - community/archive: Louvain clusters over the fact graph, each with a
 *            generated summary. Retrieval scores a few dozen summaries first and
 *            only then drills into the winning cluster's members; pruning demotes
 *            cold facts here (compressed, still auditable) instead of deleting.
 *
 * Beliefs are bi-temporal. A fact contradicted by a newer one is not overwritten:
 * its validity window is closed (`valid_to`, status `superseded`), the new fact
 * points back at it, and an immutable revision row records both, so history and
 * explainability survive. Episodes and facts also keep provenance edges to the
 * task that produced them, which is what makes deletion honest:
 *
 *   - retraction  - soft: close the validity window, keep the audit trail.
 *   - archive     - decay-driven: demote a cold fact to a compressed tier-3 row.
 *   - purge       - hard: remove the row, vectors, revisions and edges.
 *
 * Deleting an episode never cascades into a fact another task independently
 * supports; it retracts only the facts that would otherwise have no provenance
 * left at all.
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
import { centralityOf, graphStats, markGraphDirty, neighboursOf, spreadActivation } from "./memoryGraph";
import {
  addEdge,
  centralityScores,
  edgesOf,
  hasOtherProvenance,
  invalidateEdge,
  removeEdgesTouching,
} from "./graph";
import {
  communityStats,
  listCommunities,
  recomputeCommunities,
  searchCommunities,
  membersOf,
} from "./communities";

/** Episodes have no use events of their own, so their decay uses the prior. */
const EPISODE_DECAY = 0.5;

const MAX_SUMMARY_CHARS = 1600;
const CONTEXT_BUDGET_CHARS = 2200;
const EPISODE_SUMMARY_IN_CONTEXT = 320;
const FACT_CHARS_IN_CONTEXT = 240;
const MIN_SCORE = 0.12;

/** A near-identical re-assertion reinforces the existing fact. */
const DUPLICATE_SIMILARITY = 0.92;
/** Close enough to be the same claim, different enough to be a new belief. */
const SUPERSEDE_SIMILARITY = 0.7;
/** Two facts this similar are merged during pruning. */
const MERGE_SIMILARITY = 0.8;

/** Capacity, not policy: the score decides *which* memories survive, these
 * budgets decide how much the store can hold. Overridable in Settings. */
const FACT_BUDGET_DEFAULT = 120_000; // characters of fact text (~30k tokens)
const EPISODE_BUDGET_DEFAULT = 400_000;
/** Cold storage: archived + superseded facts are compressed and capped, so the
 * audit trail cannot grow without bound. */
const ARCHIVE_BUDGET_DEFAULT = 60_000;
const ARCHIVE_ROW_CHARS = 240;
const ARCHIVE_MAX_ROWS = 400;

export function factBudgetChars() {
  return Math.max(2_000, getSettingInt("memory_budget_chars", FACT_BUDGET_DEFAULT));
}

export function episodeBudgetChars() {
  return Math.max(5_000, getSettingInt("episode_budget_chars", EPISODE_BUDGET_DEFAULT));
}

export function archiveBudgetChars() {
  return Math.max(2_000, getSettingInt("memory_archive_chars", ARCHIVE_BUDGET_DEFAULT));
}

/** Provenance display: how a fact was found. */
export type RetrievalVia = "lexical" | "semantic" | "graph" | "community" | "pinned" | "working";

export interface MemoryRef {
  type: "task" | "memory" | "community";
  id: string;
  title: string;
  score: number;
  via?: RetrievalVia;
}

export interface MemoryContext {
  block: string;
  refs: MemoryRef[];
  tiers: { working: number; episodes: number; facts: number; communities: number };
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
  status: MemoryStatus;
  valid_from: number;
  valid_to: number | null;
  superseded_by: string | null;
  supersedes: string | null;
  revision: number;
  community_id: string | null;
}

export type MemoryStatus = "active" | "superseded" | "retracted" | "archived";

export interface MemoryRevision {
  id: number;
  memory_id: string;
  revision: number;
  title: string;
  content: string;
  change: string;
  note: string | null;
  recorded_at: number;
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

/** Immutable audit row. Every state change to a fact writes one, so the
 * transaction-time half of bi-temporality is never inferred from a mutable row. */
function addRevision(row: MemoryRow, change: string, note: string | null = null) {
  getDb()
    .prepare(
      `INSERT INTO memory_revisions (memory_id, revision, title, content, change, note, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.revision, row.title, row.content, change, note, now());
}

/** Facts the agent currently believes: explicitly active with an open window. */
function activeFact(id: string): MemoryRow | undefined {
  return getDb()
    .prepare("SELECT * FROM memories WHERE id = ? AND status = 'active' AND valid_to IS NULL")
    .get(id) as MemoryRow | undefined;
}

/* ------------------------------------------------------------- episodes */

/** Projects a finished task into the typed graph: task CONTAINS each step, a
 * step PRODUCED the tool call it made. Lineage edges are what provenance walks
 * use later, so they are written once per task and never rebuilt away. */
function ingestTaskGraph(taskId: string) {
  const db = getDb();
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as { id: string } | undefined;
  if (!task) return;

  const steps = db
    .prepare("SELECT id, kind, content FROM steps WHERE task_id = ? ORDER BY id ASC LIMIT 80")
    .all(taskId) as { id: number; kind: string; content: string }[];

  for (const step of steps) {
    addEdge({
      from: { type: "task", id: taskId },
      relation: "CONTAINS",
      to: { type: "step", id: String(step.id) },
      provenance: `task:${taskId}`,
    });
    if (step.kind !== "tool_call") continue;
    let tool = "tool";
    try {
      tool = String(JSON.parse(step.content).tool ?? "tool");
    } catch {
      /* malformed step content is still a step */
    }
    addEdge({
      from: { type: "step", id: String(step.id) },
      relation: "PRODUCED",
      to: { type: "tool_call", id: `${step.id}:${tool}` },
      provenance: `task:${taskId}`,
    });
  }
}

/** Writes (or refreshes) the episode for a finished task and prunes old ones. */
export function recordEpisode(taskId: string) {
  const db = getDb();
  const task = db
    .prepare(
      "SELECT id, goal, status, result, step_count, prompt_tokens, completion_tokens, created_at FROM tasks WHERE id = ?"
    )
    .get(taskId) as
    | (Pick<TaskRow, "id" | "goal" | "status" | "result" | "step_count" | "created_at"> & {
        prompt_tokens: number;
        completion_tokens: number;
      })
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

  ingestTaskGraph(taskId);
  addEdge({
    from: { type: "task", id: taskId },
    relation: "PRODUCED",
    to: { type: "episode", id: taskId },
    provenance: `task:${taskId}`,
  });

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

function topicPathOf(topicId: string | null): string | null {
  if (!topicId) return null;
  const row = getDb().prepare("SELECT path FROM memory_topics WHERE id = ?").get(topicId) as
    | { path: string }
    | undefined;
  return row?.path ?? null;
}

export interface RememberResult {
  id: string;
  updated: boolean;
  topicPath: string | null;
  /** The fact this one replaced, when it contradicted an earlier belief. */
  superseded: string | null;
  revision: number;
}

/**
 * Saves a fact, with contradiction handling instead of blind overwrite.
 *
 *  - ≥ 92% similar to an active fact in the same topic: the same claim. Reinforce
 *    it (usage, updated_at, a corroboration edge) and keep one row.
 *  - 70–92%: a refinement or a changed value. Write a new fact, close the old
 *    one's validity window, link the two with SUPERSEDES, and record both in the
 *    revision log - so "the price was X last Tuesday" stays answerable.
 *  - Otherwise: a genuinely new fact.
 */
export function rememberFact(input: {
  taskId: string;
  title: string;
  content: string;
  topic?: string | null;
  kind?: string | null;
}): RememberResult {
  const db = getDb();
  const title = input.title.trim().slice(0, 200);
  const content = input.content.trim().slice(0, 4000);
  if (!title || !content) throw new Error("remember needs both a title and content");

  const topicId = resolveTopic(input.topic);
  const topicPath = topicPathOf(topicId);
  const incoming = terms(`${title} ${content}`);
  const candidates = db
    .prepare("SELECT * FROM memories WHERE status = 'active' AND (topic_id = ? OR (topic_id IS NULL AND ? IS NULL))")
    .all(topicId, topicId) as MemoryRow[];

  const scored = candidates
    .map((row) => ({ row, similarity: jaccard(incoming, terms(`${row.title} ${row.content}`)) }))
    .sort((a, b) => b.similarity - a.similarity);

  const bestMatch = scored[0]?.similarity ?? 0;
  const duplicate = bestMatch >= DUPLICATE_SIMILARITY ? scored[0].row : null;
  const contradicted = !duplicate && bestMatch >= SUPERSEDE_SIMILARITY ? scored[0].row : null;

  const t = now();
  const linkProvenance = (factId: string) => {
    if (input.taskId) {
      addEdge({
        from: { type: "fact", id: factId },
        relation: "DERIVED_FROM",
        to: { type: "task", id: input.taskId },
        provenance: `tool:remember`,
      });
    }
    if (topicId) {
      addEdge({
        from: { type: "fact", id: factId },
        relation: "REFERENCES",
        to: { type: "topic", id: topicId },
        provenance: "tool:remember",
      });
    }
  };

  if (duplicate) {
    db.prepare("UPDATE memories SET content = ?, updated_at = ?, use_count = use_count + 1 WHERE id = ?").run(
      content,
      t,
      duplicate.id
    );
    markMemoryIndexDirty();
    markGraphDirty();
    queueEmbedding(duplicate.id, duplicate.title, content);
    linkProvenance(duplicate.id);
    return { id: duplicate.id, updated: true, topicPath, superseded: null, revision: duplicate.revision };
  }

  // Retire the contradicted belief: close its window, keep the row and audit.
  if (contradicted) {
    db.prepare(
      "UPDATE memories SET status = 'superseded', valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ?"
    ).run(t, "pending", t, contradicted.id);
    addRevision(contradicted, "superseded", `replaced by a newer belief about "${title}"`);
  }

  const id = randomBytes(6).toString("hex");
  db.prepare(
    `INSERT INTO memories
       (id, topic_id, kind, title, content, source_task_id, pinned, use_count, created_at, updated_at, last_used_at,
        status, valid_from, valid_to, superseded_by, supersedes, revision, community_id)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, 'active', ?, NULL, NULL, ?, 1, NULL)`
  ).run(id, topicId, input.kind?.trim() || "fact", title, content, input.taskId, t, t, t, contradicted?.id ?? null);

  if (contradicted) {
    db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(id, contradicted.id);
    addEdge({
      from: { type: "fact", id },
      relation: "SUPERSEDES",
      to: { type: "fact", id: contradicted.id },
      provenance: "tool:remember",
    });
  }

  linkProvenance(id);
  const created: MemoryRow = {
    id,
    topic_id: topicId,
    kind: input.kind?.trim() || "fact",
    title,
    content,
    source_task_id: input.taskId,
    pinned: 0,
    use_count: 0,
    created_at: t,
    updated_at: t,
    last_used_at: null,
    status: "active",
    valid_from: t,
    valid_to: null,
    superseded_by: null,
    supersedes: contradicted?.id ?? null,
    revision: 1,
    community_id: null,
  };
  addRevision(created, "created", contradicted ? `supersedes ${contradicted.id}` : null);
  markMemoryIndexDirty();
  markGraphDirty();
  // Embedding happens off the write path so `remember` never waits on the model.
  queueEmbedding(id, title, content);
  return { id, updated: false, topicPath, superseded: contradicted?.id ?? null, revision: 1 };
}

/** Reciprocal Rank Fusion constant. RRF (Cormack et al.) combines rankings
 * without needing the scorers to share a scale - BM25 scores, cosine
 * similarities and PageRank mass are not comparable, ranks are. */
const RRF_K = 60;

/**
 * Hybrid retrieval over the semantic tier, four signals:
 *
 *   lexical (BM25 + fuzzy + prefix)   → rank list 1
 *   semantic (MiniLM cosine)          → rank list 2
 *   bounded personalised PageRank     → rank list 3 (multi-hop associations)
 *   community summaries (tier 3)      → rank list 4 (coarse cluster expansion)
 *
 * fused with RRF, then tie-breaking bonuses, then diversified by MMR. Each
 * signal covers what the others miss: exact wording, paraphrase, association,
 * and theme. If embeddings are unavailable the other three still work.
 */
async function rankedFacts(query: string): Promise<{ row: MemoryRow; score: number; via: RetrievalVia }[]> {
  const lexical = searchFactIndex(query, 40);
  const semantic = await rankByVector(query, 40);
  if (lexical.length === 0 && semantic.length === 0) {
    // A query with no lexical or semantic hit can still match a cluster theme.
    const communities = searchCommunities(query, 1);
    if (communities.length === 0) return [];
  }

  const seeds = [
    ...lexical.map((seed) => ({ id: seed.row.id, score: seed.score })),
    ...semantic.slice(0, 10).map((entry) => ({ id: entry.id, score: entry.score })),
  ];
  const graph = [...spreadActivation(seeds, 0.45).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  // Tier 3 first: score a handful of cluster summaries, then expand the winner.
  const communities = searchCommunities(query, 2);
  const communityMembers = communities.flatMap((community) => membersOf(community.id, 30)).slice(0, 40);

  // First list to find a fact names how it was found, so the UI and the prompt
  // can say "matched the words" vs "reached through the graph" vs "same theme".
  const fused = new Map<string, { score: number; via: RetrievalVia }>();
  const fuse = (ids: string[], via: RetrievalVia) => {
    ids.forEach((id, rank) => {
      const entry = fused.get(id) ?? { score: 0, via };
      entry.score += 1 / (RRF_K + rank + 1);
      fused.set(id, entry);
    });
  };
  fuse(lexical.map((seed) => seed.row.id), "lexical");
  fuse(semantic.map((entry) => entry.id), "semantic");
  fuse(graph, "graph");
  fuse(communityMembers, "community");

  const ids = [...fused.keys()];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM memories WHERE status = 'active' AND id IN (${placeholders})`)
    .all(...ids) as MemoryRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));

  const top = Math.max(...[...fused.values()].map((entry) => entry.score), 1e-9);
  const t = now();
  return [...fused.entries()]
    .filter(([id]) => byId.has(id))
    .map(([id, entry]) => {
      const row = byId.get(id)!;
      return {
        row,
        via: entry.via,
        score:
          entry.score / top +
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
function diversify(
  entries: { row: MemoryRow; score: number; via?: RetrievalVia }[],
  limit: number,
  lambda = 0.65
): { row: MemoryRow; via?: RetrievalVia }[] {
  const pool = entries.map((entry) => ({ ...entry, tokens: terms(`${entry.row.title} ${entry.row.content}`) }));
  const chosen: { row: MemoryRow; via?: RetrievalVia }[] = [];
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
    chosen.push({ row: pool[bestIndex].row, via: pool[bestIndex].via });
    chosenTerms.push(pool[bestIndex].tokens);
    pool.splice(bestIndex, 1);
  }
  return chosen;
}

/**
 * Bi-temporal query: what the workspace believed at `asOf`, including beliefs
 * that have since been superseded or retracted. This is the query flat stores
 * cannot answer at all - they overwrite, so the earlier answer is gone.
 */
function searchFactsAsOf(query: string, asOf: number, limit: number): MemoryRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memories
       WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
         AND status IN ('active', 'superseded', 'archived')
       ORDER BY updated_at DESC LIMIT 500`
    )
    .all(asOf, asOf) as MemoryRow[];
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return rows.slice(0, limit);

  return rows
    .map((row) => ({
      row,
      score:
        jaccard(queryTerms, terms(`${row.title} ${row.content}`)) * 0.8 +
        (row.pinned ? 0.1 : 0) +
        recencyBonus(row.updated_at),
    }))
    .filter((entry) => entry.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.row);
}

export async function searchMemory(
  query: string,
  limit = 4,
  options: { asOf?: number } = {}
): Promise<MemoryRow[]> {
  if (options.asOf !== undefined && options.asOf < now()) return searchFactsAsOf(query, options.asOf, limit);

  if (terms(query).length === 0) {
    // No usable query: fall back to the most recently useful, pinned-first facts.
    return (
      getDb()
        .prepare(
          "SELECT * FROM memories WHERE status = 'active' ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC LIMIT ?"
        )
        .all(limit) as MemoryRow[]
    ).slice(0, limit);
  }
  return diversify(await rankedFacts(query), limit).map((entry) => entry.row);
}

export async function listMemories(
  query?: string,
  options: { includeInactive?: boolean } = {}
): Promise<(MemoryRow & { topic_path: string | null; degree: number; history: number })[]> {
  const db = getDb();
  const statuses = options.includeInactive
    ? "('active', 'superseded', 'retracted', 'archived')"
    : "('active')";
  const rows = (
    query && query.trim()
      ? options.includeInactive
        ? (db
            .prepare(
              `SELECT * FROM memories WHERE status IN ${statuses} AND (title LIKE ? OR content LIKE ?)
               ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC LIMIT 200`
            )
            .all(`%${query.trim()}%`, `%${query.trim()}%`) as MemoryRow[])
        : await searchMemory(query, 100)
      : (db
          .prepare(
            `SELECT * FROM memories WHERE status IN ${statuses}
             ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC LIMIT 200`
          )
          .all() as MemoryRow[])
  ) as MemoryRow[];

  const topics = new Map(
    (db.prepare("SELECT id, path FROM memory_topics").all() as { id: string; path: string }[]).map((row) => [
      row.id,
      row.path,
    ])
  );
  const revisionCounts = new Map(
    (db.prepare("SELECT memory_id, COUNT(*) AS n FROM memory_revisions GROUP BY memory_id").all() as {
      memory_id: string;
      n: number;
    }[]).map((row) => [row.memory_id, row.n])
  );

  return rows.map((row) => ({
    ...row,
    topic_path: row.topic_id ? topics.get(row.topic_id) ?? null : null,
    degree: neighboursOf(row.id).length,
    history: revisionCounts.get(row.id) ?? 1,
  }));
}

export function setMemoryPinned(id: string, pinned: boolean) {
  getDb().prepare("UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, now(), id);
  markMemoryIndexDirty();
}

/* --------------------------------------------------- deletion semantics */

/** Retraction: stop believing a fact, keep every trace of it. */
export function retractMemory(id: string, note = "retracted by a person"): boolean {
  const row = getDb().prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  if (!row || row.status === "retracted") return false;
  const t = now();
  getDb()
    .prepare("UPDATE memories SET status = 'retracted', valid_to = ?, updated_at = ? WHERE id = ?")
    .run(t, t, id);
  addRevision({ ...row, valid_to: t, updated_at: t }, "retracted", note);
  invalidateFactEdges(id);
  markMemoryIndexDirty();
  markGraphDirty();
  markVectorsDirty();
  return true;
}

/** Un-retracts a belief: the window reopens, the audit keeps both events. */
export function restoreMemory(id: string): boolean {
  const row = getDb().prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  if (!row || row.status !== "retracted") return false;
  // Never resurrect a belief a newer fact already replaced: that would present
  // two contradictory facts as current and quietly undo a supersession.
  if (row.superseded_by && activeFact(row.superseded_by)) return false;
  const t = now();
  getDb()
    .prepare("UPDATE memories SET status = 'active', valid_to = NULL, updated_at = ? WHERE id = ?")
    .run(t, id);
  addRevision({ ...row, status: "active", valid_to: null, updated_at: t }, "restored", "belief reinstated");
  markMemoryIndexDirty();
  markGraphDirty();
  markVectorsDirty();
  queueEmbedding(row.id, row.title, row.content);
  return true;
}

/** Hard delete (compliance semantics): the row, its vectors, its revision log
 * and every edge touching it. Irreversible, and only ever explicit. */
export function purgeMemory(id: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT id FROM memories WHERE id = ?").get(id) as { id: string } | undefined;
  if (!row) return false;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM memory_revisions WHERE memory_id = ?").run(id);
    db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(id);
    db.prepare("DELETE FROM memory_community_members WHERE memory_id = ?").run(id);
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  });
  tx();
  removeEdgesTouching({ type: "fact", id });
  markVectorsDirty();
  markMemoryIndexDirty();
  markGraphDirty();
  return true;
}

/** Kept as the route's default: a user-facing "forget" is a retraction, not a
 * destructive purge, so an accidental click never loses the audit trail. */
export function deleteMemory(id: string) {
  retractMemory(id, "removed from the memory page");
}

/** Closing a fact's validity also retires the associations that only existed
 * because it was current; lineage is left alone. */
function invalidateFactEdges(id: string) {
  for (const entry of edgesOf({ type: "fact", id })) {
    if (entry.edge.relation === "RELATES_TO") invalidateEdge(entry.edge.id);
  }
}

/**
 * Deleting an episode (a task's memory) is not allowed to silently destroy facts
 * other work corroborates. Each fact whose only provenance is this task is
 * retracted; facts with any other source keep their validity, and the removal is
 * noted in their audit trail.
 */
export function deleteEpisode(taskId: string): { retracted: string[]; kept: string[] } {
  const db = getDb();
  const derived = db
    .prepare("SELECT * FROM memories WHERE source_task_id = ? AND status IN ('active', 'archived')")
    .all(taskId) as MemoryRow[];

  const retracted: string[] = [];
  const kept: string[] = [];
  for (const row of derived) {
    const otherSource = hasOtherProvenance({ type: "fact", id: row.id }, [{ type: "task", id: taskId }]);
    // A fact several tasks assert survives; a fact only this task ever asserted
    // stops being believed, with its history intact.
    if (otherSource) {
      kept.push(row.id);
      addRevision(row, "noted", `source episode ${taskId} was removed; corroborated elsewhere`);
    } else {
      retracted.push(row.id);
      retractMemory(row.id, `source episode ${taskId} was removed`);
    }
  }

  db.prepare("DELETE FROM episodes WHERE task_id = ?").run(taskId);
  removeEdgesTouching({ type: "episode", id: taskId });
  markMemoryIndexDirty();
  return { retracted, kept };
}

export interface HistoryEntry {
  memory: MemoryRow;
  revisions: MemoryRevision[];
}

/** The belief chain for a fact: every version, oldest first, plus the chain of
 * facts it superseded and the facts that superseded it. */
export function memoryHistory(id: string, limit = 20): HistoryEntry[] {
  const db = getDb();
  const entry = (memoryId: string): HistoryEntry | null => {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as MemoryRow | undefined;
    if (!row) return null;
    return {
      memory: row,
      revisions: db
        .prepare("SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY id ASC LIMIT 50")
        .all(memoryId) as MemoryRevision[],
    };
  };

  const seen = new Set<string>([id]);
  const chain: HistoryEntry[] = [];
  const first = entry(id);
  if (!first) return [];

  // Walk backwards through supersedes, forwards through superseded_by.
  let cursor: MemoryRow | undefined = first.memory;
  const back: MemoryRow[] = [];
  while (cursor?.supersedes && back.length < limit && !seen.has(cursor.supersedes)) {
    seen.add(cursor.supersedes);
    const previous = entry(cursor.supersedes);
    if (!previous) break;
    back.unshift(previous.memory);
    cursor = previous.memory;
  }
  cursor = first.memory;
  const forward: MemoryRow[] = [];
  while (cursor?.superseded_by && forward.length < limit && !seen.has(cursor.superseded_by)) {
    seen.add(cursor.superseded_by);
    const next = entry(cursor.superseded_by);
    if (!next) break;
    forward.push(next.memory);
    cursor = next.memory;
  }

  for (const row of [...back, first.memory, ...forward]) {
    const built = row.id === id ? first : entry(row.id);
    if (built) chain.push(built);
  }
  return chain;
}

/* ------------------------------------------------------------ retention */

export interface PruneReport {
  factsArchived: number;
  factsMerged: number;
  historiesEvicted: number;
  episodesEvicted: number;
  topicsRemoved: number;
  budgetChars: number;
  usedChars: number;
  archivedChars: number;
}

/** Retention scoring with the fitted parameters: ACT-R base-level activation
 * says how strongly a memory is still retrievable, PageRank centrality says how
 * much the rest of the store depends on it, and utility says whether it has
 * actually earned its place. */
export function retentionScore(row: MemoryRow, params = loadParams()): number {
  return retentionScoreFrom(row, params, centralityOf(row.id));
}

/** Demotion to cold storage: content is compressed to its first paragraph, the
 * row and its validity window stay, so the fact is still auditable but costs a
 * fraction of the budget. */
function archiveFact(row: MemoryRow, reason: string): number {
  const db = getDb();
  const compressed = row.content.length > ARCHIVE_ROW_CHARS ? `${row.content.slice(0, ARCHIVE_ROW_CHARS)}…` : row.content;
  const freed = Math.max(0, row.title.length + row.content.length - (row.title.length + compressed.length));
  db.prepare(
    "UPDATE memories SET status = 'archived', content = ?, updated_at = ?, community_id = NULL WHERE id = ?"
  ).run(compressed, now(), row.id);
  addRevision({ ...row, status: "archived", content: compressed }, "archived", reason);
  markVectorsDirty();
  return freed;
}

/**
 * Dynamic pruning with three outcomes, never one blunt delete:
 *
 *  1. near-duplicates merge into the stronger belief (the weaker is superseded,
 *     so its wording is still in the revision log);
 *  2. facts that no longer earn their budget are demoted to the archive tier;
 *  3. only archive rows beyond their own cap are actually evicted.
 *
 * Pinned facts are always kept. There is still no age limit anywhere: the score
 * decides, and the score is fitted from this workspace's own usage.
 */
export function pruneMemory(): PruneReport {
  const db = getDb();
  const budget = factBudgetChars();
  const facts = db.prepare("SELECT * FROM memories WHERE status = 'active'").all() as MemoryRow[];

  // One PageRank pass for the whole store, not one per fact: centrality is a
  // global property, so recomputing it inside the scoring loop was both slower
  // and inconsistent between rows.
  const centrality = centralityScores(["fact"]);
  const centralityOfFact = (id: string) => centrality.get(`fact:${id}`) ?? 0;
  const params = fitModel(facts, centralityOfFact);
  saveParams(params);

  const ranked = facts
    .map((row) => ({ row, score: retentionScoreFrom(row, params, centralityOfFact(row.id)) }))
    .sort((a, b) => b.row.pinned - a.row.pinned || b.score - a.score);

  const kept: { tokens: string[] }[] = [];
  let factsArchived = 0;
  let factsMerged = 0;
  let usedChars = 0;

  for (const entry of ranked) {
    const entryTerms = terms(`${entry.row.title} ${entry.row.content}`);
    const duplicate = kept.find((other) => jaccard(other.tokens, entryTerms) >= MERGE_SIMILARITY);
    if (duplicate && !entry.row.pinned) {
      db.prepare("UPDATE memories SET status = 'superseded', valid_to = ?, updated_at = ? WHERE id = ?").run(
        now(),
        now(),
        entry.row.id
      );
      addRevision(entry.row, "superseded", "merged into a near-duplicate fact");
      factsMerged++;
      continue;
    }
    const cost = entry.row.title.length + entry.row.content.length;
    if (entry.row.pinned || usedChars + cost <= budget) {
      kept.push({ tokens: entryTerms });
      usedChars += cost;
      continue;
    }
    archiveFact(entry.row, "over the fact budget; demoted to the archive tier");
    factsArchived++;
  }

  // The archive has a budget of its own: oldest, least-used rows go first.
  const cold = db
    .prepare(
      `SELECT * FROM memories WHERE status IN ('archived', 'superseded')
       ORDER BY pinned ASC, COALESCE(last_used_at, updated_at) ASC`
    )
    .all() as MemoryRow[];
  let archivedChars = cold.reduce((sum, row) => sum + row.title.length + row.content.length, 0);
  const archiveBudget = archiveBudgetChars();
  const purge = db.prepare("DELETE FROM memories WHERE id = ?");
  const purgeRevision = db.prepare("DELETE FROM memory_revisions WHERE memory_id = ?");
  let historiesEvicted = 0;
  for (let index = 0; index < cold.length; index++) {
    const row = cold[index];
    const cost = row.title.length + row.content.length;
    const overRows = cold.length - index > ARCHIVE_MAX_ROWS;
    if (archivedChars <= archiveBudget && !overRows) continue;
    if (row.pinned) continue;
    purge.run(row.id);
    purgeRevision.run(row.id);
    db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(row.id);
    removeEdgesTouching({ type: "fact", id: row.id });
    archivedChars -= cost;
    historiesEvicted++;
  }

  const topicsRemoved = db
    .prepare(
      `DELETE FROM memory_topics
       WHERE id NOT IN (SELECT topic_id FROM memories WHERE topic_id IS NOT NULL)
         AND id NOT IN (SELECT parent_id FROM memory_topics WHERE parent_id IS NOT NULL)`
    )
    .run().changes;

  const episodesEvicted = pruneEpisodes();
  // Derived relations and community structure both depend on the current fact
  // set, so they are recomputed after a prune rather than left stale.
  if (factsMerged + factsArchived + historiesEvicted > 0) {
    markMemoryIndexDirty();
    markGraphDirty();
  }
  if (episodesEvicted > 0) markMemoryIndexDirty();
  try {
    recomputeCommunities();
  } catch {
    /* communities are derived state; never fail a prune over them */
  }

  return {
    factsArchived,
    factsMerged,
    historiesEvicted,
    episodesEvicted,
    topicsRemoved,
    budgetChars: budget,
    usedChars,
    archivedChars,
  };
}

export function memoryStats() {
  const db = getDb();
  const facts = (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'").get() as { n: number }).n;
  const archived = (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'archived'").get() as { n: number }).n;
  const superseded = (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'superseded'").get() as { n: number })
    .n;
  const retracted = (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'retracted'").get() as { n: number })
    .n;
  const topics = (db.prepare("SELECT COUNT(*) AS n FROM memory_topics").get() as { n: number }).n;
  const episodes = (db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n;
  const usedChars = (
    db
      .prepare(
        "SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content)), 0) AS n FROM memories WHERE status = 'active'"
      )
      .get() as { n: number }
  ).n;
  const graph = graphStats();
  const communities = communityStats();
  return {
    facts,
    archived,
    superseded,
    retracted,
    topics,
    episodes,
    usedChars,
    budgetChars: factBudgetChars(),
    archiveBudgetChars: archiveBudgetChars(),
    links: graph.edges,
    graph,
    communities,
    model: loadParams(),
    vectors: vectorStats(),
    embeddings: embeddingStatus(),
    tiers: {
      working: (
        db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'active' AND pinned = 1").get() as { n: number }
      ).n,
      episodic: episodes,
      semantic: facts,
      archive: archived + superseded,
    },
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

/**
 * Builds the "what we already know" block injected into a new task's system
 * prompt, plus the refs the UI shows as provenance. Retrieval is tiered - a
 * couple of cluster summaries for orientation, earlier tasks for precedent,
 * facts for detail, pinned facts as always-on working memory - and the block is
 * budgeted, so unrelated tasks stay clean.
 */
export async function buildMemoryContext(taskId: string, query: string): Promise<MemoryContext | null> {
  const episodes = searchEpisodes(query, 3);
  const ranked = diversify(await rankedFacts(query), 4);
  const facts = ranked.map((entry) => entry.row);
  const communities = searchCommunities(query, 2);

  // Tier 0: pinned facts are always worth a line, even when the query misses.
  const pinned = getDb()
    .prepare(
      "SELECT * FROM memories WHERE status = 'active' AND pinned = 1 ORDER BY COALESCE(last_used_at, updated_at) DESC LIMIT 2"
    )
    .all() as MemoryRow[];
  const working = pinned.filter((row) => !facts.some((fact) => fact.id === row.id));
  const allFacts = [...facts, ...working];

  if (episodes.length === 0 && allFacts.length === 0 && communities.length === 0) return null;

  const refs: MemoryRef[] = [];
  const parts: string[] = [];

  if (communities.length > 0) {
    const lines = communities.map((community) => {
      refs.push({ type: "community", id: community.id, title: community.label, score: community.score, via: "community" });
      return `- ${community.label} — ${community.summary}`;
    });
    parts.push(`Themes this workspace has built up (coarse clusters, drill in with \`recall\`):\n${lines.join("\n")}`);
  }

  if (episodes.length > 0) {
    const lines = episodes.map((episode) => {
      refs.push({ type: "task", id: episode.task_id, title: episode.goal, score: 1, via: "lexical" });
      const summary =
        episode.summary.length > EPISODE_SUMMARY_IN_CONTEXT
          ? `${episode.summary.slice(0, EPISODE_SUMMARY_IN_CONTEXT)}…`
          : episode.summary;
      return `- [task ${episode.task_id} · ${episode.outcome} · ${relativeAge(episode.updated_at)}] ${episode.goal}\n  → ${summary.replace(/\n+/g, " ")}`;
    });
    parts.push(`Earlier tasks in this workspace:\n${lines.join("\n")}`);
  }

  if (allFacts.length > 0) {
    const topics = new Map(
      (getDb().prepare("SELECT id, path FROM memory_topics").all() as { id: string; path: string }[]).map((row) => [
        row.id,
        row.path,
      ])
    );
    const viaById = new Map(ranked.map((entry) => [entry.row.id, entry.via]));
    const lines = allFacts.map((memory) => {
      const via: RetrievalVia = memory.pinned && !viaById.has(memory.id) ? "pinned" : viaById.get(memory.id) ?? "working";
      refs.push({ type: "memory", id: memory.id, title: memory.title, score: 1, via });
      const path = memory.topic_id ? `[${topics.get(memory.topic_id) ?? "general"}] ` : "";
      const body =
        memory.content.length > FACT_CHARS_IN_CONTEXT
          ? `${memory.content.slice(0, FACT_CHARS_IN_CONTEXT)}…`
          : memory.content;
      /** Facts carry their validity window so the model can tell a current
       * belief from one it should re-verify. */
      const freshness = memory.valid_from ? ` (believed since ${new Date(memory.valid_from * 1000).toISOString().slice(0, 10)})` : "";
      return `- ${path}${memory.title}${freshness}: ${body.replace(/\n+/g, " ")}`;
    });
    parts.push(`Facts saved from earlier work:\n${lines.join("\n")}`);
  }

  const header = [
    "## Workspace memory",
    "",
    "You share this workspace with earlier tasks. Use the notes below as prior knowledge:",
    "- Do not redo work that is already done and verified - build on it instead.",
    "- Anything that can change (prices, versions, dates, availability) may be stale: re-verify when it matters, and say so.",
    "- A fact below is the belief the workspace currently holds; older, contradicted beliefs were retired, not deleted.",
    "- You may call `recall` for more context (optionally `as_of` a date), `read_task` to read an earlier task in full, and `remember` to save a durable fact for later tasks.",
    "- When a result leans on earlier work, cite the task id it came from.",
    "",
  ].join("\n");

  let block = `\n\n${header}${parts.join("\n\n")}`;
  if (block.length > CONTEXT_BUDGET_CHARS) {
    block = `${block.slice(0, CONTEXT_BUDGET_CHARS)}\n… (workspace memory truncated)`;
  }

  markMemoriesUsed(allFacts.map((memory) => memory.id));
  return {
    block,
    refs,
    tiers: { working: working.length, episodes: episodes.length, facts: facts.length, communities: communities.length },
  };
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

  // Facts this task contributed, and whether they are still believed: reading an
  // old task should not present a retracted claim as current.
  const facts = db
    .prepare("SELECT title, status FROM memories WHERE source_task_id = ? ORDER BY created_at ASC LIMIT 12")
    .all(taskId) as { title: string; status: string }[];

  const result = (task.result ?? "(no result)").slice(0, 5000);
  const digest = [
    `Task ${task.id} - ${task.status} - ${relativeAge(task.created_at)}`,
    `Goal: ${task.goal}`,
    `Steps: ${task.step_count}, tokens: ${task.prompt_tokens + task.completion_tokens}`,
    tools ? `Tools used:\n${tools}` : "Tools used: none",
    facts.length > 0
      ? `Facts this task saved: ${facts.map((fact) => `"${fact.title}" (${fact.status})`).join(", ")}`
      : "Facts this task saved: none",
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

/** Diagnostics for the memory page: the archived/superseded shelf and the
 * community hierarchy in one call, so the UI does not need two requests. */
export function memoryShelf(): {
  inactive: (MemoryRow & { topic_path: string | null })[];
  communities: ReturnType<typeof listCommunities>;
} {
  const db = getDb();
  const inactive = db
    .prepare(
      `SELECT * FROM memories WHERE status IN ('superseded', 'retracted', 'archived')
       ORDER BY COALESCE(last_used_at, updated_at) DESC LIMIT 50`
    )
    .all() as MemoryRow[];
  const topics = new Map(
    (db.prepare("SELECT id, path FROM memory_topics").all() as { id: string; path: string }[]).map((row) => [
      row.id,
      row.path,
    ])
  );
  return {
    inactive: inactive.map((row) => ({
      ...row,
      topic_path: row.topic_id ? topics.get(row.topic_id) ?? null : null,
    })),
    communities: listCommunities(),
  };
}

/** Exposed for the task runner: the facts a task was given, and the edges that
 * connect them, so a successful task can reinforce exactly those paths. */
export function memoryEdgeKeys(ids: string[]): string[] {
  const keys: string[] = [];
  for (const id of ids) {
    for (const entry of edgesOf({ type: "fact", id })) {
      if (entry.edge.relation === "RELATES_TO") keys.push(entry.edge.id);
    }
  }
  return keys;
}
