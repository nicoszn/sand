import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { StepRow, TaskRow } from "@/lib/server/types";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!task) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  const steps = db
    .prepare("SELECT step_index, kind, content, created_at FROM steps WHERE task_id = ? ORDER BY id ASC")
    .all(id) as StepRow[];
  return NextResponse.json({ task, steps });
}
