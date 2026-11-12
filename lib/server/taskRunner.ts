/**
 * A simple in-process background worker. Tasks are queued and run by a
 * worker loop that is independent of any HTTP request or SSE connection,
 * so a task keeps running (and its steps keep being written to SQLite)
 * whether or not anyone has the UI open. State lives on globalThis so
 * Next.js's dev-mode module reloading doesn't spawn a second worker.
 *
 * Restart handling: a task stuck in "running" when the process starts was
 * interrupted (redeploy, crash, OOM) mid-task, not failed. Its full message
 * history was persisted after every step, so it's marked "interrupted" (not
 * "failed") and left exactly as it was - nothing resumes it automatically.
 *
 * Conversations: a finished task can be continued by sending another message.
 * That re-queues the same task with its saved history (reason "followup"),
 * while a message sent during a run is picked up by the live loop instead.
 */
import { getDb, now } from "./db";
import { runTask, TurnState } from "./agent";
import { ChatMessage } from "./openrouterClient";
import { backfillEpisodes, recordEpisode } from "./memory";
import {
  MAX_MESSAGE_CHARS,
  addUserMessage,
  countPendingMessages,
  logUserMessageStep,
} from "./messages";

interface TaskSpec {
  goal: string;
  maxSteps: number;
  jsonSchema: Record<string, unknown> | null;
  turn?: TurnState;
}

interface RunnerState {
  queue: string[];
  specs: Map<string, TaskSpec>;
  processing: boolean;
  started: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentSandboxRunner: RunnerState | undefined;
}

function state(): RunnerState {
  if (!globalThis.__agentSandboxRunner) {
    globalThis.__agentSandboxRunner = { queue: [], specs: new Map(), processing: false, started: false };
  }
  return globalThis.__agentSandboxRunner;
}

export function enqueueTask(
  taskId: string,
  goal: string,
  maxSteps: number,
  jsonSchema: Record<string, unknown> | null,
  turn?: TurnState
) {
  const s = state();
  s.specs.set(taskId, { goal, maxSteps, jsonSchema, turn });
  s.queue.push(taskId);
  void processQueue();
}

async function processQueue() {
  const s = state();
  if (s.processing) return; // CONCURRENCY = 1: stays well under the free-tier per-minute limit
  s.processing = true;
  try {
    while (s.queue.length > 0) {
      const taskId = s.queue.shift()!;
      const spec = s.specs.get(taskId);
      s.specs.delete(taskId);
      if (!spec) continue;
      try {
        await runTask(taskId, spec.goal, spec.maxSteps, spec.jsonSchema, spec.turn);
      } catch (e) {
        getDb()
          .prepare("UPDATE tasks SET status = 'failed', result = ? WHERE id = ?")
          .run(`Internal error: ${e instanceof Error ? e.message : e}`, taskId);
      }

      const row = getDb().prepare("SELECT status, result FROM tasks WHERE id = ?").get(taskId) as
        | { status: string; result: string | null }
        | undefined;

      // Finished work becomes memory: later tasks can find it with `recall`.
      if (row && row.result && (row.status === "completed" || row.status === "failed")) {
        try {
          recordEpisode(taskId);
        } catch {
          /* memory is a bonus; never fail a task over it */
        }
      }

      // A message that arrived after the final take of this run would
      // otherwise sit unread - start another turn for it.
      if (countPendingMessages(taskId) > 0 && row?.status !== "running") {
        enqueueFollowUp(taskId);
      }
    }
  } finally {
    s.processing = false;
  }
}

/** Re-queues a task with its saved conversation so the next turn continues it. */
function enqueueFollowUp(taskId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT goal, max_steps, schema_json, conversation_json, step_count FROM tasks WHERE id = ?")
    .get(taskId) as
    | {
        goal: string;
        max_steps: number;
        schema_json: string | null;
        conversation_json: string | null;
        step_count: number;
      }
    | undefined;
  if (!row) return false;

  const jsonSchema = row.schema_json ? JSON.parse(row.schema_json) : null;

  if (!row.conversation_json) {
    // Nothing was ever sent to the model; just run it again from the goal.
    db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(taskId);
    enqueueTask(taskId, row.goal, row.max_steps, jsonSchema);
    return true;
  }

  db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(taskId);
  enqueueTask(taskId, row.goal, row.max_steps, jsonSchema, {
    messages: JSON.parse(row.conversation_json) as ChatMessage[],
    fromStep: row.step_count,
    reason: "followup",
  });
  return true;
}

