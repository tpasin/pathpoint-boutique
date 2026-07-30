import { NextRequest, NextResponse } from "next/server";
import { exploreUrl, queryDataprime } from "@/lib/coralogix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STAGE_QUERIES: Record<string, string> = {
  browse: `source spans | filter $l.serviceName == 'frontend' && ($l.operationName ~ '/api/products' || $l.operationName ~ 'recommendations') | create status from $d.tags['http.status_code']:string | filter status == '500' | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.operationName, duration_ms, status | limit 10`,
  cart: `source spans | filter $l.serviceName == 'cart' && $m.duration > 100000 | create duration_ms from $m.duration / 1000 | orderby $m.duration desc | choose $d.traceID, $l.operationName, duration_ms | limit 10`,
  checkout: `source spans | filter $l.serviceName == 'frontend' && $l.operationName == 'POST /api/checkout' | create status from $d.tags['http.status_code']:string | filter status == '500' | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.operationName, duration_ms, status | limit 10`,
  payment: `source spans | filter $l.serviceName == 'payment' || $l.operationName ~ 'Charge' | create errored from $d.tags['error']:string | filter errored == 'true' | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms | limit 10`,
  fulfill: `source spans | filter $l.operationName ~ 'EmptyCart' | create duration_ms from $m.duration / 1000 | orderby $m.duration desc | choose $d.traceID, $l.serviceName, $l.operationName, duration_ms | limit 10`,
};

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const stage = searchParams.get("stage") || "checkout";
    const end = searchParams.get("end") || new Date().toISOString();
    const start =
      searchParams.get("start") ||
      new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const query = STAGE_QUERIES[stage] || STAGE_QUERIES.checkout;
    const rows = await queryDataprime(query, { start, end }, 15);

    const traces = rows
      .map((r) => {
        const traceId = String(r.traceID || r.tid || "");
        return {
          traceId,
          service: String(r.serviceName || "frontend"),
          operation: String(r.operationName || stage),
          durationMs: Number(r.duration_ms || 0),
          status: r.status ? String(r.status) : undefined,
          url: exploreUrl({
            kind: "tracing",
            traceId,
            start,
            end,
          }),
        };
      })
      .filter((t) => t.traceId);

    return NextResponse.json({
      stage,
      start,
      end,
      query,
      explore: exploreUrl({
        kind: "tracing",
        query,
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
