/**
 * One typed, bi-temporal graph over everything this workspace knows.
 *
 * The previous design kept four parallel shapes - tasks/steps in their tables,
 * episodes in another, facts in a third with a topic tree, and a throwaway
 * `memory_links` table that was rebuilt from scratch - and every new question
 * ("which task produced this fact?", "what did we believe last Tuesday?") had
 * to be answered with a bespoke join. This module replaces that with a single
 * edge store: typed nodes (task, step, tool_call, event, episode, fact, topic,
 * document, community, summary) connected by typed relations, and every edge
 * carrying the four things a memory system needs at once:
 *
 *   - `valid_from` / `valid_to`: **valid time** - when the statement was true in
 *     the world. A superseded price keeps `valid_to` = the moment it stopped
 *     being true; nothing is overwritten, so "what did we believe on the 3rd?"
 *     is a range query rather than a lost answer.
 *   - `recorded_at` / `superseded_at`: **transaction time** - when this system
 *     learned, and when it stopped believing, the edge. Together with valid time
 *     that makes the store bi-temporal: you can separate "the world changed"
 *     from "we found out late".
 *   - `weight`: a decaying association strength. Structural edges (CONTAINS,
 *     PRODUCED, DERIVED_FROM, REFERENCES, SUPERSEDES, TRIGGERED) are facts about
 *     lineage and decay very slowly; RELATES_TO is a learned association and
 *     decays on a half-life, boosted Hebbian-style whenever it is used.
 *   - `provenance`: which mechanism or task asserted the edge, so a deletion can
 *     ask whether anything else still supports a fact before destroying it.
 *
 * Nodes are implicit - an id plus a type - because SQLite at this scale does not
 * need a node table to traverse; the edges are the graph. Rows are read into an
 * in-memory adjacency list that is rebuilt lazily after any write and used for
 * bounded personalised PageRank, centrality and provenance walks.
 */
import { getDb, now } from "./db";

export type NodeType =
  | "task"
  | "step"
  | "tool_call"
  | "agent"
  | "event"
  | "episode"
  | "fact"
  | "topic"
  | "document"
  | "community"
  | "summary";

export type Relation =
  | "CONTAINS"
  | "PRODUCED"
  | "REFERENCES"
  | "DERIVED_FROM"
  | "TRIGGERED"
  | "SUPERSEDES"
  | "RELATES_TO";

export interface NodeRef {
  type: NodeType;
  id: string;
}

export interface EdgeInput {
  from: NodeRef;
  relation: Relation;
  to: NodeRef;
  /** Association strength in 0..1. Structural edges default to 1. */
  weight?: number;
  /** Which mechanism asserted it, e.g. "derived:topic", "tool:remember", "task:abc". */
  provenance: string;
  /** Valid time start; defaults to now. */
  validFrom?: number;
}

export interface GraphEdge {
  id: string;
  from_type: NodeType;
  from_id: string;
  relation: Relation;
  to_type: NodeType;
  to_id: string;
  weight: number;
  provenance: string;
  recorded_at: number;
  valid_from: number;
  valid_to: number | null;
  superseded_at: number | null;
  superseded_by: string | null;
  last_reinforced_at: number;
  reinforcement: number;
}

/** Relations that describe lineage, not association: they do not fade. */
const STRUCTURAL = new Set<Relation>([
  "CONTAINS",
  "PRODUCED",
  "REFERENCES",
  "DERIVED_FROM",
  "TRIGGERED",
  "SUPERSEDES",
]);

/** Learned associations halve in strength over this window unless reinforced. */
const RELATION_HALF_LIFE_DAYS = 45;
const RELATION_DECAY = Math.LN2 / (RELATION_HALF_LIFE_DAYS * 86400);
/** Hebbian step for repeated assertions of the same association. */
const REINFORCE_ETA = 0.25;

export function nodeKey(ref: NodeRef): string {
  return `${ref.type}:${ref.id}`;
}

export function parseNodeKey(key: string): NodeRef {
  const split = key.indexOf(":");
  return { type: key.slice(0, split) as NodeType, id: key.slice(split + 1) };
}

function edgeId(from: NodeRef, relation: Relation, to: NodeRef): string {
  return `${relation}:${nodeKey(from)}>${nodeKey(to)}`;
}

/** Effective weight at a moment: structural edges are taken as stored, learned
 * associations are discounted by age since they were last reinforced. */
export function effectiveWeight(edge: GraphEdge, timestamp = now()): number {
  if (edge.valid_to !== null && edge.valid_to <= timestamp) return 0;
  if (STRUCTURAL.has(edge.relation)) return edge.weight;
  const ageSeconds = Math.max(0, timestamp - edge.last_reinforced_at);
  return edge.weight * Math.exp(-RELATION_DECAY * ageSeconds);
}

