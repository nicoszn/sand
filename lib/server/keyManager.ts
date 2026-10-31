/**
 * Manages a pool of OpenRouter API keys.
 *
 * Each free OpenRouter key is capped at ~50 requests/day and 20/minute.
 * This module tracks usage per key (persisted in SQLite, keyed by UTC day),
 * picks the least-used key that still has headroom, and reports clear
 * exhaustion state instead of silently failing. Add more keys at any time
 * via the /api/keys endpoints or the Keys & limits page - no redeploy
 * needed.
 */
import { randomBytes } from "node:crypto";
import { getDb, now } from "./db";
import { ApiKeyRow, ApiKeyView, PoolSummary } from "./types";

function today(): string {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

export class NoAvailableKeyError extends Error {
  retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null = null) {
    super("All API keys are at their rate limit");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function addKey(label: string, keyValue: string, dailyLimit = 50, minuteLimit = 20): string {
  const id = randomBytes(6).toString("hex");
  getDb()
    .prepare(
      "INSERT INTO api_keys (id, label, key_value, daily_limit, minute_limit, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)"
    )
    .run(id, label, keyValue, dailyLimit, minuteLimit, now());
  return id;
}

export function removeKey(id: string) {
  const db = getDb();
  db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  db.prepare("DELETE FROM key_usage WHERE key_id = ?").run(id);
  db.prepare("DELETE FROM key_minute_window WHERE key_id = ?").run(id);
}

export function setKeyEnabled(id: string, enabled: boolean) {
  getDb().prepare("UPDATE api_keys SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

function maskKey(keyValue: string): string {
  if (keyValue.length <= 10) return "****";
  return `${keyValue.slice(0, 8)}...${keyValue.slice(-4)}`;
}

export function listKeysWithUsage(): ApiKeyView[] {
  const db = getDb();
  const day = today();
  const keys = db.prepare("SELECT * FROM api_keys ORDER BY created_at ASC").all() as ApiKeyRow[];
  const usageStmt = db.prepare(
    "SELECT request_count, prompt_tokens, completion_tokens FROM key_usage WHERE key_id = ? AND day = ?"
  );

  return keys.map((k) => {
    const usage = usageStmt.get(k.id, day) as
      | { request_count: number; prompt_tokens: number; completion_tokens: number }
      | undefined;
    const used = usage?.request_count ?? 0;
    const status: ApiKeyView["status"] = !k.enabled ? "disabled" : used < k.daily_limit ? "available" : "exhausted";
    return {
      id: k.id,
      label: k.label,
      key_preview: maskKey(k.key_value),
      enabled: !!k.enabled,
      daily_limit: k.daily_limit,
      minute_limit: k.minute_limit,
      requests_today: used,
      requests_remaining_today: Math.max(0, k.daily_limit - used),
      prompt_tokens_today: usage?.prompt_tokens ?? 0,
      completion_tokens_today: usage?.completion_tokens ?? 0,
      status,
    };
  });
}

export function acquireKey(): { id: string; key_value: string; label: string } {
  const db = getDb();
  const day = today();
  const t = now();

  const keys = db.prepare("SELECT * FROM api_keys WHERE enabled = 1 ORDER BY created_at ASC").all() as ApiKeyRow[];
  if (keys.length === 0) throw new NoAvailableKeyError();

  const usageStmt = db.prepare("SELECT request_count FROM key_usage WHERE key_id = ? AND day = ?");
  const windowStmt = db.prepare("SELECT window_start, request_count FROM key_minute_window WHERE key_id = ?");

  const candidates: { usedToday: number; key: ApiKeyRow }[] = [];
  let soonestRetry: number | null = null;

  for (const k of keys) {
    const usage = usageStmt.get(k.id, day) as { request_count: number } | undefined;
    const usedToday = usage?.request_count ?? 0;
    if (usedToday >= k.daily_limit) continue;

    const window = windowStmt.get(k.id) as { window_start: number; request_count: number } | undefined;
    if (window && t - window.window_start < 60) {
      if (window.request_count >= k.minute_limit) {
        const retryIn = 60 - (t - window.window_start);
        soonestRetry = soonestRetry === null ? retryIn : Math.min(soonestRetry, retryIn);
        continue;
      }
    }
    candidates.push({ usedToday, key: k });
  }

  if (candidates.length === 0) throw new NoAvailableKeyError(soonestRetry);

  // Prefer the key used least today, to spread load evenly across the pool.
  candidates.sort((a, b) => a.usedToday - b.usedToday);
  const chosen = candidates[0].key;
  return { id: chosen.id, key_value: chosen.key_value, label: chosen.label };
}

export function recordUsage(keyId: string, promptTokens = 0, completionTokens = 0) {
  const db = getDb();
  const day = today();
  const t = now();

  db.prepare(
    `INSERT INTO key_usage (key_id, day, request_count, prompt_tokens, completion_tokens)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(key_id, day) DO UPDATE SET
       request_count = request_count + 1,
       prompt_tokens = prompt_tokens + excluded.prompt_tokens,
       completion_tokens = completion_tokens + excluded.completion_tokens`
  ).run(keyId, day, promptTokens, completionTokens);

  const window = db.prepare("SELECT window_start, request_count FROM key_minute_window WHERE key_id = ?").get(keyId) as
    | { window_start: number; request_count: number }
    | undefined;

  if (window && t - window.window_start < 60) {
    db.prepare("UPDATE key_minute_window SET request_count = request_count + 1 WHERE key_id = ?").run(keyId);
  } else {
    db.prepare(
      `INSERT INTO key_minute_window (key_id, window_start, request_count) VALUES (?, ?, 1)
       ON CONFLICT(key_id) DO UPDATE SET window_start = excluded.window_start, request_count = 1`
    ).run(keyId, t);
  }
}

export function poolSummary(): PoolSummary {
  const keys = listKeysWithUsage();
  return {
    total_keys: keys.length,
    available_keys: keys.filter((k) => k.status === "available").length,
    requests_remaining_today: keys.reduce((sum, k) => sum + k.requests_remaining_today, 0),
    requests_capacity_today: keys.filter((k) => k.enabled).reduce((sum, k) => sum + k.daily_limit, 0),
    tokens_used_today: keys.reduce((sum, k) => sum + k.prompt_tokens_today + k.completion_tokens_today, 0),
  };
}
