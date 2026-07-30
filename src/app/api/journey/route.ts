import { NextRequest, NextResponse } from "next/server";
import { buildJourney } from "@/lib/journey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const fallback = defaultRange();
    const start = searchParams.get("start") || fallback.start;
    const end = searchParams.get("end") || fallback.end;

    if (new Date(start) >= new Date(end)) {
      return NextResponse.json(
        { error: "start must be before end" },
        { status: 400 }
      );
    }

    const snapshot = await buildJourney({ start, end });
    return NextResponse.json(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
