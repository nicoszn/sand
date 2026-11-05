/**
 * Plain-text documents attached to a task at creation time. Content is
 * injected into the agent's first message so it has the material without
 * needing a tool call to fetch it. Deliberately text-only (no file
 * uploads/parsing) to stay within the resource budget this app runs in -
 * paste in CSV/markdown/JSON/plain text, not binary files.
 */
import { randomBytes } from "node:crypto";
import { getDb, now } from "./db";
import { TaskDocument } from "./types";

const MAX_DOC_CHARS = 20000; // per document
const MAX_TOTAL_CHARS = 40000; // across all documents on one task, to protect the token budget

export function addDocuments(taskId: string, docs: { name: string; content: string }[]): string[] {
  const db = getDb();
  const insert = db.prepare("INSERT INTO task_documents (id, task_id, name, content, created_at) VALUES (?, ?, ?, ?, ?)");
  const ids: string[] = [];
  const tx = db.transaction((items: { name: string; content: string }[]) => {
    for (const d of items) {
      const id = randomBytes(6).toString("hex");
      insert.run(id, taskId, d.name.slice(0, 200), d.content.slice(0, MAX_DOC_CHARS), now());
      ids.push(id);
    }
  });
  tx(docs);
  return ids;
}

export function getDocuments(taskId: string): TaskDocument[] {
  return getDb()
    .prepare("SELECT * FROM task_documents WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId) as TaskDocument[];
}

/** Renders attached documents as a context block for the agent's first
 * message, truncating the combined total so one task can't silently eat
 * the whole context window. */
export function renderDocumentsForPrompt(taskId: string): string | null {
  const docs = getDocuments(taskId);
  if (docs.length === 0) return null;

  let used = 0;
  const parts: string[] = [];
  for (const d of docs) {
    const remaining = MAX_TOTAL_CHARS - used;
    if (remaining <= 0) {
      parts.push(`[${d.name}: omitted, total document budget exceeded]`);
      continue;
    }
    const content = d.content.length > remaining ? d.content.slice(0, remaining) + "\n...[truncated]" : d.content;
    used += content.length;
    parts.push(`--- ${d.name} ---\n${content}`);
  }
  return `The following documents were attached to this task:\n\n${parts.join("\n\n")}`;
}
