import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TimeRange = {
  start: string;
  end: string;
};

function toIso(input: string): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid datetime: ${input}`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Flatten cx CLI span/log JSON into a single-level record for grouping fields. */
export function flattenCxRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object") return {};
  const r = row as Record<string, unknown>;

  // Already flat (MCP-style or aggregation)
  if (!r.metadata && !r.labels && !r.userData && !r.user_data) {
    return r;
  }

  const labels = (r.labels || {}) as Record<string, unknown>;
  const userData = (r.userData || r.user_data || {}) as Record<string, unknown>;
  const metadata = (r.metadata || {}) as Record<string, unknown>;

  return {
    ...metadata,
    ...labels,
    ...userData,
    traceID: userData.traceID || userData.traceId || labels.traceID,
    operationName: userData.operationName || labels.operationName,
    serviceName: userData.serviceName || labels.serviceName,
    duration_ms: userData.duration_ms,
    status: userData.status,
    cnt: userData.cnt ?? r.cnt ?? metadata.cnt,
  };
}

/** Run a DataPrime query via the local `cx` CLI (uses ~/.cx profile). */
export async function queryDataprime(
  query: string,
  range: TimeRange,
  limit = 100
): Promise<Record<string, unknown>[]> {
  const start = toIso(range.start);
  const end = toIso(range.end);
  const cxBin = process.env.CX_BIN || "cx";

  try {
    const { stdout } = await execFileAsync(
      cxBin,
      [
        "dataprime",
        "query",
        "--start",
        start,
        "--end",
        end,
        "--limit",
        String(limit),
        "-o",
        "json",
        query,
      ],
      {
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env },
        timeout: 120_000,
      }
    );

    const trimmed = stdout.trim();
    if (!trimmed) return [];

    const jsonStart = trimmed.indexOf("[");
    const jsonObjStart = trimmed.indexOf("{");
    let payload = trimmed;
    if (jsonStart >= 0 && (jsonObjStart < 0 || jsonStart <= jsonObjStart)) {
      payload = trimmed.slice(jsonStart);
    } else if (jsonObjStart >= 0) {
      payload = trimmed.slice(jsonObjStart);
    }

    const parsed = JSON.parse(payload);
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.records)
        ? parsed.records
        : [parsed];

    return rows.map(flattenCxRecord);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Coralogix query failed: ${message}`);
  }
}

export function coralogixUiBase(): string {
  return (
    process.env.NEXT_PUBLIC_CORALOGIX_UI_BASE ||
    process.env.CORALOGIX_UI_BASE ||
    "https://us2.app.coralogix.com"
  );
}

/** Deep-link into Coralogix Explore for logs/spans with a time range. */
export function exploreUrl(opts: {
  kind: "logs" | "tracing";
  query?: string;
  start: string;
  end: string;
  traceId?: string;
}): string {
  const base = coralogixUiBase().replace(/\/$/, "");
  const startMs = new Date(opts.start).getTime();
  const endMs = new Date(opts.end).getTime();
  const time = `from:${startMs},to:${endMs}`;

  if (opts.kind === "tracing" && opts.traceId) {
    return `${base}/#/query-new/tracing?id=${encodeURIComponent(opts.traceId)}&time=${encodeURIComponent(time)}`;
  }

  const page = opts.kind === "tracing" ? "tracing" : "logs";
  const q = opts.query ? `&query=${encodeURIComponent(opts.query)}` : "";
  return `${base}/#/query-new/${page}?permalink=true&time=${encodeURIComponent(time)}${q}`;
}
