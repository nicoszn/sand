/**
 * Community structure over the fact graph - the archive tier.
 *
 * Facts accumulate into clusters whether or not anyone labels them: prices sit
 * with prices, deployment notes with deployment notes. Louvain modularity
 * optimisation finds those clusters from the edge weights alone, and two levels
 * of it give a coarse-to-fine hierarchy: level 1 is a handful of broad themes,
 * level 0 the fine clusters underneath them, each with a generated label and
 * summary.
 *
 * Retrieval uses them the way the archive tier is supposed to be used - scan a
 * few dozen summaries first, then drill into the winning cluster's members -
 * instead of always scoring every fact. Deletion uses them too: the UI groups
 * by cluster, and retention gives extra weight to facts that hold a cluster
 * together.
 *
 * The implementation is a plain single-threaded Louvain (local moving +
 * aggregation), which is honest at this scale: a few hundred nodes and a
 * couple of thousand edges is a few milliseconds, and it avoids the graphology
 * dependency (and its build weight) for one algorithm.
 */
import { createHash } from "node:crypto";
import { getDb, now } from "./db";
import { liveEdges } from "./graph";
import { ensureFactGraph } from "./memoryGraph";
import { terms } from "./text";

export interface Community {
  id: string;
  level: number;
  parent_id: string | null;
  label: string;
  summary: string;
  member_count: number;
  cohesion: number;
  created_at: number;
  updated_at: number;
}

/** Undirected weighted adjacency: node → neighbour → weight. */
type WeightedGraph = Map<string, Map<string, number>>;

/** A community with fewer members than this is folded into its parent theme
 * rather than surfaced as its own cluster. */
const MIN_CLUSTER = 2;
const LEVELS = 2;

function factGraph(): WeightedGraph {
  const graph: WeightedGraph = new Map();
  const ensure = (id: string) => {
    const existing = graph.get(id);
    if (existing) return existing;
    const fresh = new Map<string, number>();
    graph.set(id, fresh);
    return fresh;
  };
  for (const edge of liveEdges()) {
    if (edge.relation !== "RELATES_TO") continue;
    if (!(edge.from_type === "fact" && edge.to_type === "fact")) continue;
    const weight = Math.max(0.01, edge.weight);
    const from = ensure(edge.from_id);
    const to = ensure(edge.to_id);
    from.set(edge.to_id, (from.get(edge.to_id) ?? 0) + weight);
    to.set(edge.from_id, (to.get(edge.from_id) ?? 0) + weight);
  }
  return graph;
}

function degree(graph: WeightedGraph, id: string): number {
  return [...(graph.get(id) ?? new Map<string, number>()).values()].reduce((a, b) => a + b, 0);
}

function totalWeight(graph: WeightedGraph): number {
  let total = 0;
  for (const [, neighbours] of graph) for (const w of neighbours.values()) total += w;
  return total / 2;
}

interface Partition {
  assignment: Map<string, string>;
  modularity: number;
  communities: number;
}

/**
 * Louvain local moving on one level of the graph.
 *
 * Each node starts in its own community and repeatedly moves to the neighbouring
 * community that maximises modularity gain:
 *
 *   ΔQ = k_i,in / m − resolution · (Σ_tot · k_i) / (2 m²)
 *
 * until no move improves it. `resolution` above 1 yields more, smaller clusters.
 */
