/**
 * All app-wide configuration constants live here - every other module imports
 * `config` instead of defining its own magic strings/numbers.
 *
 * Nothing here is read from the environment: the app has exactly one model, one
 * endpoint and one data directory, so these are plain named values rather than
 * deployment variables.
 *
 * This module holds the server-side OpenRouter credential (read from disk), so
 * it must only be imported from server code (route handlers, instrumentation,
 * lib/server/*). Never import it into a client component, or the key ends up in
 * the browser bundle.
 */
import fs from "node:fs";
import path from "node:path";

/** Directory (relative to the project root) holding the SQLite database, the
 * embedding model cache and the key file. */
const DATA_DIR = "data";

/**
 * The one OpenRouter key the app authenticates with.
 *
 * It is read from `data/openrouter.key` (one line, the key) instead of being
 * written into this file, because this repository is public: a literal key here
 * would be a published credential, and git history keeps it even after a later
 * removal. The data directory is git-ignored, so on a deployment the key lives
 * on the volume next to the database and travels with it.
 *
 * Read once at startup, so rotating the key means restarting the service.
 */
function readApiKey(): string {
  try {
    return fs.readFileSync(path.join(process.cwd(), DATA_DIR, "openrouter.key"), "utf8").trim();
  } catch {
    return "";
  }
}

export const config = {
  /** Directory (relative to the project root) the SQLite file lives in. */
  dataDir: DATA_DIR,

  /** OpenRouter chat completions endpoint. */
  openrouterApiUrl: "https://openrouter.ai/api/v1/chat/completions",

  /** The one model the agent uses. No fallbacks, no per-task choice. */
  model: "openrouter/free",

  /** Where the OpenRouter credential is kept, and its value. */
  openrouterKeyFile: path.join(DATA_DIR, "openrouter.key"),
  openrouterApiKey: readApiKey(),

  /**
   * Local sentence embeddings for semantic memory search. Runs in-process via
   * Transformers.js, so there is no second provider or API key.
   *
   * Set this to false to skip the model entirely: no download, no ONNX runtime,
   * and retrieval falls back to BM25 plus graph activation. That is the switch
   * to pull on a host where the embedding session's memory is too expensive.
   */
  embeddingsEnabled: true,
  embeddingsModel: "Xenova/all-MiniLM-L6-v2",
} as const;
