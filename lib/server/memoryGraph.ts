/**
 * The fact layer of the typed graph: derived relations, centrality and
 * retrieval by association.
 *
 * Edges are derived, not hand-maintained: two facts are linked when they share a
 * topic, share salient vocabulary, came out of the same task, or were retrieved
 * together for a task that then succeeded. Derived edges carry
 * `provenance = "derived:…"` so a rebuild can replace them wholesale while
 * lineage edges (task CONTAINS step, fact DERIVED_FROM task) survive untouched.
 * Learned co-use edges are written into the same graph as ordinary RELATES_TO
 * edges, which means they decay on the same half-life and are reinforced by the
 * same rule instead of needing their own table and sweep.
 *
 * Retrieval walks this graph with bounded personalised PageRank (`graph.ts`)
 * rather than one hop of spreading activation: two hops reach the fact that is
 * linked to something linked to the query, which is exactly the multi-hop case
 * flat vector search misses - while the hop attenuation keeps a hub three steps
 * away from outranking a direct match.
 */
import { getDb, now } from "./db";
import { jaccard, salientTerms } from "./text";
import {
  addEdge,
  centralityScores,
  clearDerivedEdges,
  edgesOf,
  expandFromKeys,
  graphOverview,
  personalizedPageRank,
} from "./graph";

export type LinkKind = "topic" | "term" | "task" | "co-use";


interface FactNode {
  id: string;
  topic_id: string | null;
  title: string;
  content: string;
  source_task_id: string | null;
}

/** A fact only needs its strongest few relations; keeping every pair turns a
 * small store into a dense graph where everything relates to everything. */
const MAX_DEGREE = 8;
const MIN_EDGE_WEIGHT = 0.25;
const MAX_TOPIC_GROUP = 60;
const TERM_DF_MIN = 2;
const TERM_DF_MAX = 40;

let version = 0;
let built = -1;

/** Call after any fact write: the next read rebuilds derived relations. */
export function markGraphDirty() {
  version++;
}

/** Rebuilds the derived fact relations and centrality cache. Called lazily by
 * `ensureGraph` (on any read) after a memory write has marked it dirty. */
function buildDerivedEdges() {
  const db = getDb();
  const facts = db
    .prepare("SELECT id, topic_id, title, content, source_task_id FROM memories WHERE status = 'active'")
    .all() as FactNode[];

  clearDerivedEdges();

  const factTerms = new Map(facts.map((fact) => [fact.id, salientTerms(`${fact.title} ${fact.content}`)]));
  const seen = new Map<string, number>();

  const link = (a: FactNode, b: FactNode, kind: LinkKind, weight: number) => {
    if (a.id === b.id || weight < MIN_EDGE_WEIGHT) return;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const previous = seen.get(key) ?? 0;
    if (weight <= previous) return;
    seen.set(key, weight);
    addEdge({
      from: { type: "fact", id: a.id },
      relation: "RELATES_TO",
      to: { type: "fact", id: b.id },
      weight: Math.min(1, weight),
      provenance: `derived:${kind}`,
    });
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
        const similarity = jaccard(factTerms.get(members[i].id)!, factTerms.get(members[j].id)!);
        link(members[i], members[j], "topic", 0.6 + similarity * 0.4);
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
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
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
        link(
          byId.get(bucket[i])!,
          byId.get(bucket[j])!,
          "term",
          Math.min(0.7, 0.2 + shared * 0.12 + jaccard(a, b) * 0.2)
        );
      }
    }
  }

  // Facts from the same task usually describe one situation.
  const byTask = new Map<string, FactNode[]>();
  for (const fact of facts) {
    if (!fact.source_task_id) continue;
    byTask.set(fact.source_task_id, [...(byTask.get(fact.source_task_id) ?? []), fact]);
  }
  for (const group of byTask.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) link(group[i], group[j], "task", 0.35);
    }
  }

  // Keep only each fact's strongest few relations, so a dense neighbourhood
  // cannot drown out the specific link that matters. Retired edges keep their
  // rows (valid_to set) rather than disappearing. Read straight from SQL: going
  // through the cached adjacency here would invalidate and rebuild it once per
  // fact, turning a linear build into a quadratic one.
  const live = db
    .prepare(
      `SELECT id, from_id, to_id, weight FROM graph_edges
       WHERE relation = 'RELATES_TO' AND provenance LIKE 'derived:%' AND valid_to IS NULL`
    )
    .all() as { id: string; from_id: string; to_id: string; weight: number }[];
  const perFact = new Map<string, { id: string; weight: number }[]>();
  for (const edge of live) {
    for (const id of [edge.from_id, edge.to_id]) {
      const list = perFact.get(id) ?? [];
      list.push({ id: edge.id, weight: edge.weight });
      perFact.set(id, list);
    }
  }
  const retire = db.prepare(
    "UPDATE graph_edges SET valid_to = ?, superseded_at = ? WHERE id = ? AND valid_to IS NULL"
  );
  const t = now();
  for (const list of perFact.values()) {
    for (const entry of list.sort((a, b) => b.weight - a.weight).slice(MAX_DEGREE)) retire.run(t, t, entry.id);
  }

  built = version;
}