function localMoving(graph: WeightedGraph): Partition {
  const nodes = [...graph.keys()];
  const assignment = new Map<string, string>(nodes.map((id) => [id, id]));
  const communityTotal = new Map<string, number>(nodes.map((id) => [id, degree(graph, id)]));
  const nodeDegree = new Map<string, number>(nodes.map((id) => [id, degree(graph, id)]));
  const m = totalWeight(graph) || 1;
  const resolution = 1;
  let improved = true;
  let passes = 0;

  while (improved && passes < 12) {
    improved = false;
    passes++;
    for (const node of nodes) {
      const neighbours = graph.get(node) ?? new Map<string, number>();
      const k = nodeDegree.get(node) ?? 0;
      const current = assignment.get(node)!;

      // Weight from this node into each candidate community.
      const into = new Map<string, number>();
      for (const [other, weight] of neighbours) {
        const community = assignment.get(other)!;
        into.set(community, (into.get(community) ?? 0) + weight);
      }

      const removalPenalty = (resolution * k * (communityTotal.get(current) ?? 0)) / (2 * m);
      let bestGain = (into.get(current) ?? 0) / m - removalPenalty;
      let best = current;
      for (const [community, weight] of into) {
        if (community === current) continue;
        const gain = weight / m - (resolution * k * (communityTotal.get(community) ?? 0)) / (2 * m);
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = community;
        }
      }

      if (best !== current) {
        communityTotal.set(current, (communityTotal.get(current) ?? 0) - k);
        communityTotal.set(best, (communityTotal.get(best) ?? 0) + k);
        assignment.set(node, best);
        improved = true;
      }
    }
  }

  // Report modularity so callers can tell a meaningful partition from noise.
  let modularity = 0;
  const communityDegree = new Map<string, number>();
  for (const [node, community] of assignment) {
    communityDegree.set(community, (communityDegree.get(community) ?? 0) + (nodeDegree.get(node) ?? 0));
  }
  for (const [node, community] of assignment) {
    for (const [other, weight] of graph.get(node) ?? new Map<string, number>()) {
      if (assignment.get(other) !== community) continue;
      const expected = ((nodeDegree.get(node) ?? 0) * (nodeDegree.get(other) ?? 0)) / (2 * m);
      modularity += weight / (2 * m) - expected / (2 * m);
    }
  }

  return { assignment, modularity, communities: new Set(assignment.values()).size };
}

/** Collapses each community into a single node for the next Louvain level. */
function aggregate(graph: WeightedGraph, assignment: Map<string, string>): WeightedGraph {
  const next: WeightedGraph = new Map();
  const ensure = (id: string) => {
    const existing = next.get(id);
    if (existing) return existing;
    const fresh = new Map<string, number>();
    next.set(id, fresh);
    return fresh;
  };
  for (const [node, neighbours] of graph) {
    const a = assignment.get(node)!;
    ensure(a);
    for (const [other, weight] of neighbours) {
      const b = assignment.get(other)!;
      const row = ensure(b);
      row.set(a, (row.get(a) ?? 0) + weight / 2);
    }
  }
  return next;
}

/** Runs Louvain level by level, finest first. Every level is projected back
 * onto fact ids so the caller can persist both levels without knowing about
 * aggregation. */
function hierarchy(graph: WeightedGraph): Map<string, string>[] {
  const levels: Map<string, string>[] = [];
  let current = graph;
  // Aggregated node id → the fact ids it stands for at this level.
  let memberSets = new Map<string, string[]>([...graph.keys()].map((id) => [id, [id]]));

  for (let level = 0; level < LEVELS; level++) {
    const partition = localMoving(current);
    const byCluster = new Map<string, string[]>();
    for (const [node, community] of partition.assignment) {
      const key = `${level}:${community}`;
      byCluster.set(key, [...(byCluster.get(key) ?? []), ...(memberSets.get(node) ?? [node])]);
    }
    const assignment = new Map<string, string>();
    for (const [key, facts] of byCluster) for (const fact of facts) assignment.set(fact, key);
    levels.push(assignment);

    if (partition.communities === current.size) break;
    // Aggregate and carry the fact membership of each new super-node forward.
    const nextMembers = new Map<string, string[]>();
    for (const [node, community] of partition.assignment) {
      nextMembers.set(community, [...(nextMembers.get(community) ?? []), ...(memberSets.get(node) ?? [node])]);
    }
    current = aggregate(current, partition.assignment);
    memberSets = nextMembers;
  }
  return levels;
}

function stableId(level: number, memberIds: string[]): string {
  const hash = createHash("sha1").update([...memberIds].sort().join("|")).digest("hex").slice(0, 10);
  return `c${level}_${hash}`;
}

/** Groups the current partition into member lists, dropping singleton clusters
 * (they carry no theme, so they belong to the archive at large). */
function clusters(assignment: Map<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [node, community] of assignment) {
    const list = groups.get(community);
    if (list) list.push(node);
    else groups.set(community, [node]);
  }
  for (const [key, members] of groups) {
    if (members.length < MIN_CLUSTER) groups.delete(key);
  }
  return groups;
}

