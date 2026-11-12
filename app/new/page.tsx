"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Paperclip, X } from "lucide-react";
import { api } from "@/lib/api";

const DRAFT_KEY = "agent-sandbox:new-task-draft";

interface Draft {
  goal: string;
  useSchema: boolean;
  schemaText: string;
  maxStepsInput: string;
}

const DEFAULT_SCHEMA_TEXT = '{\n  "type": "object",\n  "properties": {\n    "answer": { "type": "string" }\n  }\n}';

export default function NewTaskPage() {
  const router = useRouter();
  const hydrated = useRef(false);

  const [goal, setGoal] = useState("");
  const [maxStepsInput, setMaxStepsInput] = useState(""); // empty = use the configured default
  const [useSchema, setUseSchema] = useState(false);
  const [schemaText, setSchemaText] = useState(DEFAULT_SCHEMA_TEXT);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<{ name: string; content: string }[]>([]);
  const [defaultSteps, setDefaultSteps] = useState(12);
  const [hardCap, setHardCap] = useState(25);

  // Hydrate any in-progress draft (switching tabs and back, or a reload,
  // shouldn't lose what you've typed) and fetch the real configured
  // defaults from Settings instead of guessing them.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft: Draft = JSON.parse(raw);
        setGoal(draft.goal ?? "");
        setUseSchema(draft.useSchema ?? false);
        setSchemaText(draft.schemaText ?? DEFAULT_SCHEMA_TEXT);
        setMaxStepsInput(draft.maxStepsInput ?? "");
        if (draft.maxStepsInput || draft.useSchema) setAdvancedOpen(true);
      }
    } catch {
      /* ignore a corrupt draft */
    } finally {
      hydrated.current = true;
    }

    api
      .getSettings()
      .then((s) => {
        setDefaultSteps(Number(s.max_steps_default) || 12);
        setHardCap(Number(s.max_steps_hard_cap) || 25);
      })
      .catch(() => {});
  }, []);

  // Persist the draft on every change, once hydration has happened (so we
  // don't immediately overwrite a just-loaded draft with the initial empty
  // state during the first render).
  useEffect(() => {
    if (!hydrated.current) return;
    const draft: Draft = { goal, useSchema, schemaText, maxStepsInput };
    try {
      if (goal || useSchema || maxStepsInput) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch {
      /* storage can be unavailable (private browsing, quota) - not fatal */
    }
  }, [goal, useSchema, schemaText, maxStepsInput]);

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
        setError("JSON schema isn't valid JSON.");
        return;
      }
    }
    // An empty box means "use the configured default" - never silently send 0.
    const maxSteps = maxStepsInput.trim() === "" ? undefined : Math.max(1, Math.min(hardCap, Number(maxStepsInput)));

    setSubmitting(true);
    try {
      const res = await api.createTask(goal.trim(), maxSteps, schema, documents.length ? documents : undefined);
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
    <div className="page" style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: 16, fontWeight: 400, color: "var(--text-0)", margin: "0 0 20px" }}>new task</h1>

      <label style={{ display: "block", fontSize: 12, color: "var(--text-1)", marginBottom: 6 }}>goal</label>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="e.g. Find the current price of the top 3 cryptocurrencies and compute their combined market cap."
        rows={5}
        style={{ width: "100%", resize: "vertical", marginBottom: 6 }}
      />
      <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 18 }}>
        Draft saved automatically — switching tabs won&apos;t lose it.
      </div>

      <label style={{ display: "block", fontSize: 12, color: "var(--text-1)", marginBottom: 6 }}>
        attach reference documents <span style={{ color: "var(--text-2)" }}>(text files only — optional)</span>
      </label>
      <label
        className="btn"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          marginBottom: documents.length ? 8 : 18,
          cursor: "pointer",
        }}
      >
        <Paperclip size={14} />
        choose files
        <input
          type="file"
          multiple
          accept=".txt,.md,.csv,.json,.log"
          onChange={(e) => addFiles(e.target.files)}
          style={{ display: "none" }}
        />
      </label>
      {documents.length > 0 && (
        <div style={{ marginBottom: 18, fontSize: 12, color: "var(--text-1)" }}>
          {documents.map((d, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "6px 10px",
                flexWrap: "wrap",
                gap: 8,
                background: "var(--bg-2)",
                borderRadius: 3,
                marginBottom: 4,
              }}
            >
              <span>
                {d.name} <span style={{ color: "var(--text-2)" }}>({d.content.length.toLocaleString()} chars)</span>
              </span>
              <button
                aria-label={`remove ${d.name}`}
                onClick={() => setDocuments((prev) => prev.filter((_, j) => j !== i))}
                style={{ background: "none", border: "none", color: "var(--text-2)", cursor: "pointer", padding: 2, display: "flex" }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => setAdvancedOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "none",
          border: "none",
          color: "var(--text-1)",
          fontSize: 12.5,
          padding: "8px 0",
          cursor: "pointer",
          marginBottom: advancedOpen ? 12 : 18,
        }}
      >
        {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        advanced options
      </button>

      {advancedOpen && (
        <div style={{ marginBottom: 18, paddingLeft: 20, borderLeft: "1px solid var(--line-soft)" }}>
          <label style={{ display: "block", fontSize: 12, color: "var(--text-1)", marginBottom: 6 }}>
            max steps for this task
          </label>
          <input
            type="number"
            min={1}
            max={hardCap}
            placeholder={String(defaultSteps)}
            value={maxStepsInput}
            onChange={(e) => setMaxStepsInput(e.target.value)}
            style={{ width: 100 }}
          />
          <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 4, marginBottom: 18 }}>
            Leave blank to use the default ({defaultSteps}, set in Settings). Hard cap is {hardCap}.
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-1)", marginBottom: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={useSchema}
              onChange={(e) => setUseSchema(e.target.checked)}
              style={{ width: "auto" }}
            />
            require the final answer to match a JSON schema
          </label>

          {useSchema && (
            <textarea
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
              rows={8}
              style={{ width: "100%", fontSize: 12.5 }}
            />
          )}
        </div>
      )}

      {error && <div style={{ color: "var(--accent-red)", fontSize: 12.5, marginBottom: 14 }}>{error}</div>}

      <button className="btn btn-primary" disabled={submitting} onClick={submit}>
        {submitting ? "starting..." : "run task"}
      </button>
      <div style={{ fontSize: 11.5, color: "var(--text-2)", marginTop: 10 }}>
        Runs in the background on the server — you can close this tab and come back to it from the task list.
      </div>
    </div>
  );
}
