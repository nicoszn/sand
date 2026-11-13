/**
 * All app-wide configuration constants live here - every other module imports
 * `config` instead of defining its own magic strings/numbers.
 *
 * Nothing here is read from the environment: the app has exactly one model, one
 * endpoint and one data directory, so these are plain named values rather than
 * deployment variables.
 *
 * This module holds the server-side OpenRouter credential, so it must only be
 * imported from server code (route handlers, instrumentation, lib/server/*).
 * Never import it into a client component, or the key ends up in the browser
 * bundle.
 */

/** Directory (relative to the project root) holding the SQLite database and the
 * embedding model cache. */
const DATA_DIR = "data";

export const config = {
  /** Directory (relative to the project root) the SQLite file lives in. */
  dataDir: DATA_DIR,

  /** OpenRouter chat completions endpoint. */
  openrouterApiUrl: "https://openrouter.ai/api/v1/chat/completions",

  /** The one model the agent uses. No fallbacks, no per-task choice. */
  model: "openrouter/free",

  /**
   * The one OpenRouter key the app authenticates with: paste it between the
   * quotes.
   *
   * Left empty in the repository on purpose - this project is public, so a key
   * committed here would be a published credential, and git history keeps it
   * even after a later removal.
   */
  openrouterApiKey: "",

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
