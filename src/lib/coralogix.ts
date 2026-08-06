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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CxJob = {
  priority: boolean;
  run: () => Promise<void>;
};

/** Limited concurrency; priority jobs (traces / olly) jump ahead of journey backlog. */
const cxQueue: CxJob[] = [];
const CX_MAX_CONCURRENT = Number(process.env["CX_MAX_CONCURRENT"] || 2);
let cxActive = 0;
/** After a 429, background (journey) queries cool down so traces can recover. */
let rateLimitedUntil = 0;

function enqueueCx<T>(fn: () => Promise<T>, priority = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job: CxJob = {
      priority,
      run: async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      },
    };
    if (priority) {
      const firstNormal = cxQueue.findIndex((j) => !j.priority);
      if (firstNormal === -1) cxQueue.push(job);
      else cxQueue.splice(firstNormal, 0, job);
    } else {
      cxQueue.push(job);
    }
    pumpCx();
  });
}

function pumpCx() {
  while (cxActive < CX_MAX_CONCURRENT) {
    const job = cxQueue.shift();
    if (!job) return;
    cxActive += 1;
    void job.run().finally(() => {
      cxActive = Math.max(0, cxActive - 1);
      pumpCx();
    });
  }
}

const queryCache = new Map<string, { at: number; rows: Record<string, unknown>[] }>();
const QUERY_CACHE_TTL_MS = Number(process.env["QUERY_CACHE_TTL_MS"] || 180_000);
const QUERY_STALE_TTL_MS = Number(process.env["QUERY_STALE_TTL_MS"] || 15 * 60_000);
const QUERY_CACHE_MAX = Number(process.env["QUERY_CACHE_MAX"] || 80);

export type QueryDataprimeOpts = {
  /** Prefer this job over background journey queries (used by /api/traces). */
  priority?: boolean;
  /** Skip short-lived result cache. */
  noCache?: boolean;
  /** Override CX_TIER for this query (`frequent` | `archive`). */
  tier?: string;
};

function getCached(cacheKey: string, allowStale: boolean): Record<string, unknown>[] | null {
  const hit = queryCache.get(cacheKey);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age < QUERY_CACHE_TTL_MS) return hit.rows;
  if (allowStale && age < QUERY_STALE_TTL_MS) return hit.rows;
  return null;
}

function rememberQuery(cacheKey: string, rows: Record<string, unknown>[]) {
  queryCache.set(cacheKey, { at: Date.now(), rows });
  while (queryCache.size > QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next().value;
    if (oldest == null) break;
    queryCache.delete(oldest);
  }
}

function cxAuthArgs(): string[] {
  const cxProfile = process.env["CX_PROFILE"];
  const cxApiKey = process.env["CX_API_KEY"];
  const cxRegion = process.env["CX_REGION"];
  // Prefer named CLI profile (Thiago / Pomelo) when set — matches local `cx -p`.
  if (cxProfile) return ["--profile", cxProfile];
  if (cxApiKey) {
    const args = ["--api-key", cxApiKey];
    if (cxRegion) args.push("--region", cxRegion);
    return args;
  }
  return [];
}

function hasCxCreds(): boolean {
  return Boolean(
    process.env["CX_PROFILE"] ||
      process.env["CX_API_KEY"] ||
      process.env["CX_FORCE_DEFAULT_PROFILE"] === "1"
  );
}