/** Ensures derived edges reflect the current facts before any read. Exported
 * for community detection, which reads the edge store directly and would
 * otherwise cluster yesterday's graph on the first call after a write. */
export function ensureFactGraph() {
  if (built !== version) buildDerivedEdges();
}

const ensureGraph = ensureFactGraph;

/* ------------------------------------------------------------- retrieval */

/** Multi-hop relevance flow from the lexical/vector seeds, (fact id, score). */
export function spreadActivation(seeds: { id: string; score: number }[], _decay = 0.45): Map<string, number> {
  ensureGraph();
  if (seeds.length === 0) return new Map();
  const ranked = personalizedPageRank(
    seeds.map((seed) => ({ key: `fact:${seed.id}`, weight: seed.score })),
    { maxHops: 2 }
  );
  const out = new Map<string, number>();
  for (const [key, score] of ranked) {
    if (key.startsWith("fact:")) out.set(key.slice(5), score);
  }
  return out;
}

/** 0..1, 1 = the most central fact in the store. */
export function centralityOf(id: string): number {
  ensureGraph();
  return centralityScores(["fact"]).get(`fact:${id}`) ?? 0;
}

export function neighboursOf(id: string): { id: string; weight: number; kind: string }[] {
  ensureGraph();
  return edgesOf({ type: "fact", id })
    .filter((entry) => entry.weight > 0)
    .map((entry) => ({
      id: entry.edge.from_id === id ? entry.edge.to_id : entry.edge.from_id,
      weight: entry.weight,
      kind: entry.edge.provenance.replace("derived:", "").replace("co-use", "co-use"),
    }))
    .sort((a, b) => b.weight - a.weight);
}

/** Hebbian update: facts activated together for a successful task get closer.
 * addEdge's upsert is the same rule, w ← w + η(1 − w), applied to the edge. */
export function strengthenCoUse(ids: string[], eta = 0.15) {
  const unique = [...new Set(ids)].slice(0, 8);
  if (unique.length < 2) return;
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      addEdge({
        from: { type: "fact", id: unique[i] },
        relation: "RELATES_TO",
        to: { type: "fact", id: unique[j] },
        weight: eta,
        provenance: "co-use",
      });
    }
  }
}

export function graphStats(): { nodes: number; edges: number; invalidated: number; relations: { relation: string; n: number }[] } {
  ensureGraph();
  const overview = graphOverview();
  return {
    nodes: overview.nodes,
    edges: overview.edges,
    invalidated: overview.invalidated,
    relations: overview.relations.map((row) => ({ relation: row.relation, n: row.n })),
  };
}

/** Related facts for the UI and for the `recall` tool. */
export function relatedMemories(id: string, limit = 4) {
  const db = getDb();
  const titleOf = db.prepare("SELECT title FROM memories WHERE id = ?");
  return neighboursOf(id)
    .slice(0, limit)
    .map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      weight: Number(edge.weight.toFixed(2)),
      title: (titleOf.get(edge.id) as { title: string } | undefined)?.title ?? "deleted",
    }));
}

/** Broadens a fact search: facts reachable from the given seeds, best first. */
export function expandFacts(seedIds: string[], limit = 40, maxHops = 2): { id: string; score: number }[] {
  ensureGraph();
  return expandFromKeys(
    seedIds.map((id) => `fact:${id}`),
    limit,
    maxHops
  );
}
