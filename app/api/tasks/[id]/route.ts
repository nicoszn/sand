import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { getDocuments } from "@/lib/server/documents";
import { StepRow, TaskRow } from "@/lib/server/types";

const COLUMNS =
  "id, goal, status, result, schema_json, max_steps, created_at, updated_at, prompt_tokens, completion_tokens, step_count, resume_count";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const task = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id) as Omit<TaskRow, "conversation_json"> | undefined;
  if (!task) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  const steps = db
    .prepare("SELECT step_index, kind, content, created_at FROM steps WHERE task_id = ? ORDER BY id ASC")
    .all(id) as StepRow[];
  const documents = getDocuments(id).map((d) => ({ name: d.name, size: d.content.length }));
  return NextResponse.json({ task, steps, documents });
}
