/** Runtime-adjustable settings: caps, default model, token budget. Stored
 * in SQLite so changes persist and can be edited from the UI without a
 * redeploy. */
import { getDb } from "./db";

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare("SELECT k, v FROM settings").all() as { k: string; v: string }[];
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

export function getSetting(key: string, fallback: string | null = null): string | null {
  const row = getDb().prepare("SELECT v FROM settings WHERE k = ?").get(key) as { v: string } | undefined;
  return row ? row.v : fallback;
}

export function getSettingInt(key: string, fallback: number): number {
  const v = getSetting(key);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function setManySettings(values: Record<string, unknown>) {
  const db = getDb();
  const upsert = db.prepare(
    "INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  );
  const tx = db.transaction((entries: [string, unknown][]) => {
    for (const [k, v] of entries) {
      const raw = typeof v === "string" ? v : JSON.stringify(v);
      upsert.run(k, raw);
    }
  });
  tx(Object.entries(values));
}
