import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteEpisode,
  deleteMemory,
  listEpisodes,
  listMemories,
  memoryStats,
  setMemoryPinned,
} from "@/lib/server/memory";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json({
    memories: listMemories(q),
    episodes: listEpisodes(40),
    stats: memoryStats(),
  });
}

const PatchSchema = z.object({ id: z.string().min(1), pinned: z.boolean() });

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "id and pinned (boolean) are required" }, { status: 400 });
  }
  setMemoryPinned(parsed.data.id, parsed.data.pinned);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type");
  const id = req.nextUrl.searchParams.get("id");
  if (!id || (type !== "memory" && type !== "episode")) {
    return NextResponse.json({ error: "type must be 'memory' or 'episode', and id is required" }, { status: 400 });
  }
  if (type === "memory") deleteMemory(id);
  else deleteEpisode(id);
  return NextResponse.json({ ok: true });
}