/** Run a DataPrime query via the local `cx` CLI. */
export async function queryDataprime(
  query: string,
  range: TimeRange,
  limit = 100,
  opts: QueryDataprimeOpts = {}
): Promise<Record<string, unknown>[]> {
  if (!hasCxCreds()) {
    return [];
  }

  if (!opts.priority && Date.now() < rateLimitedUntil) {
    const start = toIso(range.start);
    const end = toIso(range.end);
    const tier = opts.tier || process.env["CX_TIER"] || "archive";
    const cacheKey = `${start}|${end}|${limit}|${tier}|${query}`;
    return getCached(cacheKey, true) || [];
  }

  const start = toIso(range.start);
  const end = toIso(range.end);
  const tier = opts.tier || process.env["CX_TIER"] || "archive";
  const cacheKey = `${start}|${end}|${limit}|${tier}|${query}`;
  if (!opts.noCache) {
    const fresh = getCached(cacheKey, false);
    if (fresh) return fresh;
  }

  const cxBin = process.env["CX_BIN"] || "cx";
  const args = [
    ...cxAuthArgs(),
    "dataprime",
    "query",
    "--tier",
    tier,
    "--start",
    start,
    "--end",
    end,
    "--limit",
    String(limit),
    "-o",
    "json",
    query,
  ];

  return enqueueCx(async () => {
    if (!opts.noCache) {
      const fresh = getCached(cacheKey, false);
      if (fresh) return fresh;
    }

    let lastError = "Coralogix query failed";
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { stdout, stderr } = await execFileAsync(cxBin, args, {
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env },
          timeout: 55_000,
        });

        const combined = `${stdout}\n${stderr}`;
        const trimmed = stdout.trim();
        const jsonStart = trimmed.indexOf("[");
        const jsonObjStart = trimmed.indexOf("{");
        const preamble = jsonStart >= 0 ? trimmed.slice(0, jsonStart) : trimmed;
        const rateLimited = /429|Rate limited/i.test(combined);

        // Prefer a usable JSON payload even if cx also printed a 429 warning —
        // RUM Session Replay queries often return rows with a rate-limit notice
        // on stderr; discarding them left the UI with zero playable sessions.
        let payload = "";
        if (jsonStart >= 0 && (jsonObjStart < 0 || jsonStart <= jsonObjStart)) {
          payload = trimmed.slice(jsonStart);
        } else if (jsonObjStart >= 0) {
          payload = trimmed.slice(jsonObjStart);
        }

        if (payload) {
          try {
            const parsed = JSON.parse(payload);
            const rows = Array.isArray(parsed)
              ? parsed
              : Array.isArray(parsed?.records)
                ? parsed.records
                : [parsed];
            const flat = rows.map(flattenCxRecord);
            if (flat.length > 0) {
              rememberQuery(cacheKey, flat);
              return flat;
            }
          } catch {
            /* fall through to rate-limit / error handling */
          }
        }

        if (rateLimited) {
          lastError = "Coralogix rate limit (429). Wait a few seconds and retry.";
          rateLimitedUntil = Date.now() + 25_000 * (attempt + 1);
          const stale = getCached(cacheKey, true);
          if (stale && stale.length > 0 && attempt >= 2) return stale;
          const waitMs = opts.priority
            ? 3_500 * (attempt + 1)
            : 2_000 * (attempt + 1);
          await sleep(waitMs);
          continue;
        }
        if (/error from profile|API request failed/i.test(preamble)) {
          throw new Error(preamble.trim().split("\n").filter(Boolean).pop() || lastError);
        }

        if (!trimmed) return [];

        // Last resort parse (non-array payloads already attempted above)
        const parsed = JSON.parse(payload || trimmed);
        const rows = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.records)
            ? parsed.records
            : [parsed];

        const flat = rows.map(flattenCxRecord);
        // Do not cache empty results — rate-limit / transient misses would
        // pin the UI to zero Session Replay rows for the TTL window.
        if (flat.length > 0) rememberQuery(cacheKey, flat);
        return flat;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        const retryable =
          /429|Rate limited|ETIMEDOUT|ESOCKETTIMEDOUT|timed out|timeout|ECONNRESET|ENOTFOUND|socket hang up/i.test(
            message
          );
        if (retryable && attempt < 4) {
          if (/429|Rate limited/i.test(message)) {
            rateLimitedUntil = Date.now() + 25_000 * (attempt + 1);
          }
          await sleep(1500 * (attempt + 1));
          continue;
        }
        const stale = getCached(cacheKey, true);
        if (stale) return stale;
        if (!opts.priority) return [];
        throw new Error(`Coralogix query failed: ${message}`);
      }
    }
    const stale = getCached(cacheKey, true);
    if (stale) return stale;
    if (!opts.priority) return [];
    throw new Error(lastError);
  }, Boolean(opts.priority));
}

export type OllyAskResult = {
  chat_id: string;
  interaction_id?: string;
  status: string;
  response: string;
  interaction_mode?: string;
  model_choice?: string;
};

