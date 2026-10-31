import { NextRequest, NextResponse } from "next/server";
import { getDb, now } from "@/lib/server/db";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | undefined;
  if (!row) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  if (TERMINAL.has(row.status)) {
    return NextResponse.json({ status: row.status });
  }
  db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), id);
  return NextResponse.json({ status: "cancelled" });
}
