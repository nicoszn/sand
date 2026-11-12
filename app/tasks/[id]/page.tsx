"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, RotateCcw, X } from "lucide-react";
import { api, Step, Task, TaskDocumentMeta, timeAgo } from "@/lib/api";
import { StatusDot } from "@/components/StatusDot";
import { StepItem } from "@/components/StepItem";
import { CopyButton } from "@/components/CopyButton";

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const taskId = params.id;
  const [task, setTask] = useState<Task | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [documents, setDocuments] = useState<TaskDocumentMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .getTask(taskId)
      .then(({ task, steps, documents }) => {
        setTask(task);
        setSteps(steps);
        setDocuments(documents);
      })
      .catch((e) => setError(e.message));
  }, [taskId]);

  // Live updates: SSE while the task is active, with a polling fallback.
  useEffect(() => {
    if (!task) return;
    // Nothing changes for these without a person acting (resume/cancel),
    // which already refetches - so don't hold a connection open.
    if (["completed", "failed", "cancelled", "interrupted"].includes(task.status)) return;

    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    let fellBack = false;

    es.addEventListener("step", (ev) => {
      const step: Step = JSON.parse((ev as MessageEvent).data);
      setSteps((prev) => [...prev, step]);
    });
    es.addEventListener("done", () => {
      api.getTask(taskId).then(({ task }) => setTask(task));
      es.close();
    });
    es.onerror = () => {
      fellBack = true;
      es.close();
    };

    const poll = setInterval(async () => {
      if (!fellBack) return;
      try {
        const { task: t, steps: s } = await api.getTask(taskId);
        setTask(t);
        setSteps(s);
        if (["completed", "failed", "cancelled"].includes(t.status)) clearInterval(poll);
      } catch {
        /* keep trying */
      }
    }, 2500);

    return () => {
      es.close();
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, task?.status]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [steps.length]);

  const cancel = async () => {
    await api.cancelTask(taskId);
    const { task: t } = await api.getTask(taskId);
    setTask(t);
  };

  const resume = async () => {
    setResuming(true);
    try {
      await api.resumeTask(taskId);
      const { task: t, steps: s } = await api.getTask(taskId);
      setTask(t);
      setSteps(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to resume task");
    } finally {
      setResuming(false);
    }
  };

  if (error) {
    return (
      <>
        <Link href="/" className="back-link">
          <ArrowLeft size={14} /> All tasks
        </Link>
        <div className="notice error">{error}</div>
      </>
    );
  }

  if (!task) {
    return <div className="card empty">Loading task…</div>;
  }

  const active = task.status === "queued" || task.status === "running";
  const cancellable = active || task.status === "interrupted";
  const canResume = (task.status === "interrupted" || task.status === "failed") && !!task.has_conversation;

  return (
    <>
      <Link href="/" className="back-link">
        <ArrowLeft size={14} /> All tasks
      </Link>

      <div className="card hero">
        <div className="hero-top">
          <h1 className="hero-goal">{task.goal}</h1>
          <div className="hero-actions">
            {cancellable && (
              <button className="btn" onClick={cancel}>
                <X size={14} />
                Cancel
              </button>
            )}
            {canResume && (
              <button className="btn btn-primary" onClick={resume} disabled={resuming}>
                <RotateCcw size={14} />
                {resuming ? "Resuming…" : "Resume"}
              </button>
            )}
          </div>
        </div>

        <div className="hero-meta">
          <StatusDot status={task.status} />
          <span className="sep" />
          <span>
            Step {task.step_count} of {task.max_steps}
          </span>
          <span className="sep" />
          <span>{(task.prompt_tokens + task.completion_tokens).toLocaleString()} tokens</span>
          <span className="sep" />
          <span>Started {timeAgo(task.created_at)}</span>
          {task.resume_count > 0 && (
            <>
              <span className="sep" />
              <span>Resumed {task.resume_count}× after restart</span>
            </>
          )}
        </div>

        {documents.length > 0 && (
          <div className="hero-docs">
            Attached: {documents.map((d) => `${d.name} (${d.size.toLocaleString()} chars)`).join(" · ")}
          </div>
        )}
      </div>

      {task.status === "interrupted" && (
        <div className="notice">
          <RotateCcw size={16} />
          <div>
            This task was cut off by a server restart. Its progress is saved — <strong>resume</strong> to carry on
            from the last step, or <strong>cancel</strong> to stop it for good.
          </div>
        </div>
      )}

      {task.result && (
        <div className="card result" data-tone={task.status === "completed" ? "completed" : "failed"}>
          <div className="result-head">
            <span className="section-label">Result</span>
            <CopyButton text={task.result} />
          </div>
          <div className="result-body markdown-body">
            <ReactMarkdown>{task.result}</ReactMarkdown>
          </div>
        </div>
      )}

      <div className="section-head">
        <span className="section-label">Activity</span>
        <span className="section-meta">
          {steps.length} {steps.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div ref={logRef} className="timeline">
          {steps.length === 0 && (
            <div style={{ padding: "18px 14px", color: "var(--ink-3)", fontSize: 12.5 }}>
              Waiting for the first step…
            </div>
          )}
          {steps.map((s, i) => (
            <StepItem key={`${s.step_index}-${s.kind}-${i}`} step={s} />
          ))}
        </div>
        {active && (
          <div className="working">
            <span className="dot-pulse">
              <i />
              <i />
              <i />
            </span>
            Working…
          </div>
        )}
      </div>
    </>
  );
}
