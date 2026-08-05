// @pathpoint-source panel:slos
import {
  coralogixUiBase,
  getSloRaw,
  listSlosRaw,
  queryPromql,
  type TimeRange,
} from "./coralogix";
import type { Light, SloCard } from "./types";

export type { SloCard };

/** PromQL range literal matching the picker window (min 1m). */
export function promqlWindow(range: TimeRange): string {
  const ms = Date.parse(range.end) - Date.parse(range.start);
  const sec = Number.isFinite(ms) ? Math.max(60, Math.round(ms / 1000)) : 3600;
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86400) return `${Math.max(1, Math.round(sec / 3600))}h`;
  return `${Math.max(1, Math.round(sec / 86400))}d`;
}

/** Rewrite every `[5m]` / `[1h]`-style selector to the selected window. */
function rewritePromqlWindows(expr: string, window: string): string {
  return expr.replace(/\[(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)\]/gi, `[${window}]`);
}

const BOUTIQUE_SERVICES = [
  "frontend",
  "frontend-proxy",
  "product-catalog",
  "recommendation",
  "cart",
  "checkout",
  "payment",
  "shipping",
  "email",
  "currency",
  "ad",
  "flagd",
] as const;

function stageForService(service: string): SloCard["stage"] {
  const s = service.toLowerCase();
  if (s.includes("payment")) return "payment";
  if (s.includes("checkout")) return "checkout";
  if (s.includes("cart")) return "cart";
  if (s.includes("shipping") || s.includes("email") || s.includes("fulfill")) {
    return "fulfill";
  }
  if (
    s.includes("frontend") ||
    s.includes("product-catalog") ||
    s.includes("catalog") ||
    s.includes("recommendation") ||
    s.includes("ad") ||
    s.includes("currency")
  ) {
    return "browse";
  }
  return "other";
}

function serviceFromName(name: string, labels?: Record<string, unknown>): string {
  const fromLabel = String(labels?.service || "").trim();
  if (fromLabel) return fromLabel;
  const lower = name.toLowerCase();
  for (const svc of BOUTIQUE_SERVICES) {
    if (lower.includes(svc)) return svc;
  }
  const prefix = name.split("_")[0]?.trim();
  return prefix || "unknown";
}

function normalizeTimeFrame(raw: string): string {
  return raw
    .replace(/^SLO_TIME_FRAME_/, "")
    .replace(/_/g, " ")
    .toLowerCase();
}

function sloUiUrl(id: string): string {
  const base = coralogixUiBase().replace(/\/$/, "");
  return `${base}/#/slo/${encodeURIComponent(id)}`;
}

function rateLightVsTarget(current: number | null, target: number): {
  light: Light;
  statusLabel: string;
} {
  if (current == null || !Number.isFinite(current)) {
    return { light: "grey", statusLabel: "no data" };
  }
  if (current >= target) return { light: "green", statusLabel: "meeting" };
  if (current >= target - 5) return { light: "yellow", statusLabel: "at risk" };
  return { light: "red", statusLabel: "breaching" };
}

function windowLight(
  current: number | null,
  op: string,
  threshold: number,
  unit: SloCard["unit"]
): { light: Light; statusLabel: string } {
  if (current == null || !Number.isFinite(current)) {
    return { light: "grey", statusLabel: "no data" };
  }
  const cmp = op.toLowerCase();
  let ok = false;
  if (cmp.includes("less")) ok = current < threshold;
  else if (cmp.includes("greater")) ok = current > threshold;
  else ok = current <= threshold;

  if (ok) return { light: "green", statusLabel: "meeting" };
  // Soft buffer for latency/rpm
  const slack = unit === "ms" ? threshold * 0.2 : unit === "rpm" ? threshold * 0.2 : 0;
  const near =
    cmp.includes("less")
      ? current < threshold + slack
      : current > threshold - slack;
  return {
    light: near ? "yellow" : "red",
    statusLabel: near ? "at risk" : "breaching",
  };
}

function boutiqueRelevant(name: string, service: string): boolean {
  const hay = `${name} ${service}`.toLowerCase();
  return BOUTIQUE_SERVICES.some((s) => hay.includes(s));
}

function preferKey(s: Record<string, unknown>): string {
  return String(s.name || s.id || "");
}

/** Dedupe duplicate managed SLOs — prefer unique name+service. */
function dedupeSlos(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const name = String(row.name || "");
    const labels = (row.labels || {}) as Record<string, unknown>;
    const service = serviceFromName(name, labels);
    const key = `${name}::${service}`.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    // Prefer rows that already look richer / newer
    const a = String(existing.update_time || existing.updateTime || "");
    const b = String(row.update_time || row.updateTime || "");
    if (b > a) byKey.set(key, row);
  }
  return [...byKey.values()];
}

async function evaluateRequestSli(
  goodQ: string,
  totalQ: string,
  range: TimeRange,
  window: string
): Promise<number | null> {
  const good = rewritePromqlWindows(goodQ, window);
  const total = rewritePromqlWindows(totalQ, window);
  // Ratio as percentage — wrap to avoid empty-series explosions.
  const expr = `((${good}) / (${total})) * 100`;
  return queryPromql(expr, { time: range.end });
}

