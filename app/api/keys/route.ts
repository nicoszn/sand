import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addKey, listKeysWithUsage } from "@/lib/server/keyManager";

const AddKeySchema = z.object({
  label: z.string().min(1),
  key_value: z.string().min(1),
  daily_limit: z.number().int().positive().default(50),
  minute_limit: z.number().int().positive().default(20),
});

export async function GET() {
  return NextResponse.json(listKeysWithUsage());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = AddKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, { status: 400 });
  }
  const { label, key_value, daily_limit, minute_limit } = parsed.data;
  const id = addKey(label, key_value, daily_limit, minute_limit);
  return NextResponse.json({ id });
}
