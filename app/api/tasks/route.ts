import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getDb, now } from "@/lib/server/db";
import { getSettingInt } from "@/lib/server/settingsStore";
import { enqueueTask } from "@/lib/server/taskRunner";
import { TaskRow } from "@/lib/server/types";

const CreateTaskSchema = z.object({
  goal: z.string().min(1, "goal is required"),
  max_steps: z.number().int().positive().optional(),
  json_schema: z.record(z.unknown()).nullable().optional(),
});

export async function GET() {
  const rows = getDb().prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100").all() as TaskRow[];
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, { status: 400 });
  }
  const { goal, max_steps, json_schema } = parsed.data;

  const hardCap = getSettingInt("max_steps_hard_cap", 25);
  const defaultSteps = getSettingInt("max_steps_default", 12);
  const maxSteps = Math.min(max_steps ?? defaultSteps, hardCap);

  const id = randomBytes(6).toString("hex");
  const t = now();
  getDb()
    .prepare(
      "INSERT INTO tasks (id, goal, status, schema_json, max_steps, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)"
    )
    .run(id, goal, json_schema ? JSON.stringify(json_schema) : null, maxSteps, t, t);

  enqueueTask(id, goal, maxSteps, json_schema ?? null);

  return NextResponse.json({ id, status: "queued", max_steps: maxSteps });
}
