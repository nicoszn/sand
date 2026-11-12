/**
 * The conversation around a task: the initial goal, plus any follow-up
 * messages the user sends while it runs or after it finishes.
 *
 * A message is written with `consumed = 0` and only marked consumed when the
 * agent loop actually folds it into the conversation - that way a message can
 * never be silently dropped by a crash or a restart in between.
 */
import { getDb, now } from "./db";
import { logStep } from "./events";

export const MAX_MESSAGE_CHARS = 20000;

export interface PendingMessage {
  id: number;
  content: string;
}

/** Stores a user turn. `consumed` is true for the initial goal, which is
 * already part of the first conversation, and false for follow-ups. */
export function addUserMessage(taskId: string, content: string, consumed = false): number {
  const db = getDb();
  const result = db
    .prepare("INSERT INTO task_messages (task_id, role, content, consumed, created_at) VALUES (?, 'user', ?, ?, ?)")
    .run(taskId, content, consumed ? 1 : 0, now());
  return Number(result.lastInsertRowid);
}

/** Hands every unseen message to the agent exactly once. */
export function takePendingMessages(taskId: string): PendingMessage[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, content FROM task_messages WHERE task_id = ? AND consumed = 0 ORDER BY id ASC")
    .all(taskId) as PendingMessage[];
  if (rows.length === 0) return [];

  const mark = db.prepare("UPDATE task_messages SET consumed = 1 WHERE id = ?");
  const tx = db.transaction((items: PendingMessage[]) => {
    for (const item of items) mark.run(item.id);
  });
  tx(rows);
  return rows;
}

export function countPendingMessages(taskId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ? AND consumed = 0")
    .get(taskId) as { n: number };
  return row.n;
}

export function listMessages(taskId: string, limit = 200) {
  return getDb()
    .prepare("SELECT id, role, content, created_at FROM task_messages WHERE task_id = ? ORDER BY id ASC LIMIT ?")
    .all(taskId, limit) as { id: number; role: string; content: string; created_at: number }[];
}

export function countMessages(taskId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ?").get(taskId) as { n: number };
  return row.n;
}

/** Records the message in the activity log too, so the thread reads in order. */
export function logUserMessageStep(taskId: string, stepIndex: number, content: string) {
  logStep(taskId, stepIndex, "user", content);
}