async function evaluateWindowSli(
  query: string,
  range: TimeRange,
  window: string
): Promise<number | null> {
  return queryPromql(rewritePromqlWindows(query, window), { time: range.end });
}

export async function buildBoutiqueSlos(
  limit = 18,
  range?: TimeRange
): Promise<SloCard[]> {
  const effectiveRange: TimeRange = range ?? {
    start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    end: new Date().toISOString(),
  };
  const promWindow = promqlWindow(effectiveRange);
  const listed = dedupeSlos(await listSlosRaw()).filter((row) => {
    const name = String(row.name || "");
    const labels = (row.labels || {}) as Record<string, unknown>;
    const service = serviceFromName(name, labels);
    return boutiqueRelevant(name, service);
  });

  // Rank: availability/error first, then latency, then traffic; checkout/payment/catalog boosted
  const ranked = [...listed].sort((a, b) => {
    const an = String(a.name || "").toLowerCase();
    const bn = String(b.name || "").toLowerCase();
    const score = (n: string) => {
      let s = 0;
      if (n.includes("checkout") || n.includes("payment")) s += 30;
      if (n.includes("catalog") || n.includes("frontend")) s += 20;
      if (n.includes("cart")) s += 15;
      if (n.includes("availability") || n.includes("error")) s += 10;
      if (n.includes("latency")) s += 5;
      return s;
    };
    return score(bn) - score(an);
  });

  const selected = ranked.slice(0, Math.min(limit, 12));

  const detailed = await Promise.all(
    selected.map(async (summary) => {
      const id = String(summary.id || "");
      if (!id) return null;
      const detail = (await getSloRaw(id)) || summary;
      return { summary, detail, id };
    })
  );

  const cards: SloCard[] = [];

  for (const item of detailed) {
    if (!item) continue;
    const { summary, detail, id } = item;
    const name = String(detail.name || summary.name || id);
    const labels = (detail.labels || summary.labels || {}) as Record<string, unknown>;
    const service = serviceFromName(name, labels);
    const target = Number(
      detail.targetThresholdPercentage ?? summary.target ?? 99
    );
    const timeFrame = normalizeTimeFrame(
      String(detail.sloTimeFrame || summary.time_frame || "7 days")
    );
    const description = String(detail.description || summary.description || "");
    const sloType = String(labels.slo_type || detail.type || summary.type || "slo");

    const request = detail.requestBasedMetricSli as
      | { goodEvents?: { query?: string }; totalEvents?: { query?: string } }
      | undefined;
    const windowSli = detail.windowBasedMetricSli as
      | {
          query?: { query?: string };
          threshold?: number;
          comparisonOperator?: string;
        }
      | undefined;

    let sliType: SloCard["sliType"] = "unknown";
    let sliLabel = "SLI";
    let currentValue: number | null = null;
    let unit: SloCard["unit"] = "%";
    let light: Light = "grey";
    let statusLabel = "no data";
    let sliSummary = "";

    if (request?.goodEvents?.query && request?.totalEvents?.query) {
      sliType = "request";
      sliLabel = "Availability / success SLI";
      unit = "%";
      currentValue = await evaluateRequestSli(
        request.goodEvents.query,
        request.totalEvents.query,
        effectiveRange,
        promWindow
      );
      ({ light, statusLabel } = rateLightVsTarget(currentValue, target));
      sliSummary = `good ÷ total over ${promWindow} (target ${target}%)`;
    } else if (windowSli?.query?.query) {
      sliType = "window";
      const threshold = Number(windowSli.threshold ?? 0);
      const op = String(windowSli.comparisonOperator || "less_than");
      const q = windowSli.query.query;
      const isLatency = /duration|latency|quantile/i.test(q) || /latency/i.test(name);
      const isTraffic = /rate\(|rpm|traffic/i.test(q) || /traffic/i.test(name);
      unit = isLatency ? "ms" : isTraffic ? "rpm" : "";
      sliLabel = isLatency ? "Latency window SLI" : isTraffic ? "Traffic window SLI" : "Window SLI";
      sliSummary = `${op.replace(/COMPARISON_OPERATOR_/i, "").replace(/_/g, " ").toLowerCase()} ${threshold}${unit ? ` ${unit}` : ""} · over ${promWindow}`;
      currentValue = await evaluateWindowSli(q, effectiveRange, promWindow);
      ({ light, statusLabel } = windowLight(currentValue, op, threshold, unit));
    }

    cards.push({
      id,
      name,
      description,
      target,
      timeFrame: `${timeFrame} · evaluated ${promWindow}`,
      sliType,
      sliLabel,
      service,
      stage: stageForService(service),
      sloType,
      currentValue,
      unit,
      light,
      statusLabel,
      sliSummary,
      url: sloUiUrl(id),
    });
  }

  // Stable display order by journey stage
  const stageOrder: Record<SloCard["stage"], number> = {
    browse: 0,
    cart: 1,
    checkout: 2,
    payment: 3,
    fulfill: 4,
    other: 5,
  };
  cards.sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage] || a.name.localeCompare(b.name));
  return cards;
}
