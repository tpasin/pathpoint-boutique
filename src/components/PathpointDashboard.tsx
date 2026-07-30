"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { JourneySnapshot, Light, Stage, TraceHit } from "@/lib/types";
import { exploreUrl } from "@/lib/coralogix-links";

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(v: string): string {
  return new Date(v).toISOString();
}

const LIGHT: Record<Light, string> = {
  green: "#3FA266",
  yellow: "#C08532",
  red: "#CF2D56",
  grey: "#8A8A8A",
};

function StatusDot({ light, size = 10 }: { light: Light; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size,
        background: LIGHT[light],
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

function StageChevron({
  stage,
  index,
  onOpen,
  onTraces,
}: {
  stage: Stage;
  index: number;
  onOpen: () => void;
  onTraces: () => void;
}) {
  const accent = LIGHT[stage.light];
  const isFirst = index === 0;
  const notch = 18;
  const w = 200;
  const h = 78;
  const tip = w - 2;
  const path = isFirst
    ? `M 2 2 L ${tip - notch} 2 L ${tip} ${h / 2} L ${tip - notch} ${h - 2} L 2 ${h - 2} Z`
    : `M 2 2 L ${tip - notch} 2 L ${tip} ${h / 2} L ${tip - notch} ${h - 2} L 2 ${h - 2} L ${2 + notch} ${h / 2} Z`;

  return (
    <div className="stage-chevron">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
        <path d={path} fill="#151515" stroke="#333" strokeWidth={1.5} />
        <path d={path} fill="none" stroke={accent} strokeWidth={2.5} />
      </svg>
      <div className="stage-chevron-content" style={{ paddingLeft: isFirst ? 14 : 28 }}>
        <div className="stage-title-row">
          <StatusDot light={stage.light} size={11} />
          <strong>{stage.name}</strong>
        </div>
        <div className="stage-metric-row">
          <span className="stage-metric" style={{ color: accent }}>
            {stage.metric}
          </span>
          <span className="muted">{stage.metricLabel}</span>
        </div>
        <div className="stage-actions">
          <button type="button" className="btn-tiny" onClick={onOpen}>
            Open in Coralogix
          </button>
          <button type="button" className="btn-tiny" onClick={onTraces}>
            Traces
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PathpointDashboard() {
  const now = useMemo(() => new Date(), []);
  const [startLocal, setStartLocal] = useState(() =>
    toLocalInputValue(new Date(now.getTime() - 60 * 60 * 1000))
  );
  const [endLocal, setEndLocal] = useState(() => toLocalInputValue(now));
  const [data, setData] = useState<JourneySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<string>("checkout");
  const [stageTraces, setStageTraces] = useState<TraceHit[]>([]);
  const [tracesLoading, setTracesLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const rangeIso = useCallback(
    () => ({
      start: fromLocalInputValue(startLocal),
      end: fromLocalInputValue(endLocal),
    }),
    [startLocal, endLocal]
  );

  const loadJourney = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { start, end } = rangeIso();
      const res = await fetch(
        `/api/journey?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load journey");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [rangeIso]);

  const loadTraces = useCallback(
    async (stage: string) => {
      setSelectedStage(stage);
      setTracesLoading(true);
      try {
        const { start, end } = rangeIso();
        const res = await fetch(
          `/api/traces?stage=${encodeURIComponent(stage)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
        );
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to load traces");
        setStageTraces(json.traces || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setTracesLoading(false);
      }
    },
    [rangeIso]
  );

  useEffect(() => {
    void loadJourney();
  }, [loadJourney]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void loadJourney();
    }, 60_000);
    return () => clearInterval(id);
  }, [autoRefresh, loadJourney]);

  function applyPreset(minutes: number) {
    const end = new Date();
    const start = new Date(end.getTime() - minutes * 60 * 1000);
    setStartLocal(toLocalInputValue(start));
    setEndLocal(toLocalInputValue(end));
  }

  function openExplore(kind: "logs" | "tracing", query: string) {
    const { start, end } = rangeIso();
    window.open(exploreUrl({ kind, query, start, end }), "_blank", "noopener,noreferrer");
  }

  const critical = data?.stages.filter((s) => s.light === "red").length ?? 0;
  const degraded = data?.stages.filter((s) => s.light === "yellow").length ?? 0;
  const healthy = data?.stages.filter((s) => s.light === "green").length ?? 0;

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Pathpoint · Online Boutique</h1>
          <p className="subtitle">
            astronomy-demo journey · live Coralogix spans &amp; logs
            {data?.fetchedAt ? ` · fetched ${new Date(data.fetchedAt).toLocaleString()}` : ""}
          </p>
        </div>
        <div className="counts">
          <span>
            <StatusDot light="red" /> {critical} critical
          </span>
          <span>
            <StatusDot light="yellow" /> {degraded} degraded
          </span>
          <span>
            <StatusDot light="green" /> {healthy} healthy
          </span>
        </div>
      </header>

      <section className="controls">
        <div className="control-group">
          <label htmlFor="start">From</label>
          <input
            id="start"
            type="datetime-local"
            value={startLocal}
            onChange={(e) => setStartLocal(e.target.value)}
          />
        </div>
        <div className="control-group">
          <label htmlFor="end">To</label>
          <input
            id="end"
            type="datetime-local"
            value={endLocal}
            onChange={(e) => setEndLocal(e.target.value)}
          />
        </div>
        <div className="presets">
          <button type="button" className="btn" onClick={() => applyPreset(15)}>
            15m
          </button>
          <button type="button" className="btn" onClick={() => applyPreset(60)}>
            1h
          </button>
          <button type="button" className="btn" onClick={() => applyPreset(360)}>
            6h
          </button>
          <button type="button" className="btn" onClick={() => applyPreset(1440)}>
            24h
          </button>
        </div>
        <button type="button" className="btn primary" onClick={() => void loadJourney()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <label className="auto-refresh">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh 60s
        </label>
      </section>

      {error ? <div className="error">{error}</div> : null}

      <section>
        <div className="section-label">STAGES</div>
        <div className="stages-row">
          {(data?.stages || []).map((stage, i) => (
            <StageChevron
              key={stage.id}
              stage={stage}
              index={i}
              onOpen={() => {
                if (stage.explore) openExplore(stage.explore.kind, stage.explore.query);
              }}
              onTraces={() => void loadTraces(stage.id)}
            />
          ))}
          {!data && loading ? <p className="muted">Loading stages from Coralogix…</p> : null}
        </div>
      </section>

      <section>
        <div className="section-label">STEPS</div>
        <div className="steps-row">
          {(data?.stages || []).map((stage) => (
            <div key={stage.id} className="steps-col">
              {stage.steps.map((step, si) => (
                <button
                  key={step.id}
                  type="button"
                  className="step-box"
                  style={{ borderColor: LIGHT[step.light] }}
                  onClick={() => {
                    if (step.explore) openExplore(step.explore.kind, step.explore.query);
                  }}
                  title="Open related query in Coralogix"
                >
                  <span className="step-num">{si + 1}</span>
                  <span className="step-body">
                    <strong>{step.name}</strong>
                    <span className="muted">{step.metric}</span>
                  </span>
                  <StatusDot light={step.light} size={8} />
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="bottom-grid">
        <div>
          <div className="section-label">TOUCHPOINTS</div>
          <div className="panel">
            {(data?.touchpoints || []).map((tp) => (
              <button
                key={tp.name}
                type="button"
                className="touch-row"
                onClick={() => {
                  if (tp.explore) openExplore(tp.explore.kind, tp.explore.query);
                }}
              >
                <span className="touch-left">
                  <span
                    className="touch-sq"
                    style={{ background: LIGHT[tp.light] }}
                  />
                  {tp.name}
                </span>
                <strong>{tp.value}</strong>
              </button>
            ))}
          </div>
          {data?.links ? (
            <div className="quick-links">
              <a href={data.links.checkoutErrors} target="_blank" rel="noreferrer">
                Checkout errors
              </a>
              <a href={data.links.paymentErrors} target="_blank" rel="noreferrer">
                Payment errors
              </a>
              <a href={data.links.cartRedis} target="_blank" rel="noreferrer">
                Cart Redis logs
              </a>
              <a href={data.links.productCatalog} target="_blank" rel="noreferrer">
                Product catalog
              </a>
              <a href={data.links.allTraces} target="_blank" rel="noreferrer">
                All traces
              </a>
            </div>
          ) : null}
        </div>

        <div>
          <div className="section-label">
            TRACES · {selectedStage.toUpperCase()}
            {tracesLoading ? " (loading…)" : ""}
          </div>
          <div className="panel">
            {stageTraces.length === 0 && !tracesLoading ? (
              <p className="muted pad">
                Click <strong>Traces</strong> on a stage to pull recent failing / slow traces from
                Coralogix.
              </p>
            ) : null}
            {stageTraces.map((t) => (
              <a key={t.traceId} className="trace-row" href={t.url} target="_blank" rel="noreferrer">
                <code>{t.traceId.slice(0, 16)}…</code>
                <span>{t.operation}</span>
                <span className="muted">{t.durationMs.toFixed(0)} ms</span>
                {t.status ? <span className="badge">{t.status}</span> : null}
              </a>
            ))}
            {(data?.traces || []).length > 0 && stageTraces.length === 0 ? (
              <>
                <p className="muted pad">Recent checkout 500s from journey snapshot:</p>
                {data!.traces.map((t) => (
                  <a key={t.traceId} className="trace-row" href={t.url} target="_blank" rel="noreferrer">
                    <code>{t.traceId.slice(0, 16)}…</code>
                    <span>{t.operation}</span>
                    <span className="muted">{t.durationMs.toFixed(0)} ms</span>
                    <span className="badge">500</span>
                  </a>
                ))}
              </>
            ) : null}
          </div>
        </div>

        <div>
          <div className="section-label">BUSINESS KPI · TOP PRODUCTS</div>
          <div className="panel product-list">
            {(data?.products || []).map((p, i) => (
              <div key={p.id || p.name} className="product-row">
                <span className="muted">#{i + 1}</span>
                <strong>{p.name}</strong>
                <span>{p.units.toLocaleString()} units</span>
              </div>
            ))}
            {!data?.products?.length ? (
              <p className="muted pad">No AddItem data in this range.</p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
