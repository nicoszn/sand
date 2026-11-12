"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function NewTaskPage() {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [maxSteps, setMaxSteps] = useState(12);
  const [useSchema, setUseSchema] = useState(false);
  const [schemaText, setSchemaText] = useState('{\n  "type": "object",\n  "properties": {\n    "answer": { "type": "string" }\n  }\n}');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<{ name: string; content: string }[]>([]);

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
    setSubmitting(true);
    try {
      const res = await api.createTask(goal.trim(), maxSteps, schema, documents.length ? documents : undefined);
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
        style={{ width: "100%", resize: "vertical", marginBottom: 18 }}
      />

      <div style={{ display: "flex", gap: 24, marginBottom: 18, flexWrap: "wrap" }}>
        <div>
          <label style={{ display: "block", fontSize: 12, color: "var(--text-1)", marginBottom: 6 }}>
            max steps
          </label>
          <input
            type="number"
            min={1}
            max={25}
            value={maxSteps}
            onChange={(e) => setMaxSteps(Number(e.target.value))}
            style={{ width: 100 }}
          />
          <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 4 }}>hard cap is set in settings</div>
        </div>
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
          style={{ width: "100%", marginBottom: 18, fontSize: 12.5 }}
        />
      )}

      <label style={{ display: "block", fontSize: 12, color: "var(--text-1)", marginBottom: 6 }}>
        attach reference documents (text files only - optional)
      </label>
      <input
        type="file"
        multiple
        accept=".txt,.md,.csv,.json,.log"
        onChange={(e) => addFiles(e.target.files)}
        style={{ width: "100%", marginBottom: documents.length ? 8 : 18 }}
      />
      {documents.length > 0 && (
        <div style={{ marginBottom: 18, fontSize: 12, color: "var(--text-1)" }}>
          {documents.map((d, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", flexWrap: "wrap", gap: 8 }}>
              <span>
                {d.name} ({d.content.length.toLocaleString()} chars)
              </span>
              <button
                className="btn"
                style={{ padding: "2px 8px", fontSize: 11 }}
                onClick={() => setDocuments((prev) => prev.filter((_, j) => j !== i))}
              >
                remove
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ color: "var(--accent-red)", fontSize: 12.5, marginBottom: 14 }}>{error}</div>
      )}

      <button className="btn btn-primary" disabled={submitting} onClick={submit}>
        {submitting ? "starting..." : "run task"}
      </button>
      <div style={{ fontSize: 11.5, color: "var(--text-2)", marginTop: 10 }}>
        Runs in the background on the server — you can close this tab and come back to it from the task list.
      </div>
    </div>
  );
}
