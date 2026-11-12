"use client";

import { useEffect, useState } from "react";
import { api, ApiKey, PoolSummary } from "@/lib/api";

const STATUS_COLOR: Record<string, string> = {
  available: "var(--accent-green)",
  exhausted: "var(--accent-red)",
  disabled: "var(--text-2)",
};

export default function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [pool, setPool] = useState<PoolSummary | null>(null);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [dailyLimit, setDailyLimit] = useState(50);
  const [minuteLimit, setMinuteLimit] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    const [k, p] = await Promise.all([api.listKeys(), api.poolSummary()]);
    setKeys(k);
    setPool(p);
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const addKey = async () => {
    setError(null);
    if (!label.trim() || !value.trim()) {
      setError("Both a label and the key value are required.");
      return;
    }
    setAdding(true);
    try {
      await api.addKey(label.trim(), value.trim(), dailyLimit, minuteLimit);
      setLabel("");
      setValue("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add key");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <h1 style={{ fontSize: 16, fontWeight: 400, color: "var(--text-0)", margin: "0 0 6px" }}>keys & limits</h1>
      <p style={{ color: "var(--text-2)", fontSize: 12.5, margin: "0 0 20px", maxWidth: 560 }}>
        Each free OpenRouter key is capped around 50 requests/day and 20/minute. Add more keys to grow the
        combined pool — the scheduler spreads requests across whichever key has headroom and reports when all
        of them are exhausted instead of failing silently.
      </p>

      {pool && (
        <div className="panel" style={{ display: "flex", padding: 16, marginBottom: 22, gap: 24, flexWrap: "wrap" }}>
          <Stat label="keys in pool" value={`${pool.available_keys}/${pool.total_keys} available`} />
          <Stat label="requests left today" value={`${pool.requests_remaining_today}/${pool.requests_capacity_today}`} />
          <Stat label="tokens used today" value={pool.tokens_used_today.toLocaleString()} />
        </div>
      )}

      <div className="panel" style={{ padding: 16, marginBottom: 22 }}>
        <div style={{ fontSize: 12, color: "var(--text-1)", marginBottom: 12 }}>add a key</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <input placeholder="label, e.g. personal-1" value={label} onChange={(e) => setLabel(e.target.value)} style={{ flex: "1 1 160px" }} />
          <input placeholder="sk-or-v1-..." value={value} onChange={(e) => setValue(e.target.value)} type="password" style={{ flex: "2 1 260px" }} />
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "var(--text-2)" }}>daily limit</label>
          <input type="number" value={dailyLimit} onChange={(e) => setDailyLimit(Number(e.target.value))} style={{ width: 80 }} />
          <label style={{ fontSize: 12, color: "var(--text-2)" }}>per-minute limit</label>
          <input type="number" value={minuteLimit} onChange={(e) => setMinuteLimit(Number(e.target.value))} style={{ width: 80 }} />
        </div>
        {error && <div style={{ color: "var(--accent-red)", fontSize: 12, marginBottom: 10 }}>{error}</div>}
        <button className="btn btn-primary" onClick={addKey} disabled={adding}>
          {adding ? "adding..." : "add key"}
        </button>
      </div>

      {keys && keys.length === 0 && (
        <div className="panel" style={{ padding: 24, textAlign: "center", color: "var(--text-2)" }}>
          No keys yet. Add your OpenRouter free-tier key above to start running tasks.
        </div>
      )}

      {keys &&
        keys.map((k) => (
          <div key={k.id} className="panel" style={{ padding: 14, marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <div>
                <span style={{ color: "var(--text-0)" }}>{k.label}</span>
                <span style={{ color: "var(--text-2)", marginLeft: 10, fontSize: 12 }}>{k.key_preview}</span>
              </div>
              <span style={{ color: STATUS_COLOR[k.status], fontSize: 12 }}>{k.status}</span>
            </div>

            <UsageBar used={k.requests_today} limit={k.daily_limit} />

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>
                {k.requests_today}/{k.daily_limit} requests today · {k.prompt_tokens_today + k.completion_tokens_today} tokens
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={() => api.setKeyEnabled(k.id, !k.enabled).then(load)}>
                  {k.enabled ? "disable" : "enable"}
                </button>
                <button
                  className="btn"
                  style={{ color: "var(--accent-red)" }}
                  onClick={() => {
                    if (confirm(`Remove key "${k.label}"?`)) api.deleteKey(k.id).then(load);
                  }}
                >
                  remove
                </button>
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-2)" }}>{label}</div>
      <div style={{ fontSize: 16, color: "var(--text-0)", marginTop: 2 }}>{value}</div>
    </div>
  );
}

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, (used / Math.max(1, limit)) * 100);
  const color = pct >= 100 ? "var(--accent-red)" : pct > 70 ? "var(--accent-amber)" : "var(--accent-green)";
  return (
    <div style={{ height: 5, background: "var(--bg-2)", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color }} />
    </div>
  );
}