/* --------------------------------------------------------------- writes */

/** Upserts an edge. Re-asserting an existing association reinforces it
 * (w ← w + η(1 − w)) instead of creating a duplicate, and revives an edge that
 * had been invalidated, preserving the original `recorded_at`. */
export function addEdge(input: EdgeInput) {
  const id = edgeId(input.from, input.relation, input.to);
  const weight = Math.max(0, Math.min(1, input.weight ?? (STRUCTURAL.has(input.relation) ? 1 : 0.5)));
  const t = now();
  getDb()
    .prepare(
      `INSERT INTO graph_edges
         (id, from_type, from_id, relation, to_type, to_id, weight, provenance,
          recorded_at, valid_from, valid_to, superseded_at, superseded_by, last_reinforced_at, reinforcement)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         weight = MIN(1.0, graph_edges.weight + ? * (1.0 - graph_edges.weight)),
         provenance = CASE WHEN graph_edges.provenance LIKE 'derived:%' THEN excluded.provenance ELSE graph_edges.provenance END,
         last_reinforced_at = excluded.last_reinforced_at,
         reinforcement = graph_edges.reinforcement + 1,
         valid_to = NULL,
         superseded_at = NULL,
         superseded_by = NULL`
    )
    .run(
      id,
      input.from.type,
      input.from.id,
      input.relation,
      input.to.type,
      input.to.id,
      weight,
      input.provenance,
      t,
      input.validFrom ?? t,
      t,
      REINFORCE_ETA
    );
  markGraphDirty();
  return id;
}

/** Soft-invalidates an edge: valid time ends now, the row (and its history)
 * stays. Used for superseded beliefs and for retired derived associations. */
export function invalidateEdge(id: string, at = now()) {
  getDb()
    .prepare("UPDATE graph_edges SET valid_to = ?, superseded_at = ? WHERE id = ? AND valid_to IS NULL")
    .run(at, now(), id);
  markGraphDirty();
}

/** A superseding belief points back at the edge it replaced, so the chain of
 * "what we used to think" is walkable in both directions. */
export function supersedeEdge(oldId: string, newEdgeId: string) {
  const t = now();
  getDb()
    .prepare("UPDATE graph_edges SET valid_to = ?, superseded_at = ?, superseded_by = ? WHERE id = ? AND valid_to IS NULL")
    .run(t, t, newEdgeId, oldId);
  markGraphDirty();
}

/** Reinforces every edge along a used path (retrieval that led to a success). */
export function reinforceEdges(edgeIds: string[], eta = REINFORCE_ETA) {
  const unique = [...new Set(edgeIds)].slice(0, 200);
  if (unique.length === 0) return;
  const db = getDb();
  const statement = db.prepare(
    `UPDATE graph_edges SET weight = MIN(1.0, weight + ? * (1.0 - weight)),
       last_reinforced_at = ?, reinforcement = reinforcement + 1
     WHERE id = ? AND valid_to IS NULL`
  );
  const tx = db.transaction(() => {
    const t = now();
    for (const id of unique) statement.run(eta, t, id);
  });
  tx();
  markGraphDirty();
}

export function removeEdgesTouching(ref: NodeRef) {
  getDb()
    .prepare(
      "DELETE FROM graph_edges WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)"
    )
    .run(ref.type, ref.id, ref.type, ref.id);
  markGraphDirty();
}

/** Derived associations are fully replaceable; everything else is lineage and
 * must survive a rebuild. */
export function clearDerivedEdges() {
  getDb().prepare("DELETE FROM graph_edges WHERE provenance LIKE 'derived:%'").run();
  markGraphDirty();
}

/* ---------------------------------------------------------------- reads */

interface Adjacency {
  /** node key → [{ edge, other: neighbour key }] */
  out: Map<string, { edge: GraphEdge; other: string }[]>;
  edges: GraphEdge[];
}

let dirty = 0;
let builtAt = -1;
let adjacency: Adjacency = { out: new Map(), edges: [] };
let defaultEdges: GraphEdge[] | null = null;
let defaultEdgesAt = -1;

export function markGraphDirty() {
  dirty++;
}

function loadEdges(includeInvalidated: boolean): GraphEdge[] {
  const where = includeInvalidated ? "" : "WHERE valid_to IS NULL";
  return getDb()
    .prepare(
      `SELECT id, from_type, from_id, relation, to_type, to_id, weight, provenance,
              recorded_at, valid_from, valid_to, superseded_at, superseded_by,
              last_reinforced_at, reinforcement
       FROM graph_edges ${where}`
    )
    .all() as GraphEdge[];
}

