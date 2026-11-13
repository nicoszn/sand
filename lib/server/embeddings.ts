/**
 * Local text embeddings, no external provider.
 *
 * Chosen package: @huggingface/transformers (Transformers.js v3) running
 * `Xenova/all-MiniLM-L6-v2` — a 384-dimension sentence-transformer, 23 MB at q8,
 * mean-pooled and L2-normalised. It is the standard small retrieval encoder
 * (trained for semantic similarity, and the model behind most local vector
 * demos), runs on CPU through onnxruntime in tens of milliseconds per short
 * text, and needs no API key. That matters here: OpenRouter serves chat
 * completions only, so a hosted embedding API would mean a second provider,
 * a second credential and network latency on every task start.
 *
 * Everything degrades gracefully: if the model cannot be loaded (offline
 * install, memory pressure, `EMBEDDINGS=off`), `embedTexts` resolves to null and
 * retrieval falls back to BM25 + graph activation instead of failing a task.
 */
import path from "node:path";
import { config } from "@/lib/config";

type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

export const EMBEDDING_DIM = 384;

// Next.js can instantiate this module once per compilation unit (instrumentation
// vs. route handlers), so the loaded state has to live on globalThis or the API
// would report "not ready" while the model is in fact loaded and serving.
declare global {
  // eslint-disable-next-line no-var
  var __agentSandboxEmbeddings: { loading: Promise<FeatureExtractor | null> | null; ready: boolean; failure: string | null } | undefined;
}

function state() {
  if (!globalThis.__agentSandboxEmbeddings) {
    globalThis.__agentSandboxEmbeddings = { loading: null, ready: false, failure: null };
  }
  return globalThis.__agentSandboxEmbeddings;
}

async function load(): Promise<FeatureExtractor | null> {
  if (!config.embeddingsEnabled) {
    state().failure = "disabled by EMBEDDINGS=off";
    return null;
  }
  try {
    const transformers = await import("@huggingface/transformers");
    // Keep the weights on the same volume as the database so a redeploy does
    // not fetch 23 MB again.
    transformers.env.cacheDir = path.join(process.cwd(), config.dataDir, "models");
    const pipe = await transformers.pipeline("feature-extraction", config.embeddingsModel, { dtype: "q8" });
    state().ready = true;
    state().failure = null;
    return (texts, options) => pipe(texts, options) as Promise<{ data: Float32Array; dims: number[] }>;
  } catch (error) {
    state().failure = error instanceof Error ? error.message : String(error);
    console.error(`[embeddings] unavailable, falling back to lexical retrieval: ${state().failure}`);
    return null;
  }
}

function extractor(): Promise<FeatureExtractor | null> {
  const current = state();
  if (!current.loading) current.loading = load();
  return current.loading;
}

/** Mean-pooled, unit-length vectors, or null when embeddings are unavailable. */
export async function embedTexts(texts: string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  const pipe = await extractor();
  if (!pipe) return null;
  try {
    const output = await pipe(texts, { pooling: "mean", normalize: true });
    const dim = output.dims[output.dims.length - 1] ?? EMBEDDING_DIM;
    return texts.map((_, index) => output.data.slice(index * dim, (index + 1) * dim));
  } catch (error) {
    state().failure = error instanceof Error ? error.message : String(error);
    return null;
  }
}

/** Loads the model proactively at boot so the first task's memory lookup does
 * not pay the load. Never throws: a failure just leaves the lexical path. */
export async function warmEmbeddings() {
  await embedTexts(["workspace memory warmup"]);
}

export function embeddingStatus() {
  const current = state();
  return {
    enabled: config.embeddingsEnabled,
    ready: current.ready,
    model: config.embeddingsModel,
    dimensions: EMBEDDING_DIM,
    error: current.failure,
  };
}
