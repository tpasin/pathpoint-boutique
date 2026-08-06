/**
 * Span-metrics helpers (Pomelo-style): PromQL on `calls_total` / `duration_ms_*`,
 * Explore deep-links open the matching raw spans.
 *
 * Note: Online Boutique HTTP spans (e.g. POST /api/checkout) often keep
 * `status_code=STATUS_CODE_UNSET` even on HTTP 500. For those, pass
 * `errorMode: "http"` so we count `$d.tags['http.status_code']` from raw spans.
 */
import { queryDataprime, queryPromql, type TimeRange } from "./coralogix";

export function promWindow(range: TimeRange): string {
  const ms = Date.parse(range.end) - Date.parse(range.start);
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes <= 15) return "15m";
  if (minutes <= 60) return "1h";
  if (minutes <= 360) return "6h";
  if (minutes <= 1440) return "24h";
  return `${Math.min(7 * 24 * 60, minutes)}m`;
}

export function svcRe(services: string[]): string {
  return services.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

function spansFilter(services: string[], spanNameRe?: string): string {
  const ors = services.map((s) => `$l.serviceName == '${s}'`).join(" || ");
  const base = `source spans | filter ${ors}`;
  if (!spanNameRe) return base;
  return `${base} && ($l.operationName ~ '${spanNameRe}')`;
}

/** Spans that underlie the span-metrics for these services (Explore drill-down). */
export function spanExplore(
  services: string[],
  spanNameRe?: string
): { kind: "tracing"; query: string } {
  return { kind: "tracing", query: spansFilter(services, spanNameRe) };
}

/**
 * Explore link for errored spans.
 * Cast tags to string before comparing — raw `$d.tags['error'] == 'true'` fails
 * DataPrime compilation (bool|string vs string) and returns no results in the UI.
 */
export function spanErrorExplore(
  services: string[],
  spanNameRe?: string
): { kind: "tracing"; query: string } {
  return {
    kind: "tracing",
    query: [
      spansFilter(services, spanNameRe),
      "create errored from $d.tags['error']:string",
      "create otel from $d.tags['otel.status_code']:string",
      "create http from $d.tags['http.status_code']:string",
      "create grpc from $d.tags['rpc.grpc.status_code']:string",
      "filter errored == 'true' || otel == 'ERROR' || http == '500' || (grpc != null && grpc != '0')",
    ].join(" | "),
  };
}

/** Checkout API failures — HTTP 500 on POST /api/checkout (exact op). */
export function checkoutHttpErrorExplore(): { kind: "tracing"; query: string } {
  return {
    kind: "tracing",
    query: [
      "source spans",
      "filter $l.serviceName == 'frontend' && $l.operationName == 'POST /api/checkout'",
      "create status from $d.tags['http.status_code']:string",
      "filter status == '500'",
    ].join(" | "),
  };
}

/** Payment Charge failures — error tag / otel ERROR / non-zero gRPC. */
export function paymentChargeErrorExplore(): { kind: "tracing"; query: string } {
  return {
    kind: "tracing",
    query: [
      "source spans",
      "filter $l.serviceName == 'payment' && $l.operationName ~ 'Charge'",
      "create errored from $d.tags['error']:string",
      "create otel from $d.tags['otel.status_code']:string",
      "create grpc from $d.tags['rpc.grpc.status_code']:string",
      "filter errored == 'true' || otel == 'ERROR' || (grpc != null && grpc != '0')",
    ].join(" | "),
  };
}

export function promqlHowto(
  services: string[],
  window: string,
  spanNameRe?: string,
  errorMode: "otel" | "http" = "otel"
): string {
  const spanSel = spanNameRe ? `,span_name=~"${spanNameRe}"` : "";
  const sel = `service_name=~"${svcRe(services)}"${spanSel}`;
  const errorBlock =
    errorMode === "http"
      ? [
          `HTTP errors (raw spans — STATUS_CODE_UNSET hides 500s in PromQL):`,
          `${spansFilter(services, spanNameRe)} | create status from $d.tags['http.status_code']:string | groupby status aggregate count() as cnt`,
        ]
      : [
          `PromQL errors:`,
          `sum(increase(calls_total{${sel},status_code="STATUS_CODE_ERROR"}[${window}]))`,
        ];
  return [
    `PromQL volume:`,
    `sum(increase(calls_total{${sel}}[${window}]))`,
    ``,
    ...errorBlock,
    ``,
    `PromQL latency:`,
    `sum(rate(duration_ms_sum{${sel}}[${window}])) / sum(rate(duration_ms_count{${sel}}[${window}]))`,
    ``,
    `Explore opens matching spans (not Frequent Search).`,
  ].join("\n");
}

export type SvcStats = {
  total: number;
  errors: number;
  rate: number;
  latencyMs: number;
  light: "green" | "yellow" | "red" | "grey";
};

function rateLight(errorRate: number): SvcStats["light"] {
  if (errorRate >= 0.15) return "red";
  if (errorRate >= 0.05) return "yellow";
  return "green";
}

export function worstLight(...lights: SvcStats["light"][]): SvcStats["light"] {
  if (lights.includes("red")) return "red";
  if (lights.includes("yellow")) return "yellow";
  if (lights.includes("green")) return "green";
  return "grey";
}

function worst(...lights: SvcStats["light"][]): SvcStats["light"] {
  return worstLight(...lights);
}

async function callsTotal(
  services: string[],
  window: string,
  time: string,
  opts?: { status?: "ERROR" | "OK" | "UNSET"; spanNameRe?: string }
): Promise<number> {
  const spanSel = opts?.spanNameRe ? `,span_name=~"${opts.spanNameRe}"` : "";
  const sel = `service_name=~"${svcRe(services)}"${spanSel}`;
  const statusSel =
    opts?.status === "ERROR"
      ? `,status_code="STATUS_CODE_ERROR"`
      : opts?.status === "OK"
        ? `,status_code="STATUS_CODE_OK"`
        : opts?.status === "UNSET"
          ? `,status_code="STATUS_CODE_UNSET"`
          : "";
  const v = await queryPromql(
    `sum(increase(calls_total{${sel}${statusSel}}[${window}]))`,
    { time, priority: false }
  );
  return v != null && Number.isFinite(v) ? Math.max(0, v) : 0;
}

async function avgLatencyMs(
  services: string[],
  window: string,
  time: string,
  spanNameRe?: string
): Promise<number> {
  const spanSel = spanNameRe ? `,span_name=~"${spanNameRe}"` : "";
  const sel = `service_name=~"${svcRe(services)}"${spanSel}`;
  const v = await queryPromql(
    `sum(rate(duration_ms_sum{${sel}}[${window}])) / sum(rate(duration_ms_count{${sel}}[${window}]))`,
    { time, priority: false }
  );
  return v != null && Number.isFinite(v) ? Math.max(0, v) : 0;
}

/** Count HTTP 5xx from raw spans — needed when span metrics leave status UNSET. */
async function httpStatusCounts(
  range: TimeRange,
  services: string[],
  operationMatch: string
): Promise<{ total: number; errors: number }> {
  const ors = services.map((s) => `$l.serviceName == '${s}'`).join(" || ");
  // Prefer exact operation equality when possible — DataPrime `~` with
  // alternation + negation can return empty for boutique frontend routes.
  const opFilter = operationMatch.includes("~")
    ? `$l.operationName ${operationMatch}`
    : `$l.operationName == '${operationMatch}'`;
  const query = `source spans | filter (${ors}) && ${opFilter} | create status from $d.tags['http.status_code']:string | filter status != null | groupby status aggregate count() as cnt`;
  try {
    const rows = await queryDataprime(query, range, 30, {
      priority: true,
      noCache: true,
      tier: process.env["CX_TIER"] || "archive",
    });
    let total = 0;
    let errors = 0;
    for (const r of rows) {
      const status = String(r.status ?? "");
      const cnt = Number(r.cnt ?? 0);
      if (!Number.isFinite(cnt) || cnt <= 0) continue;
      total += cnt;
      const n = Number(status);
      if ((Number.isFinite(n) && n >= 500) || status.startsWith("5")) {
        errors += cnt;
      }
    }
    return { total, errors };
  } catch {
    return { total: 0, errors: 0 };
  }
}

export type ServiceStatsOpts = {
  /**
   * Span-metric `span_name` regex for PromQL volume/latency.
   * For `errorMode: "http"`, pass an exact operation name (e.g. `POST /api/checkout`)
   * or a DataPrime op clause like `~ '/api/products'`.
   */
  spanNameRe?: string;
  /** Exact operation for HTTP status counting (defaults to spanNameRe). */
  httpOperation?: string;
  /** `http` = count HTTP 5xx from spans (frontend APIs). Default `otel`. */
  errorMode?: "otel" | "http";
  /** Required when errorMode is `http`. */
  range?: TimeRange;
};

export async function serviceStats(
  services: string[],
  window: string,
  time: string,
  spanNameReOrOpts?: string | ServiceStatsOpts,
  maybeOpts?: ServiceStatsOpts
): Promise<SvcStats> {
  const opts: ServiceStatsOpts =
    typeof spanNameReOrOpts === "string"
      ? { ...(maybeOpts || {}), spanNameRe: spanNameReOrOpts }
      : spanNameReOrOpts || {};
  const spanNameRe = opts.spanNameRe;
  const errorMode = opts.errorMode || "otel";

  const [total, otelErrors, latencyMs] = await Promise.all([
    callsTotal(services, window, time, { spanNameRe }),
    callsTotal(services, window, time, { status: "ERROR", spanNameRe }),
    avgLatencyMs(services, window, time, spanNameRe),
  ]);

  let errors = otelErrors;
  let countedTotal = total;

  if (errorMode === "http" && opts.range) {
    const httpOp = opts.httpOperation || spanNameRe;
    if (httpOp) {
      const http = await httpStatusCounts(opts.range, services, httpOp);
      // Prefer HTTP status when present — matches what Explore shows for /api/*.
      if (http.total > 0) {
        errors = http.errors;
        countedTotal = http.total;
      }
    }
  }

  const rate = countedTotal > 0 ? errors / countedTotal : 0;
  const light: SvcStats["light"] =
    countedTotal === 0
      ? "grey"
      : worst(rateLight(rate), latencyMs > 800 ? "yellow" : "green");
  return { total: countedTotal, errors, rate, latencyMs, light };
}

export function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toLocaleString("en");
}

export function fmtPct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** Online Boutique stage → services (span metrics). */
export const BROWSE_SVCS = ["frontend", "product-catalog", "recommendation"];
export const CART_SVCS = ["cart"];
export const CHECKOUT_SVCS = ["checkout", "frontend"];
export const PAYMENT_SVCS = ["payment"];
export const FULFILL_SVCS = ["shipping", "email", "cart"];
