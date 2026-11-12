import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getDb, now } from "@/lib/server/db";
import { getSettingInt } from "@/lib/server/settingsStore";
import { enqueueTask } from "@/lib/server/taskRunner";
import { addDocuments } from "@/lib/server/documents";
import { addUserMessage } from "@/lib/server/messages";
import { TaskRow } from "@/lib/server/types";

const CreateTaskSchema = z.object({
  goal: z.string().min(1, "goal is required"),
  max_steps: z.number().int().positive().optional(),
  json_schema: z.record(z.unknown()).nullable().optional(),
  documents: z.array(z.object({ name: z.string().min(1), content: z.string() })).max(10).optional(),
});

const LIST_COLUMNS =
  "id, goal, status, result, schema_json, max_steps, created_at, updated_at, prompt_tokens, completion_tokens, step_count, resume_count, memory_refs_json, (conversation_json IS NOT NULL) AS has_conversation, (SELECT COUNT(*) FROM task_messages WHERE task_id = tasks.id) AS message_count";

export async function GET() {
  // conversation_json itself is excluded - it can be large and the list
  // view doesn't need the content, just whether one exists (has_conversation)
  // so the UI knows whether a "resume" action is possible.
  const rows = getDb()
    .prepare(`SELECT ${LIST_COLUMNS} FROM tasks ORDER BY created_at DESC LIMIT 100`)
    .all() as (Omit<TaskRow, "conversation_json"> & { has_conversation: 0 | 1 })[];
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, { status: 400 });
  }
  const { goal, max_steps, json_schema, documents } = parsed.data;

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

  // The goal is the conversation's opening turn; marking it consumed keeps
  // the agent from appending it a second time.
  addUserMessage(id, goal, true);

  if (documents && documents.length > 0) {
    addDocuments(id, documents);
  }

  enqueueTask(id, goal, maxSteps, json_schema ?? null);

  return NextResponse.json({ id, status: "queued", max_steps: maxSteps });
}
