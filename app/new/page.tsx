"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Paperclip, Play, X } from "lucide-react";
import { api } from "@/lib/api";

const DRAFT_KEY = "agent-sandbox:new-task-draft";

interface Draft {
  goal: string;
  useSchema: boolean;
  schemaText: string;
}

const DEFAULT_SCHEMA_TEXT = '{\n  "type": "object",\n  "properties": {\n    "answer": { "type": "string" }\n  }\n}';

export default function NewTaskPage() {
  const router = useRouter();
  const hydrated = useRef(false);

  const [goal, setGoal] = useState("");
  const [useSchema, setUseSchema] = useState(false);
  const [schemaText, setSchemaText] = useState(DEFAULT_SCHEMA_TEXT);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<{ name: string; content: string }[]>([]);

  // Restore an in-progress draft; switching tabs or reloading shouldn't lose it.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft: Draft = JSON.parse(raw);
        setGoal(draft.goal ?? "");
        setUseSchema(draft.useSchema ?? false);
        setSchemaText(draft.schemaText ?? DEFAULT_SCHEMA_TEXT);
        if (draft.useSchema) setAdvancedOpen(true);
      }
    } catch {
      /* ignore a corrupt draft */
    } finally {
      hydrated.current = true;
    }
  }, []);

  // Persist on change, but only after hydration so the first render doesn't
  // wipe the just-loaded draft.
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      if (goal || useSchema) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ goal, useSchema, schemaText } satisfies Draft));
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch {
      /* storage can be unavailable (private browsing, quota) */
    }
  }, [goal, useSchema, schemaText]);

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const read = Array.from(files).map(
      (f) =>
        new Promise<{ name: string; content: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: f.name, content: String(reader.result ?? "") });
          reader.onerror = reject;
          reader.readAsText(f);
        })
    );
    const results = await Promise.all(read).catch(() => []);
    setDocuments((prev) => [...prev, ...results]);
  };

  const submit = async () => {
    setError(null);
    if (!goal.trim()) {
      setError("Describe what the agent should do.");
      return;
    }
    let schema: object | null = null;
    if (useSchema) {
      try {
        schema = JSON.parse(schemaText);
      } catch {
        setError("The JSON schema isn't valid JSON.");
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await api.createTask(goal.trim(), undefined, schema, documents.length ? documents : undefined);
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      router.push(`/tasks/${res.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create task");
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">New task</h1>
          <p className="page-sub">
            Describe the outcome you want. The agent picks its own steps, searches, runs code, and reports back.
          </p>
        </div>
      </div>

      <div className="card card-pad">
        <label className="field-label" htmlFor="goal">
          What should the agent do?
        </label>
        <textarea
          id="goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Find the current price of the top 3 cryptocurrencies and compute their combined market cap."
          rows={6}
        />
        <div className="hint">Your draft is saved automatically, so switching tabs won&apos;t lose it.</div>

        <div style={{ marginTop: 24 }}>
          <div className="field-label">
            Reference documents <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>— optional, plain text</span>
          </div>

          <label className="attach">
            <Paperclip size={14} />
            Attach files
            <input
              type="file"
              multiple
              accept=".txt,.md,.csv,.json,.log"
              onChange={(e) => addFiles(e.target.files)}
              style={{ display: "none" }}
            />
          </label>

          {documents.length > 0 && (
            <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
              {documents.map((d, i) => (
                <div key={`${d.name}-${i}`} className="chip">
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {d.name}
                    <span style={{ color: "var(--ink-3)" }}> · {d.content.length.toLocaleString()} chars</span>
                  </span>
                  <button
                    className="chip-x"
                    aria-label={`Remove ${d.name}`}
                    onClick={() => setDocuments((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginTop: 20 }}>
          <button className="advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
            {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Advanced
          </button>

          {advancedOpen && (
            <div className="advanced-panel">
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12.5,
                  color: "var(--ink-2)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={useSchema}
                  onChange={(e) => setUseSchema(e.target.checked)}
                  style={{ width: "auto" }}
                />
                Require the final answer to match a JSON schema
              </label>
              {useSchema && (
                <textarea
                  value={schemaText}
                  onChange={(e) => setSchemaText(e.target.value)}
                  rows={7}
                  style={{ width: "100%", fontSize: 12.5, marginTop: 12 }}
                />
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="notice error" style={{ marginTop: 18, marginBottom: 0 }}>
            {error}
          </div>
        )}

        <div className="form-actions">
          <button className="btn btn-primary" disabled={submitting} onClick={submit}>
            <Play size={14} />
            {submitting ? "Starting…" : "Run task"}
          </button>
          <span className="hint" style={{ margin: 0 }}>
            Runs in the background — you can close this tab and come back later.
          </span>
        </div>
      </div>
    </div>
  );
}
