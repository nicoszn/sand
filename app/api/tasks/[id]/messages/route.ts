import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listMessages } from "@/lib/server/messages";
import { postUserMessage } from "@/lib/server/taskRunner";

const MessageSchema = z.object({ content: z.string().min(1).max(20000) });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(listMessages(id));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = MessageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid message" }, { status: 400 });
  }

  const result = postUserMessage(id, parsed.data.content);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "task not found" ? 404 : 400 });
  }
  return NextResponse.json({ status: result.status, mode: result.mode });
}
