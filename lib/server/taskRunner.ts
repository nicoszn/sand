/**
 * A simple in-process background worker. Tasks are queued and run by a
 * worker loop that is independent of any HTTP request or SSE connection,
 * so a task keeps running (and its steps keep being written to SQLite)
 * whether or not anyone has the UI open. State lives on globalThis so
 * Next.js's dev-mode module reloading doesn't spawn a second worker.
 */
import { getDb } from "./db";
import { runTask } from "./agent";

interface TaskSpec {
  goal: string;
  maxSteps: number;
  jsonSchema: Record<string, unknown> | null;
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

export function enqueueTask(taskId: string, goal: string, maxSteps: number, jsonSchema: Record<string, unknown> | null) {
  const s = state();
  s.specs.set(taskId, { goal, maxSteps, jsonSchema });
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
        await runTask(taskId, spec.goal, spec.maxSteps, spec.jsonSchema);
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

/** Call once at server startup (see instrumentation.ts). Any task left
 * "running" means the process died mid-task (e.g. a redeploy) - mark it
 * failed rather than silently losing it, and resume the queue. */
export function initTaskRunner() {
  const s = state();
  if (s.started) return;
  s.started = true;

  const db = getDb();
  const interrupted = db.prepare("SELECT id FROM tasks WHERE status = 'running'").all() as { id: string }[];
  for (const row of interrupted) {
    db.prepare("UPDATE tasks SET status = 'failed', result = 'Interrupted by server restart.' WHERE id = ?").run(
      row.id
    );
  }

  const queued = db.prepare("SELECT id, goal, max_steps, schema_json FROM tasks WHERE status = 'queued'").all() as {
    id: string;
    goal: string;
    max_steps: number;
    schema_json: string | null;
  }[];
  for (const row of queued) {
    enqueueTask(row.id, row.goal, row.max_steps, row.schema_json ? JSON.parse(row.schema_json) : null);
  }
}
