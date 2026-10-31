import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { removeKey, setKeyEnabled } from "@/lib/server/keyManager";

const PatchSchema = z.object({ enabled: z.boolean() });

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  removeKey(id);
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
  }
  setKeyEnabled(id, parsed.data.enabled);
  return NextResponse.json({ ok: true });
}