/** Ask Olly via `cx olly ask` (priority in the CLI queue). */
export async function askOlly(opts: {
  message: string;
  chatId?: string;
  model?: string;
  timeoutSec?: number;
}): Promise<OllyAskResult> {
  if (!hasCxCreds()) {
    throw new Error("Set CX_PROFILE or CX_API_KEY to talk to Olly.");
  }

  const cxBin = process.env["CX_BIN"] || "cx";
  const timeoutSec = opts.timeoutSec ?? 180;
  const args = [
    ...cxAuthArgs(),
    "-o",
    "json",
    "olly",
    "ask",
    opts.message,
    "--timeout",
    String(timeoutSec),
  ];
  if (opts.chatId) {
    args.push("--chat-id", opts.chatId);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }

  return enqueueCx(async () => {
    const { stdout, stderr } = await execFileAsync(cxBin, args, {
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      timeout: (timeoutSec + 30) * 1000,
    });

    const trimmed = stdout.trim();
    const combined = `${stdout}\n${stderr}`;
    if (/API request failed|error from profile|Error:/i.test(combined) && !trimmed.startsWith("[")) {
      const line =
        combined
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .find((l) => /Error:|failed|denied/i.test(l)) || "Olly request failed";
      throw new Error(line);
    }

    const jsonStart = trimmed.indexOf("[");
    const jsonObjStart = trimmed.indexOf("{");
    let payload = trimmed;
    if (jsonStart >= 0 && (jsonObjStart < 0 || jsonStart <= jsonObjStart)) {
      payload = trimmed.slice(jsonStart);
    } else if (jsonObjStart >= 0) {
      payload = trimmed.slice(jsonObjStart);
    }

    const parsed = JSON.parse(payload);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row || typeof row !== "object") {
      throw new Error("Empty Olly response");
    }

    return {
      chat_id: String(row.chat_id || ""),
      interaction_id: row.interaction_id ? String(row.interaction_id) : undefined,
      status: String(row.status || "unknown"),
      response: String(row.response || ""),
      interaction_mode: row.interaction_mode ? String(row.interaction_mode) : undefined,
      model_choice: row.model_choice ? String(row.model_choice) : undefined,
    };
  }, true);
}

/** Run a PromQL instant query via `cx metrics query`. */
export async function queryPromql(
  expr: string,
  opts: { time?: string; priority?: boolean } = {}
): Promise<number | null> {
  const series = await queryPromqlSeries(expr, opts);
  return series[0]?.value ?? null;
}

export type PromqlSample = {
  metric: Record<string, string>;
  value: number;
};

/** Instant PromQL → all series (first sample each). */
export async function queryPromqlSeries(
  expr: string,
  opts: { time?: string; priority?: boolean } = {}
): Promise<PromqlSample[]> {
  if (!hasCxCreds()) return [];

  const args = ["metrics", "query", expr];
  if (opts.time) args.push("--time", toIso(opts.time));

  const parsed = await runCxJson(args, {
    timeoutMs: 30_000,
    priority: opts.priority ?? true,
  });
  if (!Array.isArray(parsed)) return [];

  const out: PromqlSample[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as {
      metric?: Record<string, string>;
      value?: unknown[];
      values?: unknown[][];
    };
    const raw = r.value?.[1] ?? r.values?.[0]?.[1];
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out.push({ metric: r.metric || {}, value: n });
  }
  return out;
}

/** Range PromQL → flattened numeric points (first series). */
export async function queryPromqlRange(
  expr: string,
  opts: { start?: string; end?: string; step?: string; priority?: boolean } = {}
): Promise<number[]> {
  if (!hasCxCreds()) return [];

  const args = [
    "metrics",
    "query-range",
    expr,
    "--start",
    opts.start || "now-30m",
    "--end",
    opts.end || "now",
    "--step",
    opts.step || "1m",
  ];

  const parsed = await runCxJson(args, {
    timeoutMs: 45_000,
    priority: opts.priority ?? true,
  });
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== "object") return [];
  const values = (parsed[0] as { values?: unknown[][] }).values;
  if (!Array.isArray(values)) return [];
  const points: number[] = [];
  for (const pair of values) {
    const raw = pair?.[1];
    if (raw == null || raw === "" || raw === "NaN") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) points.push(n);
  }
  return points;
}

/**
 * Run an arbitrary `cx` subcommand and parse the first JSON value from stdout.
 * Used by Infra / Kubernetes lookups (`cx infra resources …`).
 */
export async function runCxJson(
  commandArgs: string[],
  opts: { timeoutMs?: number; priority?: boolean } = {}
): Promise<unknown | null> {
  if (!hasCxCreds()) return null;

  const cxBin = process.env["CX_BIN"] || "cx";
  const args = [...cxAuthArgs(), "-o", "json", ...commandArgs];

  return enqueueCx(async () => {
    try {
      const { stdout, stderr } = await execFileAsync(cxBin, args, {
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env },
        timeout: opts.timeoutMs ?? 45_000,
      });
      // Prefer stdout alone — cx often prints progress on stderr ("Fetching…"),
      // and concatenating that breaks JSON.parse.
      const candidates = [stdout, `${stdout}\n${stderr}`];
      for (const raw of candidates) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const arr = trimmed.indexOf("[");
        const obj = trimmed.indexOf("{");
        let payload = "";
        if (arr >= 0 && (obj < 0 || arr <= obj)) {
          const end = trimmed.lastIndexOf("]");
          payload = end >= arr ? trimmed.slice(arr, end + 1) : trimmed.slice(arr);
        } else if (obj >= 0) {
          const end = trimmed.lastIndexOf("}");
          payload = end >= obj ? trimmed.slice(obj, end + 1) : trimmed.slice(obj);
        }
        if (!payload) continue;
        try {
          return JSON.parse(payload);
        } catch {
          /* try next candidate */
        }
      }
      return null;
    } catch {
      return null;
    }
  }, opts.priority === true);
}