function ready(): Adjacency {
  if (builtAt === dirty) return adjacency;
  const edges = loadEdges(false);
  const out = new Map<string, { edge: GraphEdge; other: string }[]>();
  const link = (key: string, entry: { edge: GraphEdge; other: string }) => {
    const list = out.get(key);
    if (list) list.push(entry);
    else out.set(key, [entry]);
  };
  for (const edge of edges) {
    const from = `${edge.from_type}:${edge.from_id}`;
    const to = `${edge.to_type}:${edge.to_id}`;
    link(from, { edge, other: to });
    link(to, { edge, other: from });
  }
  adjacency = { out, edges };
  builtAt = dirty;
  return adjacency;
}

/** Edges touching one node, effective weight discounted to now. Superseded
 * history is excluded unless asked for. */
export function edgesOf(ref: NodeRef, options: { includeInvalidated?: boolean } = {}) {
  const timestamp = now();
  const rows = options.includeInvalidated
    ? (getDb()
        .prepare(
          `SELECT * FROM graph_edges WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)`
        )
        .all(ref.type, ref.id, ref.type, ref.id) as GraphEdge[])
    : (edgesOfKey(nodeKey(ref)) ?? []);
  return rows.map((edge) => ({ edge, weight: effectiveWeight(edge, timestamp) }));
}

function edgesOfKey(key: string): GraphEdge[] {
  return (ready().out.get(key) ?? []).map((entry) => entry.edge);
}

/* ------------------------------------------------- personalisation / walks */

const HOP_ATTENUATION = 0.55;
const RESTART = 0.35;

/**
 * Bounded personalised PageRank from a handful of seed nodes.
 *
 * Flat top-k retrieval can only return things that already look like the query.
 * This walks the graph instead: the personalisation vector restarts at the
 * seeds, so relevance flows outward along typed edges, and the walk is bounded
 * to `maxHops` neighbourhood plus a per-hop attenuation so a hub three hops away
 * cannot outrank a direct match. That is the "search → graph-expand → rerank"
 * pattern that beat flat RAG in Zep's published Graphiti results.
 */
export function personalizedPageRank(
  seeds: { key: string; weight: number }[],
  options: { maxHops?: number; iterations?: number; restart?: number; hops?: Map<string, number> } = {}
): Map<string, number> {
  const maxHops = options.maxHops ?? 2;
  const iterations = options.iterations ?? 18;
  const restart = options.restart ?? RESTART;
  const { out } = ready();
  if (seeds.length === 0) return new Map();

  // 1. Bounded neighbourhood (BFS), so the walk stays local and cheap.
  const hops = options.hops ? new Map(options.hops) : new Map<string, number>();
  if (hops.size === 0) {
    const frontier: string[] = [];
    for (const seed of seeds) {
      hops.set(seed.key, 0);
      frontier.push(seed.key);
    }
    for (let depth = 0; depth < maxHops; depth++) {
      const next: string[] = [];
      for (const key of frontier) {
        for (const entry of out.get(key) ?? []) {
          if (hops.has(entry.other)) continue;
          hops.set(entry.other, depth + 1);
          next.push(entry.other);
        }
      }
      frontier.length = 0;
      frontier.push(...next);
    }
  }

  // 2. Personalisation mass on the seeds, spread by their own retrieval score.
  const totalSeed = seeds.reduce((sum, seed) => sum + Math.max(1e-6, seed.weight), 0);
  const personal = new Map<string, number>();
  for (const seed of seeds) {
    if (!hops.has(seed.key)) continue;
    personal.set(seed.key, (personal.get(seed.key) ?? 0) + Math.max(1e-6, seed.weight) / totalSeed);
  }
  if (personal.size === 0) return new Map();

  // 3. Power iteration over the bounded subgraph, with mass that would leave the
  // neighbourhood returning to the seeds (a proper restart distribution).
  let rank = new Map(personal);
  const timestamp = now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const [key, mass] of rank) {
      if (mass <= 0) continue;
      const neighbours = (out.get(key) ?? []).filter((entry) => hops.has(entry.other));
      const total = neighbours.reduce((sum, entry) => sum + effectiveWeight(entry.edge, timestamp), 0);
      if (total <= 0) {
        dangling += mass;
        continue;
      }
      for (const entry of neighbours) {
        const share = mass * (effectiveWeight(entry.edge, timestamp) / total);
        next.set(entry.other, (next.get(entry.other) ?? 0) + share);
      }
    }
    for (const [key, mass] of personal) next.set(key, (next.get(key) ?? 0) + (restart + (1 - restart) * dangling) * mass);
    rank = next;
    // Renormalise so each iteration is a probability distribution.
    const sum = [...rank.values()].reduce((a, b) => a + b, 0) || 1;
    for (const [key, mass] of rank) rank.set(key, mass / sum);
  }

  // 4. Attenuate by hop distance: proximity is evidence, association is a hint.
  const scored = new Map<string, number>();
  for (const [key, mass] of rank) {
    const hop = hops.get(key) ?? maxHops + 1;
    const value = mass * Math.pow(HOP_ATTENUATION, hop);
    if (value > 0) scored.set(key, value);
  }
  return scored;
}

