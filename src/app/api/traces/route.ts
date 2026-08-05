// @pathpoint-source panel:traces
import { NextRequest, NextResponse } from "next/server";
import { exploreUrl, queryDataprime } from "@/lib/coralogix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 2–3 queries per stage so recent traffic from each relevant service/op family
 * shows up — a single hot span cannot crowd out the rest.
 * Note: DataPrime `~` is unanchored; avoid `^` which may not match.
 */
const STAGE_QUERY_SETS: Record<string, string[]> = {
  browse: [
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'frontend' && ($l.operationName ~ 'GET /api/products' || $l.operationName ~ 'GET /api/recommendations') | create status from $d.tags['http.status_code']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, status | limit 40`,
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'product-catalog' | create errored from $d.tags['error']:string | create code from $d.tags['rpc.grpc.status_code']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored, code | limit 40`,
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'recommendation' | create errored from $d.tags['error']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored | limit 40`,
  ],
  cart: [
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'frontend' && ($l.operationName ~ 'GET /api/cart' || $l.operationName ~ 'POST /api/cart' || $l.operationName ~ 'DELETE /api/cart') | create status from $d.tags['http.status_code']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, status | limit 40`,
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'cart' && $l.operationName ~ 'AddItem' | create errored from $d.tags['error']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored | limit 30`,
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'cart' && $l.operationName ~ 'GetCart' && !($l.operationName ~ 'EmptyCart') | create errored from $d.tags['error']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored | limit 30`,
  ],
  checkout: [
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'frontend' && $l.operationName == 'POST /api/checkout' | create status from $d.tags['http.status_code']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, status | limit 40`,
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'checkout' && ($l.operationName ~ 'PlaceOrder' || $l.operationName ~ 'prepareOrder') | create errored from $d.tags['error']:string | create code from $d.tags['rpc.grpc.status_code']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored, code | limit 40`,
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'checkout' && ($l.operationName ~ 'GetCart' || $l.operationName ~ 'GetQuote' || $l.operationName ~ 'Convert' || $l.operationName ~ 'GetProduct') | create errored from $d.tags['error']:string | create code from $d.tags['rpc.grpc.status_code']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored, code | limit 40`,
  ],
  payment: [
    `source spans | filter $l.applicationName == 'astronomy-demo' && ($l.operationName ~ 'Charge' || ($l.serviceName == 'payment' && $l.operationName == 'charge')) | create errored from $d.tags['error']:string | create code from $d.tags['rpc.grpc.status_code']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored, code | limit 40`,
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'payment' && ($l.operationName ~ 'INSERT' || $l.operationName ~ 'pg.query' || $l.operationName ~ 'transactions' || $l.operationName ~ 'pg-pool') | create errored from $d.tags['error']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored | limit 40`,
  ],
  fulfill: [
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.operationName ~ 'EmptyCart' | create errored from $d.tags['error']:string | create code from $d.tags['rpc.grpc.status_code']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored, code | limit 40`,
    `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'shipping' | create errored from $d.tags['error']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored | limit 40`,
    `source spans | filter $l.applicationName == 'astronomy-demo' && ($l.serviceName == 'email' || $l.operationName ~ 'orders publish' || $l.operationName ~ 'send_order' || $l.operationName ~ 'send_email') | create errored from $d.tags['error']:string | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms, errored | limit 40`,
  ],
};

type TraceHit = {
  traceId: string;
  service: string;
  operation: string;
  durationMs: number;
  status?: string;
  url: string;
};

function toHit(
  r: Record<string, unknown>,
  stage: string,
  start: string,
  end: string
): TraceHit | null {
  const traceId = String(r.traceID || r.tid || "");
  if (!traceId) return null;
  const operation = String(r.operationName || stage);
  if (/^executing api route/i.test(operation)) return null;

  const status =
    r.status != null && String(r.status)
      ? String(r.status)
      : r.errored === "true" || r.errored === true
        ? "error"
        : r.code != null && String(r.code) !== "" && String(r.code) !== "0"
          ? `grpc ${r.code}`
          : undefined;

  return {
    traceId,
    service: String(r.serviceName || "frontend"),
    operation,
    durationMs: Number(r.duration_ms || 0),
    status,
    url: exploreUrl({ kind: "tracing", traceId, start, end }),
  };
}

function scoreHit(t: TraceHit): number {
  let s = 0;
  if (t.status && t.status !== "200" && t.status !== "304") s += 3;
  if (t.status?.startsWith("grpc") || t.status === "error") s += 3;
  if (t.durationMs >= 100) s += 1;
  return s;
}

/** Round-robin across query buckets, then diversify by operation (max 2 each). */
function mapBuckets(
  buckets: Record<string, unknown>[][],
  stage: string,
  start: string,
  end: string
): TraceHit[] {
  const seenTrace = new Set<string>();
  const rankedBuckets = buckets.map((rows) => {
    const hits: TraceHit[] = [];
    for (const r of rows) {
      const hit = toHit(r, stage, start, end);
      if (!hit || seenTrace.has(hit.traceId)) continue;
      seenTrace.add(hit.traceId);
      hits.push(hit);
    }
    hits.sort((a, b) => scoreHit(b) - scoreHit(a));
    return hits;
  });

  // Interleave buckets so each family gets early slots.
  const interleaved: TraceHit[] = [];
  const indexes = rankedBuckets.map(() => 0);
  let added = true;
  while (added && interleaved.length < 60) {
    added = false;
    for (let b = 0; b < rankedBuckets.length; b++) {
      const bucket = rankedBuckets[b];
      const i = indexes[b];
      if (i < bucket.length) {
        interleaved.push(bucket[i]);
        indexes[b] = i + 1;
        added = true;
      }
    }
  }

  const TARGET = 15;
  const MAX_PER_OP = 3;
  const perOp = new Map<string, number>();
  const out: TraceHit[] = [];
  for (const t of interleaved) {
    const key = `${t.service}::${t.operation}`;
    const n = perOp.get(key) || 0;
    if (n >= MAX_PER_OP) continue;
    perOp.set(key, n + 1);
    out.push(t);
    if (out.length >= TARGET) break;
  }

  // If still under the floor, backfill remaining unique traces (ignore per-op cap).
  if (out.length < TARGET) {
    const have = new Set(out.map((t) => t.traceId));
    for (const t of interleaved) {
      if (have.has(t.traceId)) continue;
      out.push(t);
      have.add(t.traceId);
      if (out.length >= TARGET) break;
    }
  }

  return out;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const stage = searchParams.get("stage") || "checkout";
    const end = searchParams.get("end") || new Date().toISOString();
    const start =
      searchParams.get("start") ||
      new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const queries = STAGE_QUERY_SETS[stage] || STAGE_QUERY_SETS.checkout;
    let warn: string | undefined;
    const buckets = await Promise.all(
      queries.map((query) =>
        queryDataprime(query, { start, end }, 40, {
          priority: true,
          noCache: true,
        }).catch((err) => {
          warn = err instanceof Error ? err.message : String(err);
          return [] as Record<string, unknown>[];
        })
      )
    );

    const traces = mapBuckets(buckets, stage, start, end);
    const exploreQuery = queries[0];

    return NextResponse.json({
      stage,
      start,
      end,
      query: exploreQuery,
      queries,
      dataSource: "live",
      warn,
      explore: exploreUrl({
        kind: "tracing",
        query: exploreQuery,
        start,
        end,
      }),
      traces,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
