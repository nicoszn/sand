/**
 * Full-text index over workspace memory.
 *
 * Chosen engine: MiniSearch. It has zero dependencies and a few KB of code,
 * scores with real BM25 plus per-field boosts (so a fact *titled* "bitcoin
 * price" outranks one that mentions prices in passing - a hand-rolled token
 * overlap cannot do that), and supports prefix and fuzzy matching, which is
 * what makes "pricing"/"price" and a one-letter typo still match. The
 * alternatives were worse for this job: FlexSearch is faster but ranks clearly
 * worse (BEIR nDCG@10 0.168 vs 0.305), Orama and Lunr are heavier for the same
 * quality, and vector search is not viable here - the app has exactly one
 * provider (OpenRouter, which serves no embeddings endpoint), and a local ONNX
 * model would add hundreds of MB of install size and RSS to a 1 GB service to
 * search a few thousand short notes. Lexical retrieval with fuzzy + prefix is
 * the right size, stays deterministic, and costs no extra tokens.
 *
 * The index lives in memory and is rebuilt lazily after any write, which is
 * cheaper than keeping SQLite and the index in sync token by token at this
 * corpus size (pruning caps it at a few hundred facts and episodes).
 */
import MiniSearch from "minisearch";
import { getDb } from "./db";
import type { EpisodeRow, MemoryRow } from "./memory";

interface FactDoc {
  id: string;
  title: string;
  content: string;
  topic: string;
}

interface EpisodeDoc {
  id: string;
  goal: string;
  summary: string;
  tags: string;
}

/** Dropped at index time: too common to discriminate, and dropping them keeps
 * the index (and every query) smaller. */
const STOPWORDS = new Set(
  "the and for with that this from have has had was were are been being into onto over under about after before between what which who whom how why when where your yours our ours their theirs its it's you'll you've etc".split(
    " "
  )
);

function processTerm(raw: string): string | null {
  const term = raw.toLowerCase();
  if (term.length < 2 || STOPWORDS.has(term)) return null;
  return term;
}

let dirty = 0;
let built = -1;
let factIndex: MiniSearch<FactDoc> | null = null;
let episodeIndex: MiniSearch<EpisodeDoc> | null = null;
const factRows = new Map<string, MemoryRow>();
const episodeRows = new Map<string, EpisodeRow>();

/** Call after any change to memories/episodes; the next search rebuilds. */
export function markMemoryIndexDirty() {
  dirty++;
}

function build() {
  const db = getDb();
  const topics = new Map(
    (db.prepare("SELECT id, path FROM memory_topics").all() as { id: string; path: string }[]).map((row) => [
      row.id,
      row.path,
    ])
  );

  factRows.clear();
  const facts = db.prepare("SELECT * FROM memories").all() as MemoryRow[];
  const factDocs: FactDoc[] = facts.map((row) => {
    factRows.set(row.id, row);
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      topic: row.topic_id ? topics.get(row.topic_id) ?? "" : "",
    };
  });

  factIndex = new MiniSearch<FactDoc>({
    fields: ["title", "content", "topic"],
    storeFields: ["id"],
    processTerm,
  });
  factIndex.addAll(factDocs);

  episodeRows.clear();
  const episodes = db
    .prepare("SELECT * FROM episodes ORDER BY updated_at DESC LIMIT 600")
    .all() as EpisodeRow[];
  const episodeDocs: EpisodeDoc[] = episodes.map((row) => {
    episodeRows.set(row.task_id, row);
    return { id: row.task_id, goal: row.goal, summary: row.summary, tags: row.tags };
  });

  episodeIndex = new MiniSearch<EpisodeDoc>({
    fields: ["goal", "summary", "tags"],
    storeFields: ["id"],
    processTerm,
  });
  episodeIndex.addAll(episodeDocs);

  built = dirty;
}

function ready() {
  if (!factIndex || !episodeIndex || built !== dirty) build();
  return { factIndex: factIndex!, episodeIndex: episodeIndex! };
}

/** Normalised 0..1 relevance, so callers can mix it with their own bonuses. */
function normalise<T>(hits: { id: string; score: number }[], rows: Map<string, T>, limit: number) {
  if (hits.length === 0) return [];
  const top = hits[0].score || 1;
  return hits
    .slice(0, limit)
    .map((hit) => ({ row: rows.get(hit.id), score: Math.min(1, hit.score / top) }))
    .filter((entry): entry is { row: T; score: number } => Boolean(entry.row));
}

export function searchFactIndex(query: string, limit = 40): { row: MemoryRow; score: number }[] {
  const { factIndex } = ready();
  const hits = factIndex.search(query, {
    boost: { title: 3, topic: 2 },
    fuzzy: 0.2,
    prefix: true,
    combineWith: "OR",
  });
  return normalise(hits, factRows, limit);
}

export function searchEpisodeIndex(query: string, limit = 30): { row: EpisodeRow; score: number }[] {
  const { episodeIndex } = ready();
  const hits = episodeIndex.search(query, {
    boost: { goal: 2.5, tags: 1.5 },
    fuzzy: 0.2,
    prefix: true,
    combineWith: "OR",
  });
  return normalise(hits, episodeRows, limit);
}
