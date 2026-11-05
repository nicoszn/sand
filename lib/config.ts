/**
 * All environment variable reads for the whole app happen here, and
 * nowhere else - every other module imports `config` instead of touching
 * `process.env` directly. Nothing here is secret (API keys live in SQLite,
 * added from the UI, not env vars) so this file is safe to import from
 * either server or client code, though in practice only server modules
 * need it today.
 */

function readInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  /** Standard Next.js/Node env. */
  nodeEnv: process.env.NODE_ENV ?? "development",

  /** Railway sets this; `npm run start` reads it via the package.json script.
   * Exposed here too so any server code that needs it reads config, not env. */
  port: readInt("PORT", 3000),

  /** Directory (relative to cwd, or absolute) the SQLite file lives in. */
  dataDir: process.env.DATA_DIR ?? "data",

  /** OpenRouter chat completions endpoint. Overridable for testing against
   * a mock, or if OpenRouter ever changes their API base. */
  openrouterApiUrl: process.env.OPENROUTER_API_URL ?? "https://openrouter.ai/api/v1/chat/completions",
} as const;
