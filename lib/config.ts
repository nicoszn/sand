/**
 * All app-wide configuration constants live here - every other module
 * imports `config` instead of defining its own magic strings/numbers.
 * These are fixed values, not environment variables: nothing in this app
 * needs to be configurable per-deployment (OpenRouter keys live in SQLite,
 * added from the UI, not env vars; the port Railway assigns is handled by
 * the `next start -p $PORT` shell command in package.json, outside the
 * app's own code). If a value here ever needs to vary per-environment,
 * that's a deliberate future change, not the default.
 */
export const config = {
  /** Directory (relative to the project root) the SQLite file lives in. */
  dataDir: "data",

  /** OpenRouter chat completions endpoint. */
  openrouterApiUrl: "https://openrouter.ai/api/v1/chat/completions",
} as const;
