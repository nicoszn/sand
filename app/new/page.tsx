"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Brain, ChevronDown, ChevronRight, Paperclip, Play, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";

const DRAFT_KEY = "agent-sandbox:new-task-draft";

interface Draft {
  goal: string;
  useSchema: boolean;
  schemaText: string;
}

const DEFAULT_SCHEMA_TEXT = '{\n  "type": "object",\n  "properties": {\n    "answer": { "type": "string" }\n  }\n}';

const SUGGESTIONS = [
  { label: "Compare Postgres pricing", text: "Compare the pricing of three hosted Postgres providers." },
  { label: "Summarise an incident log", text: "Summarise the attached incident log and list the recurring failure modes." },
  { label: "Market cap of top 3 coins", text: "Find the current price of the top 3 cryptocurrencies and compute their combined market cap." },
];

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
    <div className="compose">
      <div className="page-head">
        <div>
          <span className="page-kicker">Compose</span>
          <h1 className="page-title">New task</h1>
          <p className="page-sub">
            Describe the outcome you want. The agent picks its own steps, searches, runs code, and reports back.
          </p>
        </div>
      </div>

      <div className="card prompt-card">
        <div className="prompt-label">
          <label className="field-label" htmlFor="goal">
            What should the agent do?
          </label>
          <span>Draft saved automatically</span>
        </div>
        <textarea
          id="goal"
          className="prompt-input"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          placeholder="e.g. Find the current price of the top 3 cryptocurrencies and compute their combined market cap."
          rows={5}
        />

        <div className="suggest-row">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion.label}
              className="suggest"
              onClick={() => setGoal(suggestion.text)}
              type="button"
              title={suggestion.text}
            >
              <Sparkles size={11} />
              {suggestion.label}
            </button>
          ))}
        </div>

        <div className="prompt-tools">
          <label className="attach">
            <Paperclip size={13} />
            Attach text
            <input
              type="file"
              multiple
              accept=".txt,.md,.csv,.json,.log"
              onChange={(e) => addFiles(e.target.files)}
              style={{ display: "none" }}
            />
          </label>
          <button className="advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)} type="button">
            {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Advanced
          </button>
        </div>

        {documents.length > 0 && (
          <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
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
                style={{ width: "100%", fontSize: 12.5, marginTop: 12, fontFamily: "var(--mono)" }}
              />
            )}
          </div>
        )}

        {error && (
          <div className="notice error" style={{ marginTop: 16, marginBottom: 0 }}>
            {error}
          </div>
        )}

        <div className="prompt-foot">
          <span className="hint">
            Runs in the background — close this tab and come back later. ⌘/Ctrl + Enter to start.
          </span>
          <button className="btn btn-primary" disabled={submitting || !goal.trim()} onClick={submit}>
            <Play size={14} />
            {submitting ? "Starting…" : "Run task"}
          </button>
        </div>
      </div>

      <p className="compose-note">
        <Brain size={12} />
        <span>
          Each task opens with the relevant parts of <a href="/memory">workspace memory</a> already in context, and
          saves what it learns for the next one.
        </span>
      </p>
    </div>
  );
}
