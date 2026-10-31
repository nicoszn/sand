"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, Task, timeAgo } from "@/lib/api";
import { StatusDot } from "@/components/StatusDot";

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.listTasks();
        if (!cancelled) {
          setTasks(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load tasks");
      }
    };
    load();
    const interval = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div style={{ padding: "28px 36px", maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 20 }}>
        <h1 style={{ fontSize: 16, fontWeight: 400, color: "var(--text-0)", margin: 0 }}>tasks</h1>
        <Link href="/new" className="btn btn-primary" style={{ textDecoration: "none" }}>
          new task
        </Link>
      </div>

      {error && (
        <div className="panel" style={{ padding: 14, borderColor: "var(--accent-red)", color: "var(--accent-red)", marginBottom: 16, fontSize: 12.5 }}>
          Can't reach the backend: {error}. Check that the API service is running and BACKEND_URL is set.
        </div>
      )}

      {tasks === null && !error && <div style={{ color: "var(--text-2)" }}>loading...</div>}

      {tasks !== null && tasks.length === 0 && (
        <div className="panel" style={{ padding: 32, textAlign: "center", color: "var(--text-2)" }}>
          No tasks yet. Give the agent something to do.
          <div style={{ marginTop: 14 }}>
            <Link href="/new" className="btn btn-primary" style={{ textDecoration: "none" }}>
              new task
            </Link>
          </div>
        </div>
      )}

      {tasks && tasks.length > 0 && (
        <div className="panel">
          {tasks.map((t, i) => (
            <Link
              key={t.id}
              href={`/tasks/${t.id}`}
              className="row-hover"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "12px 16px",
                borderTop: i === 0 ? "none" : "1px solid var(--line-soft)",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "var(--text-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.goal}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-2)", marginTop: 3 }}>
                  step {t.step_count}/{t.max_steps} · {t.prompt_tokens + t.completion_tokens} tokens · {timeAgo(t.created_at)}
                </div>
              </div>
              <StatusDot status={t.status} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