/** Convenience: PPR filtered to fact nodes, best first. */
export function expandFromKeys(seedKeys: string[], limit = 40, maxHops = 2): { id: string; score: number }[] {
  const seeds = seedKeys.map((key) => ({ key, weight: 1 }));
  const ranked = personalizedPageRank(seeds, { maxHops });
  return [...ranked.entries()]
    .filter(([key]) => key.startsWith("fact:"))
    .map(([key, score]) => ({ id: key.slice(5), score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Provenance sources of a fact: the tasks/events/agents that asserted it,
 * walking DERIVED_FROM/PRODUCED/CONTAINS backwards. Used by the deletion rules:
 * a fact that several sources independently support must not be destroyed
 * because one source is removed.
 */
export function provenanceSources(ref: NodeRef, maxDepth = 8): NodeRef[] {
  const { out } = ready();
  const seen = new Set<string>([nodeKey(ref)]);
  const sources = new Map<string, NodeRef>();
  let frontier = [nodeKey(ref)];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const entry of out.get(key) ?? []) {
        const { relation } = entry.edge;
        if (relation !== "DERIVED_FROM" && relation !== "PRODUCED" && relation !== "CONTAINS") continue;
        if (seen.has(entry.other)) continue;
        seen.add(entry.other);
        next.push(entry.other);
        const parsed = parseNodeKey(entry.other);
        if (parsed.type === "task" || parsed.type === "event" || parsed.type === "agent" || parsed.type === "document") {
          sources.set(entry.other, parsed);
        }
      }
    }
    frontier = next;
  }
  return [...sources.values()];
}

/** True when some source other than `excluding` still asserts the fact. */
export function hasOtherProvenance(ref: NodeRef, excluding: NodeRef[]): boolean {
  const excluded = new Set(excluding.map(nodeKey));
  return provenanceSources(ref).some((source) => !excluded.has(nodeKey(source)));
}

/* ------------------------------------------------------------ statistics */

export function graphOverview() {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) AS n FROM graph_edges").get() as { n: number }).n;
  const live = (db.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE valid_to IS NULL").get() as { n: number }).n;
  const byRelation = db
    .prepare("SELECT relation, COUNT(*) AS n FROM graph_edges WHERE valid_to IS NULL GROUP BY relation ORDER BY n DESC")
    .all() as { relation: Relation; n: number }[];
  const nodes = new Set<string>();
  for (const [key, list] of ready().out) if (list.length > 0) nodes.add(key);
  return {
    nodes: nodes.size,
    edges: live,
    invalidated: total - live,
    relations: byRelation,
  };
}

/** Most central live nodes overall (weighted PageRank) - used for diagnostics
 * and for picking community representatives. */
export function centralityScores(kinds?: NodeType[]): Map<string, number> {
  const { out } = ready();
  const allowed = kinds ? new Set(kinds) : null;
  const rank = new Map<string, number>();
  const ids = [...out.keys()].filter((key) => !allowed || allowed.has(parseNodeKey(key).type));
  if (ids.length === 0) return rank;
  const timestamp = now();
  for (const id of ids) rank.set(id, 1 / ids.length);
  const damping = 0.85;
  for (let iteration = 0; iteration < 14; iteration++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const id of ids) {
      const mass = rank.get(id) ?? 0;
      const neighbours = (out.get(id) ?? []).filter((entry) => !allowed || allowed.has(parseNodeKey(entry.other).type));
      const total = neighbours.reduce((sum, entry) => sum + effectiveWeight(entry.edge, timestamp), 0);
      if (total <= 0) {
        dangling += mass;
        continue;
      }
      for (const entry of neighbours) {
        const share = mass * (effectiveWeight(entry.edge, timestamp) / total);
        next.set(entry.other, (next.get(entry.other) ?? 0) + share);
      }
    }
    const base = (damping * dangling + (1 - damping)) / ids.length;
    for (const id of ids) next.set(id, (next.get(id) ?? 0) + base);
    for (const [id, value] of next) rank.set(id, value);
  }
  const max = Math.max(1e-9, ...rank.values());
  return new Map([...rank].map(([id, value]) => [id, value / max]));
}

/** Every live edge as a plain list - the ingestion and coverage checks use it. */
export function liveEdges(): GraphEdge[] {
  if (defaultEdges && defaultEdgesAt === dirty) return defaultEdges;
  defaultEdges = loadEdges(false);
  defaultEdgesAt = dirty;
  return defaultEdges;
}