export type PostMessageResult =
  | { ok: true; status: string; mode: "steering" | "queued" }
  | { ok: false; error: string };

/** Adds a message to a task's conversation and makes sure the agent sees it:
 * live if the task is running, as a new turn otherwise. */
export function postUserMessage(taskId: string, content: string): PostMessageResult {
  const db = getDb();
  const row = db.prepare("SELECT status, step_count FROM tasks WHERE id = ?").get(taskId) as
    | { status: string; step_count: number }
    | undefined;
  if (!row) return { ok: false, error: "task not found" };

  const trimmed = content.trim();
  if (trimmed.length === 0) return { ok: false, error: "message is empty" };
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `message is too long (max ${MAX_MESSAGE_CHARS.toLocaleString()} characters)` };
  }

  addUserMessage(taskId, trimmed);
  logUserMessageStep(taskId, row.step_count, trimmed);
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now(), taskId);

  if (row.status === "running") {
    // The live loop claims unconsumed messages at its next step.
    db.prepare("UPDATE tasks SET has_pending_input = 1 WHERE id = ?").run(taskId);
    return { ok: true, status: "running", mode: "steering" };
  }

  if (row.status === "queued") {
    // Already scheduled; its first step will pick the message up.
    return { ok: true, status: "queued", mode: "queued" };
  }

  enqueueFollowUp(taskId);
  return { ok: true, status: "queued", mode: "queued" };
}

/** Manually resume a task that's "interrupted" or was permanently failed
 * after exhausting its auto-resume budget. Used by POST /api/tasks/[id]/resume. */
export function resumeTask(taskId: string): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  const row = db
    .prepare("SELECT goal, max_steps, schema_json, conversation_json, step_count, status FROM tasks WHERE id = ?")
    .get(taskId) as
    | {
        goal: string;
        max_steps: number;
        schema_json: string | null;
        conversation_json: string | null;
        step_count: number;
        status: string;
      }
    | undefined;

  if (!row) return { ok: false, error: "task not found" };
  if (!["interrupted", "failed"].includes(row.status)) {
    return { ok: false, error: `cannot resume a task in status "${row.status}"` };
  }
  if (!row.conversation_json) {
    return {
      ok: false,
      error: "no saved conversation for this task - nothing to resume from, start a new task instead",
    };
  }

  db.prepare("UPDATE tasks SET status = 'queued', result = NULL WHERE id = ?").run(taskId);

  const messages = JSON.parse(row.conversation_json) as ChatMessage[];
  enqueueTask(taskId, row.goal, row.max_steps, row.schema_json ? JSON.parse(row.schema_json) : null, {
    messages,
    fromStep: row.step_count,
    reason: "resume",
  });
  return { ok: true };
}

/** Call once at server startup (see instrumentation.ts). */
export function initTaskRunner() {
  const s = state();
  if (s.started) return;
  s.started = true;

  const db = getDb();

  // Tasks stuck "running" were cut off mid-task by this restart. Mark them
  // "interrupted" and stop there - no auto-resume. They keep their saved
  // conversation (conversation_json) so a person can resume or cancel them
  // from the UI whenever they choose.
  const interrupted = db.prepare("SELECT id FROM tasks WHERE status = 'running'").all() as { id: string }[];
  for (const row of interrupted) {
    db.prepare("UPDATE tasks SET status = 'interrupted', resume_count = resume_count + 1 WHERE id = ?").run(row.id);
  }

  // Tasks left "queued" never got a chance to start - there's no partial
  // state or consent question here, so these resume processing normally;
  // that's just the queue doing its job, not "resuming" a task.
  const queued = db.prepare("SELECT id, goal, max_steps, schema_json FROM tasks WHERE status = 'queued'").all() as {
    id: string;
    goal: string;
    max_steps: number;
    schema_json: string | null;
  }[];
  for (const row of queued) {
    enqueueTask(row.id, row.goal, row.max_steps, row.schema_json ? JSON.parse(row.schema_json) : null);
  }

  // Databases that predate memory get their finished tasks indexed now.
  try {
    backfillEpisodes();
  } catch {
    /* best effort */
  }
}
