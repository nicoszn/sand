"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
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

  // Initial load
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
    // Nothing will change for these without a person taking an action
    // (resume/cancel), which already refetches the task - no need for a
    // live connection sitting open.
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
    return <div style={{ padding: 36, color: "var(--accent-red)" }}>{error}</div>;
  }
  if (!task) {
    return <div style={{ padding: 36, color: "var(--text-2)" }}>loading...</div>;
  }

  const active = task.status === "queued" || task.status === "running";
  const cancellable = active || task.status === "interrupted";
  const canResume = (task.status === "interrupted" || task.status === "failed") && !!task.has_conversation;

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <h1 style={{ fontSize: 15, fontWeight: 400, color: "var(--text-0)", margin: 0, lineHeight: 1.5, flex: "1 1 200px", minWidth: 0, wordBreak: "break-word" }}>
            {task.goal}
          </h1>
          {cancellable && (
            <button className="btn" onClick={cancel} style={{ flexShrink: 0 }}>
              cancel
            </button>
          )}
          {canResume && (
            <button className="btn btn-primary" onClick={resume} disabled={resuming} style={{ flexShrink: 0 }}>
              {resuming ? "resuming..." : "resume"}
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 8, fontSize: 12, color: "var(--text-2)", flexWrap: "wrap" }}>
          <StatusDot status={task.status} />
          <span>step {task.step_count}/{task.max_steps}</span>
          <span>{task.prompt_tokens + task.completion_tokens} tokens</span>
          <span>started {timeAgo(task.created_at)}</span>
          {task.resume_count > 0 && <span>resumed {task.resume_count}x after restart</span>}
        </div>
        {documents.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-2)" }}>
            documents: {documents.map((d) => `${d.name} (${d.size.toLocaleString()} chars)`).join(", ")}
          </div>
        )}
      </div>

      {task.status === "interrupted" && (
        <div className="panel" style={{ padding: 14, marginBottom: 18, borderColor: "var(--accent-blue)", color: "var(--text-1)", fontSize: 12.5 }}>
          This task was interrupted by a server restart partway through. Its progress is saved - choose{" "}
          <strong style={{ color: "var(--text-0)" }}>resume</strong> to continue from where it left off, or{" "}
          <strong style={{ color: "var(--text-0)" }}>cancel</strong> to stop it for good.
        </div>
      )}

      {task.result && (
        <div
          className="panel"
          style={{
            padding: 14,
            marginBottom: 18,
            maxWidth: "100%",
            overflowX: "hidden",
            borderColor: task.status === "completed" ? "var(--accent-green)" : "var(--accent-red)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--text-2)" }}>result</span>
            <CopyButton text={task.result} />
          </div>
          <div className="markdown-body" style={{ fontSize: 13 }}>
            <ReactMarkdown>{task.result}</ReactMarkdown>
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: "var(--text-2)", marginBottom: 6 }}>log</div>
      <div
        ref={logRef}
        className="panel"
        style={{ padding: "4px 14px", maxHeight: 520, overflowY: "auto", overflowX: "hidden" }}
      >
        {steps.length === 0 && (
          <div style={{ color: "var(--text-2)", padding: "10px 0" }}>waiting for the first step...</div>
        )}
        {steps.map((s, i) => (
          <StepItem key={i} step={s} />
        ))}
        {active && (
          <div style={{ display: "flex", gap: 10, fontSize: 12.5, color: "var(--text-2)", padding: "6px 0" }}>
            <div style={{ width: 24 }} />
            <div>working…</div>
          </div>
        )}
      </div>
    </div>
  );
}
