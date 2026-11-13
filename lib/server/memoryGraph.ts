/**
 * The relation layer of workspace memory: memory nodes connected by weighted
 * edges, used for two things retrieval alone cannot do.
 *
 *  1. Retrieval by association, not just by words. A lexical search can only
 *     find facts that share a term with the question; spreading activation
 *     (Collins & Loftus) starts from the lexical hits and lets relevance flow
 *     along edges, so a fact about "BTC dominance" surfaces for a question
 *     about "bitcoin market cap" because a linked fact mentions both.
 *  2. Deciding what a memory is worth keeping. Centrality (weighted PageRank)
 *     says which nodes the rest of the store depends on, so retention scores
 *     can protect connective facts instead of just old or popular ones.
 *
 * Edges are derived, not hand-maintained: two facts are linked when they share
 * a topic, share salient vocabulary, or came out of the same task. The graph is
 * rebuilt lazily whenever memory changes (hundreds of nodes, milliseconds) and
 * mirrored into `memory_links` so it is inspectable and survives a restart.
 */
import { getDb, now } from "./db";
import { jaccard, salientTerms } from "./text";

export type LinkKind = "topic" | "term" | "task" | "co-use";

interface Edge {
  id: string;
  weight: number;
  kind: LinkKind;
}

interface FactNode {
  id: string;
  topic_id: string | null;
  title: string;
  content: string;
  source_task_id: string | null;
}

/** A fact only needs its strongest few relations; keeping every pair would
 * turn a small store into a dense graph where everything "relates" to
 * everything and ranking stops discriminating. */
const MAX_DEGREE = 8;
const MIN_EDGE_WEIGHT = 0.25;
const MAX_TOPIC_GROUP = 60;
const TERM_DF_MIN = 2;
const TERM_DF_MAX = 40;

let dirty = 0;
let built = -1;
let adjacency = new Map<string, Edge[]>();
let centrality = new Map<string, number>();

export function markGraphDirty() {
  dirty++;
}

function edgePairs(facts: FactNode[]): Map<string, Edge> {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const factTerms = new Map(facts.map((fact) => [fact.id, salientTerms(`${fact.title} ${fact.content}`)]));
  const edges = new Map<string, Edge>();

  const link = (a: string, b: string, kind: LinkKind, weight: number) => {
    if (a === b || weight < MIN_EDGE_WEIGHT || !byId.has(a) || !byId.has(b)) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const existing = edges.get(key);
    if (!existing || existing.weight < weight) edges.set(key, { id: key, weight, kind });
  };

  // Same topic: the strongest prior - facts filed together are related.
  const byTopic = new Map<string, FactNode[]>();
  for (const fact of facts) {
    if (!fact.topic_id) continue;
    byTopic.set(fact.topic_id, [...(byTopic.get(fact.topic_id) ?? []), fact]);
  }
  for (const group of byTopic.values()) {
    const members = group.slice(0, MAX_TOPIC_GROUP);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i].id;
        const b = members[j].id;
        const similarity = jaccard(factTerms.get(a)!, factTerms.get(b)!);
        link(a, b, "topic", 0.6 + similarity * 0.4);
      }
    }
  }

  // Shared salient vocabulary: catches related facts filed under different
  // topics (or under none at all).
  const inverted = new Map<string, string[]>();
  for (const [id, list] of factTerms) {
    for (const term of list) {
      const bucket = inverted.get(term) ?? [];
      if (bucket.length >= TERM_DF_MAX) continue;
      bucket.push(id);
      inverted.set(term, bucket);
    }
  }
  for (const bucket of inverted.values()) {
    if (bucket.length < TERM_DF_MIN) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = factTerms.get(bucket[i])!;
        const b = factTerms.get(bucket[j])!;
        const bSet = new Set(b);
        const shared = a.filter((term) => bSet.has(term)).length;
        // One distinctive shared term already means something; plain Jaccard
        // would score that near zero just because both texts are long.
        link(bucket[i], bucket[j], "term", Math.min(0.7, 0.2 + shared * 0.12 + jaccard(a, b) * 0.2));
      }
    }
  }

  // Facts from the same task usually describe one situation.
  const byTask = new Map<string, string[]>();
  for (const fact of facts) {
    if (!fact.source_task_id) continue;
    byTask.set(fact.source_task_id, [...(byTask.get(fact.source_task_id) ?? []), fact.id]);
  }
  for (const ids of byTask.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) link(ids[i], ids[j], "task", 0.35);
    }
  }

  return edges;
}

function build() {
  const db = getDb();
  const facts = db
    .prepare("SELECT id, topic_id, title, content, source_task_id FROM memories")
    .all() as FactNode[];
  const edges = edgePairs(facts);

  // Learned co-use edges: two facts that were retrieved together for a task
  // that then succeeded are related in practice, whatever their wording.
  const known = new Set(facts.map((fact) => fact.id));
  const coUse = db.prepare("SELECT from_id, to_id, weight FROM memory_co_use").all() as {
    from_id: string;
    to_id: string;
    weight: number;
  }[];
  for (const row of coUse) {
    if (!known.has(row.from_id) || !known.has(row.to_id)) continue;
    const key = row.from_id < row.to_id ? `${row.from_id}|${row.to_id}` : `${row.to_id}|${row.from_id}`;
    const existing = edges.get(key);
    if (!existing || existing.weight < row.weight) {
      edges.set(key, { id: key, weight: row.weight, kind: "co-use" });
    }
  }

  const adj = new Map<string, Edge[]>();
  for (const fact of facts) adj.set(fact.id, []);
  for (const edge of edges.values()) {
    const [a, b] = edge.id.split("|");
    adj.get(a)?.push({ id: b, weight: edge.weight, kind: edge.kind });
    adj.get(b)?.push({ id: a, weight: edge.weight, kind: edge.kind });
  }
  // Strongest relations first, then a degree cap so the graph stays sparse.
  for (const [id, list] of adj) {
    adj.set(
      id,
      list.sort((x, y) => y.weight - x.weight).slice(0, MAX_DEGREE)
    );
  }

  adjacency = adj;
  centrality = pagerank(adj);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO memory_links (from_id, to_id, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM memory_links").run();
    const t = now();
    for (const edge of edges.values()) {
      const [a, b] = edge.id.split("|");
      insert.run(a, b, edge.kind, edge.weight, t);
    }
  });
  tx();

  built = dirty;
}

