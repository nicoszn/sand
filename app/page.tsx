"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Inbox, Plus } from "lucide-react";
import { api, Task, timeAgo } from "@/lib/api";
import { StatusDot } from "@/components/StatusDot";

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await api.listTasks();
      setTasks(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks");
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, []);

  const act = async (id: string, action: "resume" | "cancel", e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusyId(id);
    try {
      if (action === "resume") await api.resumeTask(id);
      else await api.cancelTask(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} task`);
    } finally {
      setBusyId(null);
    }
  };

  const interrupted = tasks?.filter((t) => t.status === "interrupted") ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Tasks</h1>
          <p className="page-sub">Work the agent has queued, is running now, or has finished.</p>
        </div>
        <Link href="/new" className="btn btn-primary">
          <Plus size={15} />
          New task
        </Link>
      </div>

      {error && (
        <div className="notice error">
          <AlertTriangle size={16} />
          <div>Can&apos;t reach the server: {error}</div>
        </div>
      )}

      {interrupted.length > 0 && (
        <div className="notice">
          <AlertTriangle size={16} />
          <div>
            <strong>
              {interrupted.length} task{interrupted.length > 1 ? "s were" : " was"} interrupted
            </strong>{" "}
            by a restart. Their progress is saved — resume or cancel {interrupted.length > 1 ? "them" : "it"} below.
          </div>
        </div>
      )}

      {tasks === null && !error && (
        <div className="card empty">
          <span className="empty-icon">
            <Inbox size={19} />
          </span>
          Loading tasks…
        </div>
      )}

      {tasks !== null && tasks.length === 0 && (
        <div className="card empty">
          <span className="empty-icon">
            <Inbox size={19} />
          </span>
          <strong>No tasks yet</strong>
          <span>Give the agent a goal and it will work through it in the background.</span>
          <Link href="/new" className="btn btn-primary" style={{ marginTop: 8 }}>
            <Plus size={15} />
            Start a task
          </Link>
        </div>
      )}

      {tasks && tasks.length > 0 && (
        <div className="card task-list">
          {tasks.map((t) => (
            <Link key={t.id} href={`/tasks/${t.id}`} className="task-row">
              <div style={{ minWidth: 0 }}>
                <div className="task-goal">{t.goal}</div>
                <div className="task-meta">
                  <span>
                    {t.step_count}/{t.max_steps} steps
                  </span>
                  <span className="sep" />
                  <span>{(t.prompt_tokens + t.completion_tokens).toLocaleString()} tokens</span>
                  <span className="sep" />
                  <span>{timeAgo(t.created_at)}</span>
                  {t.status === "interrupted" && t.resume_count > 0 && (
                    <>
                      <span className="sep" />
                      <span>interrupted {t.resume_count}×</span>
                    </>
                  )}
                </div>
              </div>

              <div className="task-actions">
                <StatusDot status={t.status} />
                {t.status === "interrupted" && (
                  <>
                    <button
                      className="btn btn-sm"
                      disabled={busyId === t.id}
                      onClick={(e) => act(t.id, "cancel", e)}
                    >
                      Cancel
                    </button>
                    {!!t.has_conversation && (
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={busyId === t.id}
                        onClick={(e) => act(t.id, "resume", e)}
                      >
                        {busyId === t.id ? "…" : "Resume"}
                      </button>
                    )}
                  </>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