function describe(
  members: string[],
  degree: Map<string, number>
): { label: string; summary: string } {
  const db = getDb();
  const placeholders = members.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, title, content FROM memories WHERE id IN (${placeholders})`)
    .all(...members) as { id: string; title: string; content: string }[];
  if (rows.length === 0) return { label: "unsorted", summary: "no members" };

  // Name a cluster after its most connected members: an arbitrary first row
  // would label a bitcoin cluster after whatever fact happened to sort first.
  const label = rows
    .slice()
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, 2)
    .map((row) => row.title.trim().slice(0, 60))
    .join(" · ")
    .slice(0, 72);

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const term of terms(`${row.title} ${row.content}`)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const keywords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([term]) => term);
  return {
    label: label || "unsorted",
    summary: `${rows.length} fact${rows.length === 1 ? "" : "s"} about ${keywords.join(", ") || "this workspace"}`,
  };
}

/**
 * Recomputes both levels and writes them back. Level 1 (coarse) is stored as
 * the parent of each level-0 cluster, and each fact's `community_id` points at
 * its fine cluster. Communities are derived state: the whole set is replaced,
 * so a stale cluster never lingers.
 */
export function recomputeCommunities(): { level0: number; level1: number } {
  // Derived relations are built lazily; cluster the current graph, not the one
  // that existed before the last write.
  ensureFactGraph();
  const graph = factGraph();
  if (graph.size === 0) {
    clearCommunities();
    return { level0: 0, level1: 0 };
  }

  const levels = hierarchy(graph);
  const db = getDb();
  // Weighted degree per fact, used only to pick representative titles.
  const degree = new Map<string, number>();
  for (const [node, neighbours] of graph) {
    let total = 0;
    for (const weight of neighbours.values()) total += weight;
    degree.set(node, total);
  }
  const t = now();
  const nowIds = { l0: new Map<string, string>(), l1: new Map<string, string>() };
  const rows: Community[] = [];
  const memberships: { communityId: string; memoryId: string; level: number; weight: number }[] = [];

  const persist = (assignment: Map<string, string>, level: number) => {
    const groups = clusters(assignment);
    const idByCluster = new Map<string, string>();
    for (const [cluster, members] of groups) {
      const id = stableId(level, members);
      idByCluster.set(cluster, id);
      const { label, summary } = describe(members, degree);
      rows.push({
        id,
        level,
        parent_id: null,
        label,
        summary,
        member_count: members.length,
        cohesion: 0,
        created_at: t,
        updated_at: t,
      });
      for (const memberId of members) {
        memberships.push({ communityId: id, memoryId: memberId, level, weight: 1 });
        (level === 0 ? nowIds.l0 : nowIds.l1).set(memberId, id);
      }
    }
    return { idByCluster, groups };
  };

  const level0 = levels[0] ? persist(levels[0], 0) : null;
  const level1 = levels[1] ? persist(levels[1], 1) : null;

  // Cohesion: share of a cluster's edge weight that stays inside it.
  const weights = new Map<string, number>();
  for (const [node, neighbours] of graph) {
    const community = nowIds.l0.get(node);
    if (!community) continue;
    for (const [other, weight] of neighbours) {
      const otherCommunity = nowIds.l0.get(other);
      const bucket = weights.get(`${community}|${otherCommunity ?? "-"}`) ?? 0;
      weights.set(`${community}|${otherCommunity ?? "-"}`, bucket + weight);
    }
  }
  for (const row of rows) {
    let inside = 0;
    let total = 0;
    for (const [key, weight] of weights) {
      const [a, b] = key.split("|");
      if (a !== row.id && b !== row.id) continue;
      total += weight;
      if (a === b) inside += weight;
    }
    row.cohesion = total > 0 ? Number((inside / total).toFixed(3)) : 0;
  }

  // Parent a fine cluster under the coarse cluster that holds most of it.
  if (level0 && level1) {
    const parentVotes = new Map<string, Map<string, number>>();
    for (const membership of memberships.filter((m) => m.level === 0)) {
      const coarse = nowIds.l1.get(membership.memoryId);
      if (!coarse) continue;
      const votes = parentVotes.get(membership.communityId) ?? new Map<string, number>();
      votes.set(coarse, (votes.get(coarse) ?? 0) + 1);
      parentVotes.set(membership.communityId, votes);
    }
    for (const row of rows) {
      if (row.level !== 0) continue;
      const votes = parentVotes.get(row.id);
      if (!votes) continue;
      row.parent_id = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM memory_community_members").run();
    db.prepare("DELETE FROM memory_communities").run();
    const insertCommunity = db.prepare(
      `INSERT INTO memory_communities (id, level, parent_id, label, summary, member_count, cohesion, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insertCommunity.run(
        row.id,
        row.level,
        row.parent_id,
        row.label,
        row.summary,
        row.member_count,
        row.cohesion,
        row.created_at,
        row.updated_at
      );
    }
    const insertMember = db.prepare(
      "INSERT OR REPLACE INTO memory_community_members (community_id, memory_id, level, weight) VALUES (?, ?, ?, ?)"
    );
    for (const membership of memberships) {
      insertMember.run(membership.communityId, membership.memoryId, membership.level, membership.weight);
    }
    const clearCommunity = db.prepare("UPDATE memories SET community_id = NULL");
    clearCommunity.run();
    const setCommunity = db.prepare("UPDATE memories SET community_id = ? WHERE id = ?");
    for (const [memoryId, communityId] of nowIds.l0) setCommunity.run(communityId, memoryId);
  });
  tx();

  return {
    level0: rows.filter((row) => row.level === 0).length,
    level1: rows.filter((row) => row.level === 1).length,
  };
}

