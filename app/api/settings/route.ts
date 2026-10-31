import { NextRequest, NextResponse } from "next/server";
import { getAllSettings, setManySettings } from "@/lib/server/settingsStore";

export async function GET() {
  return NextResponse.json(getAllSettings());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid settings payload" }, { status: 400 });
  }
  setManySettings(body as Record<string, unknown>);
  return NextResponse.json(getAllSettings());
}
