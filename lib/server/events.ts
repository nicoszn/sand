/** Small write helpers shared by the agent loop, the message API and the
 * task runner, so a step is logged the same way no matter who caused it. */
import { dayKey, getDb, now } from "./db";
import { StepKind } from "./types";

export function logStep(taskId: string, index: number, kind: StepKind, content: string) {
  const db = getDb();
  db.prepare("INSERT INTO steps (task_id, step_index, kind, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
    taskId,
    index,
    kind,
    content,
    now()
  );
  db.prepare("UPDATE tasks SET step_count = ?, updated_at = ? WHERE id = ?").run(index, now(), taskId);
}

export function updateTask(taskId: string, fields: Record<string, unknown>) {
  const db = getDb();
  const sets = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(", ");
  db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(fields), now(), taskId);
}

export function addTokens(taskId: string, promptTokens: number, completionTokens: number) {
  const total = promptTokens + completionTokens;
  const db = getDb();
  db.prepare(
    "UPDATE tasks SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ? WHERE id = ?"
  ).run(promptTokens, completionTokens, taskId);
  // Budget accounting happens on the day the tokens are spent, not the day the
  // task was created, so a conversation continued tomorrow costs tomorrow.
  db.prepare(
    "INSERT INTO token_usage (day, tokens) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens"
  ).run(dayKey(), total);
}
