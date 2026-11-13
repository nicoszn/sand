"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api } from "@/lib/api";

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch((e) => setError(e.message));
  }, []);

  const setField = (k: string, v: string) => setSettings((prev) => (prev ? { ...prev, [k]: v } : prev));

  const save = async () => {
    if (!settings) return;
    setError(null);
    try {
      // One visible step limit: the per-task ceiling and the internal safety
      // cap stay in sync, so nothing hidden contradicts this field.
      const maxSteps = Math.max(1, Number(settings.max_steps_default) || 12);
      const updated = await api.updateSettings({
        max_steps_default: maxSteps,
        max_steps_hard_cap: maxSteps,
        daily_token_budget: Number(settings.daily_token_budget),
        tool_timeout_seconds: Number(settings.tool_timeout_seconds),
        // Capacity only: which memories survive is decided by their retention
        // score, so this is how much the store may hold, not a prune rule.
        memory_budget_chars: Math.max(2000, Number(settings.memory_budget_chars) || 120000),
      });
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            The limits every task runs under. Stored locally, applied to the next task.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">Task limits</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {saved && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 12,
                  color: "var(--accent-green)",
                }}
              >
                <Check size={13} />
                Saved
              </span>
            )}
            <button className="btn btn-sm btn-primary" onClick={save} disabled={!settings}>
              Save
            </button>
          </div>
        </div>

        {settings ? (
          <>
            <div className="limits">
              <div className="limit">
                <label className="limit-label" htmlFor="max-steps">
                  Max steps
                </label>
                <input
                  id="max-steps"
                  type="number"
                  min={1}
                  value={settings.max_steps_default}
                  onChange={(e) => setField("max_steps_default", e.target.value)}
                />
                <div className="limit-hint">Model calls per task</div>
              </div>
              <div className="limit">
                <label className="limit-label" htmlFor="token-budget">
                  Token budget
                </label>
                <input
                  id="token-budget"
                  type="number"
                  min={0}
                  value={settings.daily_token_budget}
                  onChange={(e) => setField("daily_token_budget", e.target.value)}
                />
                <div className="limit-hint">Per day, all tasks</div>
              </div>
              <div className="limit">
                <label className="limit-label" htmlFor="tool-timeout">
                  Tool timeout
                </label>
                <input
                  id="tool-timeout"
                  type="number"
                  min={1}
                  value={settings.tool_timeout_seconds}
                  onChange={(e) => setField("tool_timeout_seconds", e.target.value)}
                />
                <div className="limit-hint">Seconds per code run</div>
              </div>
              <div className="limit">
                <label className="limit-label" htmlFor="memory-budget">
                  Memory budget
                </label>
                <input
                  id="memory-budget"
                  type="number"
                  min={2000}
                  step={1000}
                  value={settings.memory_budget_chars ?? "120000"}
                  onChange={(e) => setField("memory_budget_chars", e.target.value)}
                />
                <div className="limit-hint">Characters of saved facts</div>
              </div>
            </div>
            {error && (
              <div className="notice error" style={{ margin: "0 18px 16px" }}>
                {error}
              </div>
            )}
          </>
        ) : (
          <div style={{ padding: "18px 20px", color: "var(--ink-3)", fontSize: 12.5 }}>
            {error ?? "Loading limits…"}
          </div>
        )}
      </div>
    </div>
  );
}
