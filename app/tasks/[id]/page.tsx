"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { AlertCircle, ArrowLeft, CheckCircle2, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { api, MemoryRef, Step, Task, TaskDocumentMeta, timeAgo } from "@/lib/api";
import { StatusDot } from "@/components/StatusDot";
import { ActivityItem, groupSteps } from "@/components/ActivityItem";
import { CopyButton } from "@/components/CopyButton";

/** "1.8s", "2m 10s" - read off the task's own timestamps. */
function elapsed(task: Task): string {
  const seconds = Math.max(0, task.updated_at - task.created_at);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

/** Structured answers get a formatted code block instead of a wall of text. */
function structured(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object") return null;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const taskId = params.id;
  const [task, setTask] = useState<Task | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [documents, setDocuments] = useState<TaskDocumentMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composerNote, setComposerNote] = useState<string | null>(null);
  // The step log is diagnostics, not the answer: keep it closed until asked for.
  const [showActivity, setShowActivity] = useState(false);
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
    // Nothing changes for these without a person acting (resume/cancel or
    // another message), which already refetches.
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

  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setComposerNote(null);
    try {
      const result = await api.sendMessage(taskId, content);
      setDraft("");
      setComposerNote(
        result.mode === "steering"
          ? "Sent — the agent picks this up at its next step."
          : "Queued as the next turn of this task."
      );
      const { task: t, steps: s } = await api.getTask(taskId);
      setTask(t);
      setSteps(s);
    } catch (e) {
      setComposerNote(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
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
  const entries = groupSteps(steps);
  const jsonResult = task.result ? structured(task.result) : null;
  const tokens = task.prompt_tokens + task.completion_tokens;
  const replies = Math.max(0, (task.message_count ?? 1) - 1);

  let refs: MemoryRef[] = [];
  try {
    refs = task.memory_refs_json ? (JSON.parse(task.memory_refs_json) as MemoryRef[]) : [];
  } catch {
    refs = [];
  }
  const priorTasks = refs.filter((ref) => ref.type === "task").length;
  const priorFacts = refs.filter((ref) => ref.type === "memory").length;

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
            {task.step_count} {task.step_count === 1 ? "step" : "steps"}
          </span>
          <span className="sep" />
          <span>{tokens.toLocaleString()} tokens</span>
          <span className="sep" />
          <span>Started {timeAgo(task.created_at)}</span>
          {replies > 0 && (
            <>
              <span className="sep" />
              <span>
                {replies} follow-up{replies > 1 ? "s" : ""}
              </span>
            </>
          )}
          {task.resume_count > 0 && (
            <>
              <span className="sep" />
              <span>Resumed {task.resume_count}× after restart</span>
            </>
          )}
        </div>

        {refs.length > 0 && (
          <div className="hero-memory">
            <Sparkles size={13} />
            <span>
              Built on{" "}
              {priorTasks > 0 && (
                <strong>
                  {priorTasks} earlier task{priorTasks > 1 ? "s" : ""}
                </strong>
              )}
              {priorTasks > 0 && priorFacts > 0 && " and "}
              {priorFacts > 0 && (
                <strong>
                  {priorFacts} saved fact{priorFacts > 1 ? "s" : ""}
                </strong>
              )}{" "}
              from <Link href="/memory">memory</Link>
            </span>
          </div>
        )}

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
        <section className="card result" data-tone={task.status === "completed" ? "done" : "failed"}>
          <div className="result-head">
            <span className="result-badge">
              {task.status === "completed" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
            </span>
            <div className="result-heading">
              <div className="result-title">{replies > 0 ? "Latest result" : "Result"}</div>
              <div className="result-sub">
                {task.status === "completed"
                  ? "Completed"
                  : task.status === "cancelled"
                    ? "Cancelled"
                    : "Stopped"}
                {" · "}
                {task.step_count} {task.step_count === 1 ? "step" : "steps"}
                {replies > 0 && ` · reply ${replies + 1}`}
              </div>
            </div>
            <CopyButton text={task.result} />
          </div>

          {jsonResult ? (
            <div className="result-body result-json">
              <pre>{jsonResult}</pre>
            </div>
          ) : (
            <div className="result-body markdown-body">
              <ReactMarkdown>{task.result}</ReactMarkdown>
            </div>
          )}

          <div className="result-foot">
            <span>{tokens.toLocaleString()} tokens</span>
            <span className="sep" />
            <span>{elapsed(task)}</span>
            <span className="sep" />
            <span>Finished {timeAgo(task.updated_at)}</span>
          </div>
        </section>
      )}

      <div className="section-head">
        <span className="section-label">Activity</span>
        <button className="btn btn-sm" onClick={() => setShowActivity((open) => !open)} aria-expanded={showActivity}>
          {showActivity
            ? "Hide"
            : `Show ${entries.length} ${entries.length === 1 ? "action" : "actions"}`}
        </button>
      </div>

      {active && !showActivity && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="working">
            <span className="dot-pulse">
              <i />
              <i />
              <i />
            </span>
            Working…
          </div>
        </div>
      )}

      {showActivity && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div ref={logRef} className="activity">
            {entries.length === 0 && (
              <div style={{ padding: "18px 16px", color: "var(--ink-3)", fontSize: 12.5 }}>
                Waiting for the first step…
              </div>
            )}
            {entries.map((entry) => (
              <ActivityItem key={entry.id} entry={entry} />
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
      )}

      <div className="card composer">
        <label className="field-label" htmlFor="follow-up">
          {replies > 0 ? "Reply again" : "Reply or add to this task"}
        </label>
        <textarea
          id="follow-up"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
          }}
          placeholder="e.g. Now compare only the top two and cite each source. Or: keep going, but fetch the official page this time."
        />
        <div className="composer-foot">
          <span className="hint" style={{ margin: 0 }}>
            {composerNote ??
              (active
                ? "The agent is working — your message reaches it at the next step."
                : "Continues the same conversation with all of its history. ⌘/Ctrl + Enter to send.")}
          </span>
          <button className="btn btn-primary" onClick={send} disabled={sending || !draft.trim()}>
            <Send size={14} />
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </>
  );
}
