/** Client-safe Coralogix Explore deep links (no Node APIs). */

export function exploreUrl(opts: {
  kind: "logs" | "tracing";
  query?: string;
  start: string;
  end: string;
  traceId?: string;
}): string {
  const base = (
    process.env.NEXT_PUBLIC_CORALOGIX_UI_BASE || "https://us2.app.coralogix.com"
  ).replace(/\/$/, "");
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
