/**
 * All app-wide configuration constants live here - every other module
 * imports `config` instead of defining its own magic strings/numbers.
 *
 * This module holds the server-side OpenRouter credential, so it must only be
 * imported from server code (route handlers, instrumentation, lib/server/*).
 * Never import it into a client component, or the key ends up in the browser
 * bundle.
 */
export const config = {
  /** Directory (relative to the project root) the SQLite file lives in. */
  dataDir: "data",

  /** OpenRouter chat completions endpoint. */
  openrouterApiUrl: "https://openrouter.ai/api/v1/chat/completions",

  /** The one model the agent uses. No fallbacks, no per-task choice. */
  model: "openrouter/free",

  /**
   * The one OpenRouter key the app authenticates with. Read from the
   * environment rather than hard-coded, because this repository is public and
   * a key in a tracked file would be a published credential. Set it in
   * `.env.local` (git-ignored) as OPENROUTER_API_KEY.
   */
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
} as const;