/** Weighted PageRank: a fact is central when well-connected facts point at it. */
function pagerank(adj: Map<string, Edge[]>): Map<string, number> {
  const ids = [...adj.keys()];
  const rank = new Map(ids.map((id) => [id, 1 / Math.max(1, ids.length)]));
  if (ids.length === 0) return rank;

  const degree = new Map(ids.map((id) => [id, (adj.get(id) ?? []).reduce((sum, edge) => sum + edge.weight, 0)]));
  const damping = 0.85;

  for (let iteration = 0; iteration < 12; iteration++) {
    const next = new Map<string, number>();
    for (const id of ids) {
      let inflow = 0;
      for (const edge of adj.get(id) ?? []) {
        const total = degree.get(edge.id) ?? 0;
        if (total === 0) continue;
        inflow += ((rank.get(edge.id) ?? 0) * edge.weight) / total;
      }
      next.set(id, (1 - damping) / ids.length + damping * inflow);
    }
    for (const [id, value] of next) rank.set(id, value);
  }

  const max = Math.max(1e-9, ...rank.values());
  return new Map([...rank].map(([id, value]) => [id, value / max]));
}

function ready() {
  if (built !== dirty) build();
  return { adjacency, centrality };
}

/** Activation flowing one hop out of the lexical hits. */
export function spreadActivation(seeds: { id: string; score: number }[], decay = 0.45): Map<string, number> {
  const { adjacency } = ready();
  const spread = new Map<string, number>();
  for (const seed of seeds) {
    for (const edge of adjacency.get(seed.id) ?? []) {
      const activation = seed.score * edge.weight * decay;
      if (activation > (spread.get(edge.id) ?? 0)) spread.set(edge.id, activation);
    }
  }
  return spread;
}

/** 0..1, 1 = the most connected fact in the store. */
export function centralityOf(id: string): number {
  return ready().centrality.get(id) ?? 0;
}

export function neighboursOf(id: string): Edge[] {
  return ready().adjacency.get(id) ?? [];
}

/** Hebbian update: facts activated together for a successful task get closer.
 * w ← w + η(1 − w), so repeated co-use approaches 1 but never exceeds it. */
export function strengthenCoUse(ids: string[], eta = 0.15) {
  const unique = [...new Set(ids)].slice(0, 8);
  if (unique.length < 2) return;
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO memory_co_use (from_id, to_id, weight, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(from_id, to_id) DO UPDATE SET
       weight = MIN(1.0, memory_co_use.weight + ? * (1.0 - memory_co_use.weight)),
       updated_at = excluded.updated_at`
  );
  const tx = db.transaction(() => {
    const t = now();
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const [a, b] = unique[i] < unique[j] ? [unique[i], unique[j]] : [unique[j], unique[i]];
        upsert.run(a, b, eta, t, eta);
      }
    }
  });
  tx();
  markGraphDirty();
}

/** Association decay: co-use edges fade with a 90-day half-life-ish constant
 * and are dropped once they carry no information. */
export function decayCoUse(halfLifeDays = 90) {
  const db = getDb();
  const t = now();
  const rows = db.prepare("SELECT from_id, to_id, weight, updated_at FROM memory_co_use").all() as {
    from_id: string;
    to_id: string;
    weight: number;
    updated_at: number;
  }[];
  if (rows.length === 0) return 0;

  const update = db.prepare("UPDATE memory_co_use SET weight = ? WHERE from_id = ? AND to_id = ?");
  const remove = db.prepare("DELETE FROM memory_co_use WHERE from_id = ? AND to_id = ?");
  let changed = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const ageDays = Math.max(0, (t - row.updated_at) / 86400);
      const weight = row.weight * Math.pow(0.5, ageDays / halfLifeDays);
      if (weight < 0.05) {
        remove.run(row.from_id, row.to_id);
        changed++;
      } else if (weight < row.weight - 1e-6) {
        update.run(weight, row.from_id, row.to_id);
      }
    }
  });
  tx();
  if (changed > 0) markGraphDirty();
  return changed;
}

export function graphStats(): { nodes: number; edges: number } {
  const { adjacency } = ready();
  let edges = 0;
  for (const list of adjacency.values()) edges += list.length;
  return { nodes: adjacency.size, edges: edges / 2 };
}

/** Related facts for the UI: strongest neighbours with their titles. */
export function relatedMemories(id: string, limit = 4) {
  const db = getDb();
  const titleOf = db.prepare("SELECT title FROM memories WHERE id = ?");
  return neighboursOf(id)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      weight: Number(edge.weight.toFixed(2)),
      title: (titleOf.get(edge.id) as { title: string } | undefined)?.title ?? "deleted",
    }));
}
