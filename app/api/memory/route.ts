import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteEpisode,
  listEpisodes,
  listMemories,
  memoryHistory,
  memoryShelf,
  memoryStats,
  purgeMemory,
  restoreMemory,
  retractMemory,
  setMemoryPinned,
} from "@/lib/server/memory";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const q = params.get("q") ?? "";

  // Belief history for one fact: every revision plus the chain of facts it
  // superseded and the facts that superseded it.
  const history = params.get("history");
  if (history) {
    const chain = memoryHistory(history);
    if (chain.length === 0) return NextResponse.json({ error: "memory not found" }, { status: 404 });
    return NextResponse.json({ chain });
  }

  const shelf = memoryShelf();
  return NextResponse.json({
    memories: await listMemories(q),
    episodes: listEpisodes(40),
    stats: memoryStats(),
    communities: shelf.communities.filter((community) => community.level === 0),
    themes: shelf.communities.filter((community) => community.level === 1),
    inactive: shelf.inactive,
  });
}

const PatchSchema = z.object({
  id: z.string().min(1),
  pinned: z.boolean().optional(),
  action: z.enum(["restore"]).optional(),
});

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "id is required, with pinned (boolean) or action \"restore\"" }, { status: 400 });
  }
  if (parsed.data.action === "restore") {
    return NextResponse.json({ ok: restoreMemory(parsed.data.id) });
  }
  if (typeof parsed.data.pinned !== "boolean") {
    return NextResponse.json({ error: "pinned (boolean) or action \"restore\" is required" }, { status: 400 });
  }
  setMemoryPinned(parsed.data.id, parsed.data.pinned);
  return NextResponse.json({ ok: true });
}

/**
 * Two distinct deletions, never conflated:
 *   mode=retract (default) - stop believing it, keep the audit trail;
 *   mode=purge             - hard delete the fact, its vectors and its history.
 * Deleting an episode retracts only the facts no other task also supports.
 */
export async function DELETE(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const type = params.get("type");
  const id = params.get("id");
  const mode = params.get("mode") ?? "retract";
  if (!id || (type !== "memory" && type !== "episode")) {
    return NextResponse.json({ error: "type must be 'memory' or 'episode', and id is required" }, { status: 400 });
  }
  if (mode !== "retract" && mode !== "purge") {
    return NextResponse.json({ error: "mode must be 'retract' or 'purge'" }, { status: 400 });
  }

  if (type === "memory") {
    if (mode === "purge") return NextResponse.json({ ok: purgeMemory(id) });
    return NextResponse.json({ ok: retractMemory(id) });
  }

  const result = deleteEpisode(id);
  return NextResponse.json({ ok: true, ...result });
}