export function clearCommunities() {
  const db = getDb();
  db.prepare("DELETE FROM memory_community_members").run();
  db.prepare("DELETE FROM memory_communities").run();
  db.prepare("UPDATE memories SET community_id = NULL").run();
}

export function listCommunities(level?: number): Community[] {
  const db = getDb();
  return (level === undefined
    ? db.prepare("SELECT * FROM memory_communities ORDER BY level ASC, member_count DESC").all()
    : db.prepare("SELECT * FROM memory_communities WHERE level = ? ORDER BY member_count DESC").all(level)) as Community[];
}

export function communityStats() {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) AS total, COALESCE(MAX(level), 0) AS levels FROM memory_communities")
    .get() as { total: number; levels: number };
  return { total: row.total, levels: row.total > 0 ? row.levels + 1 : 0 };
}

/**
 * Coarse-to-fine retrieval: score the cluster summaries, not the facts, then let
 * the caller pull members out of the winners. A cluster matches on its label and
 * its keywords, so "what do we know about deployment" reaches a deployment
 * cluster even when no single fact repeats the word.
 */
export function searchCommunities(query: string, limit = 3): (Community & { score: number })[] {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return [];
  const db = getDb();
  const all = db.prepare("SELECT * FROM memory_communities ORDER BY level ASC").all() as Community[];
  if (all.length === 0) return [];
  // Coarse first, literally: when a hierarchy exists, score only its top level.
  const topLevel = Math.max(...all.map((community) => community.level));
  const communities = all.filter((community) => community.level === topLevel);

  // Document frequency over labels+summaries, so a term every cluster contains
  // ("fact", "workspace") contributes little.
  const tokenised = communities.map((community) => ({
    community,
    tokens: new Set(terms(`${community.label} ${community.summary}`)),
  }));
  const df = new Map<string, number>();
  for (const entry of tokenised) {
    for (const term of entry.tokens) df.set(term, (df.get(term) ?? 0) + 1);
  }

  return tokenised
    .map(({ community, tokens }) => {
      let score = 0;
      for (const term of queryTerms) {
        if (!tokens.has(term)) continue;
        score += Math.log(1 + communities.length / Math.max(1, df.get(term) ?? 1));
      }
      const normalised = queryTerms.length > 0 ? score / Math.sqrt(queryTerms.length) : 0;
      return {
        ...community,
        // Cohesion is a small prior: a tight cluster is a more meaningful theme.
        score: normalised + community.cohesion * 0.15 + Math.min(0.1, community.member_count / 100),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function membersOf(communityId: string, limit = 200): string[] {
  return (
    getDb()
      .prepare("SELECT memory_id FROM memory_community_members WHERE community_id = ? LIMIT ?")
      .all(communityId, limit) as { memory_id: string }[]
  ).map((row) => row.memory_id);
}

export function communitiesOf(memoryId: string): { fine: Community | null; coarse: Community | null } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.* FROM memory_community_members m
       JOIN memory_communities c ON c.id = m.community_id
       WHERE m.memory_id = ? ORDER BY m.level ASC`
    )
    .all(memoryId) as Community[];
  return { fine: rows[0] ?? null, coarse: rows[rows.length - 1] ?? null };
}
