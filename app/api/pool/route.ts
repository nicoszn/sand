import { NextResponse } from "next/server";
import { poolSummary } from "@/lib/server/keyManager";

export async function GET() {
  return NextResponse.json(poolSummary());
}
