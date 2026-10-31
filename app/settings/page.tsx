"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function SettingsPage() {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setValues).catch((e) => setError(e.message));
  }, []);

  const set = (k: string, v: string) => setValues((prev) => (prev ? { ...prev, [k]: v } : prev));

  const save = async () => {
    if (!values) return;
    setError(null);
    try {
      const updated = await api.updateSettings({
        default_model: values.default_model,
        fallback_models: JSON.parse(values.fallback_models),
        max_steps_default: Number(values.max_steps_default),
        max_steps_hard_cap: Number(values.max_steps_hard_cap),
        daily_token_budget: Number(values.daily_token_budget),
        tool_timeout_seconds: Number(values.tool_timeout_seconds),
      });
      setValues(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fallback_models must be valid JSON (an array of model ids)");
    }
  };

  if (!values) return <div style={{ padding: 36, color: "var(--text-2)" }}>loading...</div>;

  return (
    <div style={{ padding: "28px 36px", maxWidth: 620 }}>
      <h1 style={{ fontSize: 16, fontWeight: 400, color: "var(--text-0)", margin: "0 0 20px" }}>settings</h1>

      <Field label="default model" hint="OpenRouter model id, e.g. qwen/qwen3-coder:free">
        <input value={values.default_model} onChange={(e) => set("default_model", e.target.value)} style={{ width: "100%" }} />
      </Field>

      <Field label="fallback models" hint="JSON array, tried in order if the default model/key fails">
        <textarea
          value={values.fallback_models}
          onChange={(e) => set("fallback_models", e.target.value)}
          rows={3}
          style={{ width: "100%", fontSize: 12.5 }}
        />
      </Field>

      <div style={{ display: "flex", gap: 24, marginBottom: 18 }}>
        <Field label="default max steps" hint="per task, unless overridden">
          <input type="number" value={values.max_steps_default} onChange={(e) => set("max_steps_default", e.target.value)} style={{ width: 100 }} />
        </Field>
        <Field label="hard step cap" hint="no task can exceed this">
          <input type="number" value={values.max_steps_hard_cap} onChange={(e) => set("max_steps_hard_cap", e.target.value)} style={{ width: 100 }} />
        </Field>
      </div>

      <div style={{ display: "flex", gap: 24, marginBottom: 18 }}>
        <Field label="daily token budget" hint="combined prompt+completion tokens across the whole key pool; tasks stop when hit">
          <input type="number" value={values.daily_token_budget} onChange={(e) => set("daily_token_budget", e.target.value)} style={{ width: 140 }} />
        </Field>
        <Field label="tool timeout (s)" hint="per run_python / run_node call">
          <input type="number" value={values.tool_timeout_seconds} onChange={(e) => set("tool_timeout_seconds", e.target.value)} style={{ width: 100 }} />
        </Field>
      </div>

      {error && <div style={{ color: "var(--accent-red)", fontSize: 12.5, marginBottom: 14 }}>{error}</div>}

      <button className="btn btn-primary" onClick={save}>
        save settings
      </button>
      {saved && <span style={{ color: "var(--accent-green)", fontSize: 12.5, marginLeft: 12 }}>saved</span>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={{ display: "block", fontSize: 12, color: "var(--text-1)", marginBottom: 4 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