/** List SLO summaries via `cx slos list`. */
export async function listSlosRaw(): Promise<Record<string, unknown>[]> {
  if (!hasCxCreds()) return [];

  const parsed = await runCxJson(["slos", "list"]);
  return Array.isArray(parsed) ? parsed : [];
}

/** Get a full SLO definition via `cx slos get`. */
export async function getSloRaw(id: string): Promise<Record<string, unknown> | null> {
  if (!hasCxCreds() || !id) return null;

  const cxBin = process.env["CX_BIN"] || "cx";
  const args = [...cxAuthArgs(), "-o", "json", "slos", "get", id];

  return enqueueCx(async () => {
    try {
      const { stdout } = await execFileAsync(cxBin, args, {
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env },
        timeout: 30_000,
      });
      const trimmed = stdout.trim();
      const jsonStart = trimmed.indexOf("{");
      if (jsonStart < 0) return null;
      const parsed = JSON.parse(trimmed.slice(jsonStart));
      return (parsed?.slo as Record<string, unknown>) || parsed || null;
    } catch {
      return null;
    }
  });
}

export function coralogixUiBase(): string {
  return (
    process.env["NEXT_PUBLIC_CORALOGIX_UI_BASE"] ||
    process.env["CORALOGIX_UI_BASE"] ||
    "https://onlineboutique-dev.app.cx498.coralogix.com"
  );
}

/** Deep-link into Coralogix RUM Session Replay player.
 * Route is `#/rum/session?session-event-id=…&timestamp=…&is-archive=false`.
 * Recordings for recent sessions live in Frequent Search (high), not archive.
 */
export function sessionReplayUrl(
  sessionId: string,
  opts: {
    timestamp?: number;
    userName?: string;
    hasRecording?: boolean;
    hasScreenshot?: boolean;
    isArchive?: boolean;
  } = {}
): string {
  const base = coralogixUiBase().replace(/\/$/, "");
  const params = new URLSearchParams({
    "session-event-id": sessionId,
    "has-recording": String(opts.hasRecording ?? true),
    "has-screenshot": String(opts.hasScreenshot ?? false),
    "is-archive": String(opts.isArchive ?? false),
  });
  if (opts.timestamp != null && Number.isFinite(opts.timestamp)) {
    params.set("timestamp", String(Math.trunc(opts.timestamp)));
  }
  if (opts.userName) {
    params.set("user-name", opts.userName);
  }
  return `${base}/#/rum/session?${params.toString()}`;
}

/** Deep-link into Coralogix Explore for logs/spans with a time range (DataPrime).
 * Always targets Default / spans|logs (All Traces / All Logs), never Frequent Search.
 * Span-metric lights drill into matching spans (spansView=spans by default).
 */
export function exploreUrl(opts: {
  kind: "logs" | "tracing";
  query?: string;
  start: string;
  end: string;
  traceId?: string;
  spansView?: "spans" | "traces";
}): string {
  const base = coralogixUiBase().replace(/\/$/, "");
  const from = new Date(opts.start).getTime();
  const to = new Date(opts.end).getTime();
  const dataset = opts.kind === "tracing" ? "spans" : "logs";

  if (opts.kind === "tracing" && opts.traceId) {
    const params = new URLSearchParams({
      queryType: "dataprime",
      dataset: "spans",
      page: "traces",
      spansView: "traces",
      from: String(from),
      to: String(to),
      query: `source spans | filter $d.traceID == '${opts.traceId}' || $m.traceId == '${opts.traceId}'`,
    });
    return `${base}/#/explore?${params.toString()}`;
  }

  let query = opts.query || "";
  if (opts.kind === "tracing") {
    query = query.replace(/\bsource\s+frequentsearch\/spans\b/gi, "source spans");
    if (query && !/^\s*source\s+/i.test(query)) {
      query = `source spans | ${query}`;
    }
  } else {
    query = query.replace(/\bsource\s+frequentsearch\/logs\b/gi, "source logs");
    if (query && !/^\s*source\s+/i.test(query)) {
      query = `source logs | ${query}`;
    }
  }

  const spansView = opts.spansView || (opts.kind === "tracing" ? "spans" : "traces");
  const params = new URLSearchParams({
    queryType: "dataprime",
    dataset,
    from: String(from),
    to: String(to),
  });
  if (opts.kind === "tracing") {
    params.set("page", spansView === "traces" ? "traces" : "spans");
    params.set("spansView", spansView);
  }
  if (query) {
    params.set("query", query);
  }

  return `${base}/#/explore?${params.toString()}`;
}
