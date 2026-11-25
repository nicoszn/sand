"use client";

import { useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { api } from "@/lib/api";

const FIELDS = [
  {
    key: "max_steps_default",
    label: "Max steps",
    hint: "Model calls allowed per task",
    min: 1,
    step: 1,
  },
  {
    key: "daily_token_budget",
    label: "Token budget",
    hint: "Tokens shared by all tasks, per day",
    min: 0,
    step: 1000,
  },
  {
    key: "tool_timeout_seconds",
    label: "Tool timeout",
    hint: "Seconds allowed for one code run",
    min: 1,
    step: 1,
  },
  {
    key: "memory_budget_chars",
    label: "Memory budget",
    hint: "Characters of saved facts kept",
    min: 2000,
    step: 1000,
  },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch((e) => setError(e.message));
  }, []);

  const startEdit = () => {
    if (!settings) return;
    setDraft({ ...settings });
    setError(null);
    setSaved(false);
    setEditing(true);
  };

  const cancelEdit = () => {
    setDraft(null);
    setError(null);
    setEditing(false);
  };

  const setField = (k: FieldKey, v: string) => setDraft((prev) => (prev ? { ...prev, [k]: v } : prev));

  const save = async () => {
    if (!draft) return;
    setError(null);
    setSaving(true);
    try {
      // One visible step limit: the per-task ceiling and the internal safety
      // cap stay in sync, so nothing hidden contradicts this field.
      const maxSteps = Math.max(1, Number(draft.max_steps_default) || 12);
      const updated = await api.updateSettings({
        max_steps_default: maxSteps,
        max_steps_hard_cap: maxSteps,
        daily_token_budget: Number(draft.daily_token_budget),
        tool_timeout_seconds: Number(draft.tool_timeout_seconds),
        // Capacity only: which memories survive is decided by their retention
        // score, so this is how much the store may hold, not a prune rule.
        memory_budget_chars: Math.max(2000, Number(draft.memory_budget_chars) || 120000),
      });
      setSettings(updated);
      setDraft(null);
      setEditing(false);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="compose">
      <div className="page-head">
        <div>
          <span className="page-kicker">Workspace</span>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">The limits every task runs under. Stored locally, applied to the next task.</p>
        </div>
      </div>

      <div className="card settings-card">
        <div className="card-head">
          <div>
            <span className="card-title">Task limits</span>
            <span className="card-sub">Inherited by every new task</span>
          </div>
          {!editing && (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {saved && (
                <span className="saved" style={{ color: "var(--accent-green)", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Check size={13} /> Saved
                </span>
              )}
              <button className="btn btn-sm" onClick={startEdit} disabled={!settings}>
                <Pencil size={12} />
                Edit
              </button>
            </div>
          )}
        </div>

        {!settings && (
          <div style={{ padding: "18px 20px", color: "var(--ink-3)", fontSize: 12.5 }}>
            {error ?? "Loading limits…"}
          </div>
        )}

        {settings && !editing && (
          <dl className="figure-grid" style={{ margin: 0 }}>
            {FIELDS.map((field) => {
              const value = Number(settings[field.key] ?? 0);
              return (
                <div key={field.key} className="figure">
                  <dt>{field.label}</dt>
                  <dd>{value.toLocaleString()}</dd>
                  <p>{field.hint}</p>
                </div>
              );
            })}
          </dl>
        )}

        {editing && draft && (
          <div className="settings-form">
            <div className="settings-grid">
              {FIELDS.map((field) => (
                <div key={field.key}>
                  <label className="field-label" htmlFor={`field-${field.key}`}>
                    {field.label}
                  </label>
                  <input
                    id={`field-${field.key}`}
                    type="number"
                    inputMode="numeric"
                    min={field.min}
                    step={field.step}
                    value={draft[field.key] ?? ""}
                    onChange={(e) => setField(field.key, e.target.value)}
                    autoFocus={field.key === "max_steps_default"}
                  />
                  <div className="limit-hint">{field.hint}</div>
                </div>
              ))}
            </div>

            {error && (
              <div className="notice error" style={{ margin: "16px 0 0" }}>
                {error}
              </div>
            )}

            <div className="settings-actions">
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              <button className="btn btn-quiet" onClick={cancelEdit} disabled={saving}>
                <X size={13} />
                Cancel
              </button>
              <span className="hint" style={{ margin: 0, marginLeft: "auto" }}>
                Applies to the next task
              </span>
            </div>
          </div>
        )}
      </div>

      <p className="compose-note">
        <Pencil size={12} />
        <span>
          Limits are a ceiling, not a target. Hitting one ends the task cleanly and keeps its result; memory demotes the
          weakest facts to the archive tier before it ever deletes them.
        </span>
      </p>
    </div>
  );
}
