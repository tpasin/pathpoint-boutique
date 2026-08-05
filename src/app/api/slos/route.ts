import { NextRequest, NextResponse } from "next/server";
import { buildBoutiqueSlos } from "@/lib/slos";
import type { SloCard } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CACHE_TTL_MS = Number(process.env["SLO_CACHE_TTL_MS"] || 180_000);
const sloCache = new Map<string, { at: number; slos: SloCard[] }>();
const sloInflight = new Map<string, Promise<SloCard[]>>();
const SLO_CACHE_MAX = Number(process.env["SLO_CACHE_MAX"] || 24);

function remember(key: string, slos: SloCard[]) {
  sloCache.set(key, { at: Date.now(), slos });
  while (sloCache.size > SLO_CACHE_MAX) {
    const oldest = sloCache.keys().next().value;
    if (oldest == null) break;
    sloCache.delete(oldest);
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

function jsonOk(body: unknown, at = Date.now()) {
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "public, max-age=30, s-maxage=90, stale-while-revalidate=180",
      "X-Pathpoint-Cache-At": new Date(at).toISOString(),
    },
  });
}

async function getSlos(start: string, end: string): Promise<SloCard[]> {
  const key = cacheKey(start, end);
  const hit = sloCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.slos;
  }

  const existing = sloInflight.get(key);
  if (existing) return existing;

  const promise = buildBoutiqueSlos(12, { start, end })
    .then((slos) => {
      remember(key, slos);
      return slos;
    })
    .finally(() => {
      sloInflight.delete(key);
    });

  sloInflight.set(key, promise);

  try {
    return await promise;
  } catch (err) {
    if (hit) return hit.slos;
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

    const key = cacheKey(start, end);
    const hit = sloCache.get(key);
    const slos = await getSlos(start, end);
    const at = hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.at : Date.now();

    return jsonOk(
      {
        fetchedAt: new Date(at).toISOString(),
        range: { start, end },
        slos,
      },
      at
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
