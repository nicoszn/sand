/**
 * A simple in-process background worker. Tasks are queued and run by a
 * worker loop that is independent of any HTTP request or SSE connection,
 * so a task keeps running (and its steps keep being written to SQLite)
 * whether or not anyone has the UI open. State lives on globalThis so
 * Next.js's dev-mode module reloading doesn't spawn a second worker.
 *
 * Restart handling: a task stuck in "running" when the process starts was
 * interrupted (redeploy, crash, OOM) mid-task, not failed. Its full message
 * history was persisted after every step (see agent.ts persistConversation),
 * so instead of discarding it, this module resumes it from exactly where it
 * left off - same conversation, same step count, picking back up with the
 * next model call. A task is only given up on (marked "failed") after
 * MAX_RESUMES consecutive restarts, so a task that's crash-looping the
 * whole server doesn't retry forever.
 */
import { getDb } from "./db";
import { runTask, ResumeState } from "./agent";
import { ChatMessage } from "./openrouterClient";
import { config } from "@/lib/config";

interface TaskSpec {
  goal: string;
  maxSteps: number;
  jsonSchema: Record<string, unknown> | null;
  resume?: ResumeState;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentSandboxRunner:
    | {
        queue: string[];
        specs: Map<string, TaskSpec>;
        processing: boolean;
        started: boolean;
      }
    | undefined;
}

function state() {
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
  resume?: ResumeState
) {
  const s = state();
  s.specs.set(taskId, { goal, maxSteps, jsonSchema, resume });
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
        await runTask(taskId, spec.goal, spec.maxSteps, spec.jsonSchema, spec.resume);
      } catch (e) {
        const db = getDb();
        db.prepare("UPDATE tasks SET status = 'failed', result = ? WHERE id = ?").run(
          `Internal error: ${e instanceof Error ? e.message : e}`,
          taskId
        );
      }
    }
  } finally {
    s.processing = false;
  }
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
  });
  return { ok: true };
}

interface InterruptedRow {
  id: string;
  goal: string;
  max_steps: number;
  schema_json: string | null;
  conversation_json: string | null;
  step_count: number;
  resume_count: number;
}

/** Call once at server startup (see instrumentation.ts). */
export function initTaskRunner() {
  const s = state();
  if (s.started) return;
  s.started = true;

  const db = getDb();

  const interrupted = db
    .prepare(
      "SELECT id, goal, max_steps, schema_json, conversation_json, step_count, resume_count FROM tasks WHERE status = 'running'"
    )
    .all() as InterruptedRow[];

  for (const row of interrupted) {
    if (row.resume_count >= config.maxTaskResumes) {
      db.prepare("UPDATE tasks SET status = 'failed', result = ? WHERE id = ?").run(
        `Stopped: interrupted by a server restart ${config.maxTaskResumes} times in a row - giving up on automatic resume. Use the resume button to try again manually.`,
        row.id
      );
      continue;
    }

    db.prepare("UPDATE tasks SET status = 'interrupted', resume_count = resume_count + 1 WHERE id = ?").run(row.id);

    const jsonSchema = row.schema_json ? JSON.parse(row.schema_json) : null;
    if (row.conversation_json) {
      // Had made at least one model call before the restart - resume from there.
      const messages = JSON.parse(row.conversation_json) as ChatMessage[];
      db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(row.id);
      enqueueTask(row.id, row.goal, row.max_steps, jsonSchema, { messages, fromStep: row.step_count });
    } else {
      // Interrupted before the first model response - nothing to resume, just restart it.
      db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(row.id);
      enqueueTask(row.id, row.goal, row.max_steps, jsonSchema);
    }
  }

  const queued = db.prepare("SELECT id, goal, max_steps, schema_json FROM tasks WHERE status = 'queued'").all() as {
    id: string;
    goal: string;
    max_steps: number;
    schema_json: string | null;
  }[];
  for (const row of queued) {
    if (interrupted.some((r) => r.id === row.id)) continue; // already enqueued above
    enqueueTask(row.id, row.goal, row.max_steps, row.schema_json ? JSON.parse(row.schema_json) : null);
  }
}
