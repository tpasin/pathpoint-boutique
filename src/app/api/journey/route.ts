import { NextRequest, NextResponse } from "next/server";
import { buildJourney } from "@/lib/journey";
import type { JourneySnapshot } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const JOURNEY_CACHE_TTL_MS = Number(process.env["JOURNEY_CACHE_TTL_MS"] || 180_000);
const journeyCache = new Map<string, { at: number; snapshot: JourneySnapshot }>();
const journeyInflight = new Map<string, Promise<JourneySnapshot>>();

/** Cap in-memory journey entries under traffic (LRU-ish by insertion). */
const JOURNEY_CACHE_MAX = Number(process.env["JOURNEY_CACHE_MAX"] || 40);

function rememberJourney(key: string, snapshot: JourneySnapshot) {
  journeyCache.set(key, { at: Date.now(), snapshot });
  while (journeyCache.size > JOURNEY_CACHE_MAX) {
    const oldest = journeyCache.keys().next().value;
    if (oldest == null) break;
    journeyCache.delete(oldest);
  }
}

function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Round to the minute so picker jitter / auto-refresh hits the same cache. */
function cacheKey(start: string, end: string): string {
  const s = Math.floor(new Date(start).getTime() / 60_000);
  const e = Math.floor(new Date(end).getTime() / 60_000);
  return `${s}|${e}`;
}

async function getJourney(start: string, end: string): Promise<JourneySnapshot> {
  const key = cacheKey(start, end);
  const hit = journeyCache.get(key);
  if (hit && Date.now() - hit.at < JOURNEY_CACHE_TTL_MS) {
    return hit.snapshot;
  }

  const existing = journeyInflight.get(key);
  if (existing) return existing;

  const promise = buildJourney({ start, end })
    .then((snapshot) => {
      rememberJourney(key, snapshot);
      return snapshot;
    })
    .finally(() => {
      journeyInflight.delete(key);
    });

  journeyInflight.set(key, promise);

  try {
    return await promise;
  } catch (err) {
    if (hit) return hit.snapshot;
    throw err;
  }
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

    const snapshot = await getJourney(start, end);
    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=120",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
