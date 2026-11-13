/**
 * Vector side of memory retrieval: one embedding per fact, stored as a BLOB in
 * SQLite and searched by cosine similarity in process.
 *
 * A dedicated vector index (sqlite-vec, HNSW, FAISS) would be the right tool for
 * tens of thousands of vectors. At the scale this store is budgeted to (hundreds
 * of facts), an exhaustive cosine scan is a few hundred microseconds and adds no
 * native extension, no second file to keep consistent, and no index to rebuild.
 * Vectors are cached in memory and invalidated whenever a fact changes.
 */
import { getDb, now } from "./db";
import { embedTexts } from "./embeddings";

let cache: Map<string, Float32Array> | null = null;
let version = 0;

export function markVectorsDirty() {
  version++;
}

function loadVectors(): Map<string, Float32Array> {
  if (cache) return cache;
  const rows = getDb().prepare("SELECT memory_id, vector FROM memory_vectors").all() as {
    memory_id: string;
    vector: Buffer;
  }[];
  cache = new Map(
    rows.map((row) => [
      row.memory_id,
      new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4),
    ])
  );
  return cache;
}

// The cache and its version travel together so an invalidation always reloads.
let cachedVersion = -1;
function vectors(): Map<string, Float32Array> {
  if (cachedVersion !== version) {
    cache = null;
    cachedVersion = version;
  }
  return loadVectors();
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) dot += a[i] * b[i];
  // Vectors are normalised at embed time, so the dot product is the cosine.
  return dot;
}

function write(memoryId: string, vector: Float32Array) {
  getDb()
    .prepare(
      "INSERT INTO memory_vectors (memory_id, dim, vector, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(memory_id) DO UPDATE SET vector = excluded.vector, dim = excluded.dim, updated_at = excluded.updated_at"
    )
    .run(memoryId, vector.length, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), now());
  markVectorsDirty();
}

/** Fire-and-forget from a write path: memory stays usable while the model
 * (or the download of it) catches up. */
export function queueEmbedding(memoryId: string, title: string, content: string) {
  void (async () => {
    try {
      const [vector] = (await embedTexts([`${title}. ${content}`])) ?? [];
      if (vector) write(memoryId, vector);
    } catch {
      /* lexical retrieval still works */
    }
  })();
}

/** Embeds anything that has no vector yet - on boot, and lazily before a
 * vector search if the backlog is small. */
export async function backfillVectors(limit = 40): Promise<number> {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.title, m.content FROM memories m
       LEFT JOIN memory_vectors v ON v.memory_id = m.id
       WHERE v.memory_id IS NULL LIMIT ?`
    )
    .all(limit) as { id: string; title: string; content: string }[];
  if (rows.length === 0) return 0;

  const vectors = await embedTexts(rows.map((row) => `${row.title}. ${row.content}`));
  if (!vectors) return 0;
  rows.forEach((row, index) => write(row.id, vectors[index]));
  return rows.length;
}

/** Cosine ranking of the whole store against a query embedding. */
export async function rankByVector(query: string, limit = 40): Promise<{ id: string; score: number }[]> {
  const stored = vectors();
  if (stored.size === 0) {
    // Nothing embedded yet (fresh install): pay the backfill once, then retry.
    const filled = await backfillVectors();
    if (filled === 0) return [];
  }
  const [queryVector] = (await embedTexts([query])) ?? [];
  if (!queryVector) return [];

  const scored: { id: string; score: number }[] = [];
  for (const [id, vector] of vectors()) {
    scored.push({ id, score: cosine(queryVector, vector) });
  }
  return scored
    .filter((entry) => entry.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function vectorStats() {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM memory_vectors").get() as { n: number };
  return { embedded: row.n, cached: vectors().size };
}
