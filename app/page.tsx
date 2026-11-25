"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Inbox, Plus } from "lucide-react";
import { api, Task, TaskStatus, timeAgo } from "@/lib/api";
import { StatusDot } from "@/components/StatusDot";

const DIST_ORDER: TaskStatus[] = ["running", "queued", "interrupted", "failed", "completed"];

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

  const list = tasks ?? [];
  const count = (status: TaskStatus) => list.filter((t) => t.status === status).length;
  const interrupted = list.filter((t) => t.status === "interrupted");
  const total = list.filter((t) => t.status !== "cancelled").length;

  const stats = [
    { key: "running", label: "Running", value: count("running"), note: "in flight now" },
    { key: "queued", label: "Queued", value: count("queued"), note: "waiting to start" },
    { key: "completed", label: "Completed", value: count("completed"), note: "finished cleanly" },
    { key: "interrupted", label: "Needs you", value: interrupted.length, note: "interrupted, resumable" },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <span className="page-kicker">Overview</span>
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

      {tasks !== null && tasks.length > 0 && (
        <section className="card overview">
          <div className="stat-row">
            {stats.map((s) => (
              <div key={s.key} className="stat" data-tone={s.key}>
                <span className="stat-label">
                  <i />
                  {s.label}
                </span>
                <span className="stat-value">{s.value}</span>
                <span className="stat-note">{s.note}</span>
              </div>
            ))}
          </div>
          <div className="overview-foot">
            <div className="dist" title="Task mix across all recorded tasks">
              {DIST_ORDER.map((status) => {
                const n = count(status);
                if (n === 0) return null;
                return (
                  <span
                    key={status}
                    className="dist-seg"
                    data-tone={status}
                    style={{ width: `${(n / Math.max(1, total)) * 100}%` }}
                  />
                );
              })}
            </div>
            <span className="dist-note">
              {list.length} task{list.length === 1 ? "" : "s"} · refreshes every 3s
            </span>
          </div>
        </section>
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

      {tasks !== null && tasks.length > 0 && (
        <section className="card task-list">
          <div className="list-head">
            <span className="section-label">All tasks</span>
            <span className="list-head-count">
              {tasks.length} recorded · newest first
            </span>
          </div>
          {tasks.map((t) => (
            <Link key={t.id} href={`/tasks/${t.id}`} className="task-row" data-status={t.status}>
              <div className="task-main">
                <span className="task-goal">{t.goal}</span>
                <div className="task-meta">
                  <span>
                    {t.step_count}/{t.max_steps} steps
                  </span>
                  <span className="sep" />
                  <span>{(t.prompt_tokens + t.completion_tokens).toLocaleString()} tokens</span>
                  {t.message_count > 1 && (
                    <>
                      <span className="sep" />
                      <span>
                        {t.message_count - 1} follow-up{t.message_count > 2 ? "s" : ""}
                      </span>
                    </>
                  )}
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
                <ArrowUpRight size={14} className="task-open" aria-hidden />
              </div>
            </Link>
          ))}
        </section>
      )}
    </>
  );
}
