import { NextRequest, NextResponse } from "next/server";
import { resumeTask } from "@/lib/server/taskRunner";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = resumeTask(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ status: "queued" });
}
