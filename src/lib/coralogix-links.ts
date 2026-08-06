/** Client-safe Coralogix Explore deep links (no Node APIs). */

export function coralogixUiBaseClient(): string {
  return (
    process.env.NEXT_PUBLIC_CORALOGIX_UI_BASE ||
    "https://onlineboutique-dev.app.cx498.coralogix.com"
  ).replace(/\/$/, "");
}

export type SessionReplayLinkOpts = {
  /** Unix ms session_creation_date — required for the player time window. */
  timestamp?: number;
  userName?: string;
  hasRecording?: boolean;
  hasScreenshot?: boolean;
  /** `true` = Archive / Medium-Low; `false` = Frequent Search (high). */
  isArchive?: boolean;
};

/**
 * Deep-link into Coralogix RUM Session Replay player.
 * Matches the SPA route `rum/session` + query params (not `/session-recording/:id`,
 * which briefly loads then redirects to the home dashboard).
 *
 * Recordings are resolved from Frequent Search (high). Archive-only links show
 * "Session Not Found" unless `is-archive=true` and the blob exists there.
 * `timestamp` (session_creation_date ms) is required so the player window
 * (±1h) covers the session.
 */
export function sessionReplayUrl(
  sessionId: string,
  opts: SessionReplayLinkOpts = {}
): string {
  const base = coralogixUiBaseClient();
  const params = new URLSearchParams({
    "session-event-id": sessionId,
    "has-recording": String(opts.hasRecording ?? true),
    "has-screenshot": String(opts.hasScreenshot ?? false),
    // High / Frequent Search — where RUM recordings live for recent sessions
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

/** RUM Session Replay hub (sessions list with saved filter). */
const RUM_SESSIONS_QUERY_ID =
  process.env.NEXT_PUBLIC_RUM_SESSIONS_QUERY_ID ||
  "481602145864a609cec0612bf83bec90c81b2cc2055206ef3a9e6622";

export function sessionReplayHubUrl(opts?: { start?: string; end?: string }): string {
  const base = coralogixUiBaseClient();
  const now = Date.now();
  const from = opts?.start ? new Date(opts.start).getTime() : now - 15 * 60 * 1000;
  const to = opts?.end ? new Date(opts.end).getTime() : now;
  const params = new URLSearchParams({
    "rum-sessions-query-id": RUM_SESSIONS_QUERY_ID,
    "is-archive": "true",
    from: String(Number.isFinite(from) ? from : now - 15 * 60 * 1000),
    to: String(Number.isFinite(to) ? to : now),
    "rum-apps": "coralogixRum",
  });
  // Path-style SPA route — Archive tier toggle (not Frequent / traces).
  return `${base}/rum/sessions?${params.toString()}`;
}

/** Deep-link into Coralogix Infrastructure Explorer (Kubernetes catalog). */
export function infraExplorerUrl(opts: {
  menuItem?: "All" | "Clusters" | "Nodes" | "Pods" | "Namespaces" | "Deployments";
  name?: string;
  search?: string;
}): string {
  const base = coralogixUiBaseClient();
  const menuItem = opts.menuItem || "All";
  const params = new URLSearchParams({
    menu: "Kubernetes",
    menuItem,
  });
  const search = opts.search || (opts.name ? `Name: "${opts.name}"` : "");
  if (search) params.set("search", search);
  return `${base}/#/infrastructure/monitoring/catalog?${params.toString()}`;
}

export function exploreUrl(opts: {
  kind: "logs" | "tracing";
  query?: string;
  start: string;
  end: string;
  traceId?: string;
  /** Prefer list of spans (default) vs traces grouping — Pomelo-style drill-down. */
  spansView?: "spans" | "traces";
}): string {
  const base = coralogixUiBaseClient();
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
