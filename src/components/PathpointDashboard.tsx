"use client";

// @pathpoint-source panel:dashboard

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JourneySnapshot, Light, SloCard, Stage, TraceHit } from "@/lib/types";
import { exploreUrl, sessionReplayHubUrl, sessionReplayUrl } from "@/lib/coralogix-links";
import {
  githubEditUrl,
  githubViewUrl,
  sourceForBiz,
  sourceForKey,
  sourceForStage,
  sourceForStep,
  type SourceRef,
} from "@/lib/github-source";

type InfraLink = { name: string; url: string; resourceId?: string };
type K8sUsage = {
  cpu: string;
  cpuRequest: string;
  memory: string;
  memoryRequest: string;
  memoryTrend: { points: number[]; changePct: number | null; label: string };
  containers: { name: string; ready: boolean; restarts?: number }[];
  containerCount: number;
};
type K8sSnapshot = {
  cluster: InfraLink;
  namespace: InfraLink;
  deployments: InfraLink[];
  nodes: InfraLink[];
  pods: (InfraLink & { deployment: string; node?: string })[];
  usage?: K8sUsage;
  selection: {
    stage?: string;
    step?: string;
    deployments: string[];
    label: string;
  };
};

function stageFromBizId(id: string): string | undefined {
  if (id.includes("checkout")) return "checkout";
  if (id.includes("payment") || id.includes("charge")) return "payment";
  if (id.includes("cart") || id.includes("redis")) return "cart";
  if (id.includes("fulfill") || id.includes("ship") || id.includes("email"))
    return "fulfill";
  if (id.includes("catalog") || id.includes("browse") || id.includes("product"))
    return "browse";
  return undefined;
}

function MemorySparkline({ points }: { points: number[] }) {
  if (!points.length) {
    return <span className="muted">—</span>;
  }
  const w = 120;
  const h = 28;
  const pad = 2;
  const coords = points
    .map((p, i) => {
      const x = pad + (i / Math.max(1, points.length - 1)) * (w - pad * 2);
      const y = pad + (1 - p) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      className="k8s-spark"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden
    >
      <polyline
        fill="none"
        stroke="#3fa266"
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={coords}
      />
    </svg>
  );
}

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

const STAGE_LABELS: Record<string, string> = {
  browse: "BROWSE",
  cart: "CART",
  checkout: "CHECKOUT",
  payment: "PAYMENT",
  fulfill: "FULFILL",
};

type OllyMsg = { role: "user" | "olly"; text: string };

type OllyChat = {
  id: string;
  chatId: string | null;
  title: string;
  model: string;
  updatedAt: number;
  messages: OllyMsg[];
};

const OLLY_HISTORY_KEY = "pathpoint-olly-chats-v1";
const OLLY_HISTORY_MAX = 30;

function newOllyLocalId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ollyChatTitle(messages: OllyMsg[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first?.text) return "Empty chat";
  const t = first.text.replace(/\s+/g, " ").trim();
  return t.length > 56 ? `${t.slice(0, 56)}…` : t;
}

function loadOllyHistory(): OllyChat[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(OLLY_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OllyChat[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch {
    return [];
  }
}

function saveOllyHistory(chats: OllyChat[]) {
  if (typeof window === "undefined") return;
  const trimmed = chats
    .filter((c) => c.messages.length > 0)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, OLLY_HISTORY_MAX);
  localStorage.setItem(OLLY_HISTORY_KEY, JSON.stringify(trimmed));
}

function formatOllyWhen(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

type OllyBoxContext = {
  kind: "stage" | "step" | "touchpoint" | "product" | "trace";
  label: string;
  metric?: string;
  light?: Light;
  stageId?: string;
  stepId?: string;
  exploreKind?: "logs" | "tracing";
  exploreQuery?: string;
  extra?: string;
  /** Where this box is defined in the Pathpoint repo (GitHub deep-link). */
  source?: SourceRef;
};

type CtxMenu = {
  x: number;
  y: number;
  box: OllyBoxContext;
};

type AskDialog = {
  box: OllyBoxContext;
  draft: string;
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
  onOlly,
  onContextMenu,
}: {
  stage: Stage;
  index: number;
  onOpen: () => void;
  onTraces: () => void;
  onOlly: () => void;
  onContextMenu: (e: React.MouseEvent, box: OllyBoxContext) => void;
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

  const box: OllyBoxContext = {
    kind: "stage",
    label: STAGE_LABELS[stage.id] || stage.name,
    metric: `${stage.metric} ${stage.metricLabel}`,
    light: stage.light,
    stageId: stage.id,
    exploreKind: stage.explore?.kind,
    exploreQuery: stage.explore?.query,
    source: sourceForStage(stage.id),
  };

  return (
    <div
      className="stage-chevron"
      data-howto={stage.howto || `${stage.metric} ${stage.metricLabel}`}
      onContextMenu={(e) => onContextMenu(e, box)}
      title="Left-click actions below · Right-click: View Infrastructure / ask Olly"
    >
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
        <path d={path} fill="#151515" stroke="#333" strokeWidth={1.5} />
        <path d={path} fill="none" stroke={accent} strokeWidth={2.5} />
      </svg>
      <div className="stage-chevron-content" style={{ paddingLeft: isFirst ? 14 : 28 }}>
        <div className="stage-title-row">
          <StatusDot light={stage.light} size={11} />
          <strong>{STAGE_LABELS[stage.id] || stage.name}</strong>
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
          <button type="button" className="btn-tiny" onClick={onOlly}>
            Ask Olly
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
  const [traceFilter, setTraceFilter] = useState<"all" | "errors" | "ms">("all");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [ollyInput, setOllyInput] = useState("");
  const [ollyLocalId, setOllyLocalId] = useState(() => newOllyLocalId());
  const [ollyChatId, setOllyChatId] = useState<string | null>(null);
  const [ollyMessages, setOllyMessages] = useState<OllyMsg[]>([]);
  const [ollyHistory, setOllyHistory] = useState<OllyChat[]>([]);
  const [ollyLoading, setOllyLoading] = useState(false);
  const [ollyModel, setOllyModel] = useState("claude-haiku-4-5");
  const [ollyStage, setOllyStage] = useState<string>("checkout");
  const [cursorInput, setCursorInput] = useState("");
  const [cursorAgentId, setCursorAgentId] = useState<string | null>(null);
  const [cursorMessages, setCursorMessages] = useState<
    { role: "user" | "cursor"; text: string }[]
  >([]);
  const [cursorLoading, setCursorLoading] = useState(false);
  const [cursorStatus, setCursorStatus] = useState<{
    configured: boolean;
    enabled?: boolean;
    runtime: string;
    model: string;
    cwd?: string;
    cloudRepo?: string;
  } | null>(null);
  const [slos, setSlos] = useState<SloCard[]>([]);
  const [slosLoading, setSlosLoading] = useState(false);
  const [slosError, setSlosError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [askDialog, setAskDialog] = useState<AskDialog | null>(null);
  const [k8s, setK8s] = useState<K8sSnapshot | null>(null);
  const [k8sLoading, setK8sLoading] = useState(false);
  const [k8sError, setK8sError] = useState<string | null>(null);
  const askInputRef = useRef<HTMLInputElement>(null);
  const ollySectionRef = useRef<HTMLElement>(null);
  const k8sSectionRef = useRef<HTMLElement>(null);

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

  const loadK8s = useCallback(
    async (opts: { stage?: string; step?: string; label?: string }) => {
      setK8sLoading(true);
      setK8sError(null);
      try {
        const qs = new URLSearchParams();
        if (opts.stage) qs.set("stage", opts.stage);
        if (opts.step) qs.set("step", opts.step);
        if (opts.label) qs.set("label", opts.label);
        const res = await fetch(`/api/k8s?${qs.toString()}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to load Kubernetes");
        setK8s(json);
      } catch (err) {
        setK8sError(err instanceof Error ? err.message : String(err));
      } finally {
        setK8sLoading(false);
      }
    },
    []
  );

  const selectK8s = useCallback(
    (opts: { stage?: string; step?: string; label?: string; scroll?: boolean }) => {
      if (opts.stage) setSelectedStage(opts.stage);
      void loadK8s(opts);
      if (opts.scroll) {
        requestAnimationFrame(() => {
          const el = k8sSectionRef.current;
          if (!el) return;
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.remove("k8s-flash");
          // re-trigger CSS animation
          void el.offsetWidth;
          el.classList.add("k8s-flash");
          window.setTimeout(() => el.classList.remove("k8s-flash"), 1600);
        });
      }
    },
    [loadK8s]
  );

  useEffect(() => {
    void loadJourney();
  }, [loadJourney]);

  // Restore Olly chats from this browser.
  useEffect(() => {
    const history = loadOllyHistory();
    setOllyHistory(history);
    if (history.length > 0) {
      const latest = history[0];
      setOllyLocalId(latest.id);
      setOllyChatId(latest.chatId);
      setOllyMessages(latest.messages);
      if (latest.model) setOllyModel(latest.model);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/cursor");
        const json = await res.json();
        setCursorStatus(json);
      } catch {
        setCursorStatus({
          configured: false,
          enabled: false,
          runtime: "local",
          model: "composer-2.5",
        });
      }
    })();
  }, []);

  // Persist the active thread whenever it has messages.
  useEffect(() => {
    if (ollyMessages.length === 0) return;
    const entry: OllyChat = {
      id: ollyLocalId,
      chatId: ollyChatId,
      title: ollyChatTitle(ollyMessages),
      model: ollyModel,
      updatedAt: Date.now(),
      messages: ollyMessages,
    };
    setOllyHistory((prev) => {
      const next = [entry, ...prev.filter((c) => c.id !== entry.id)];
      saveOllyHistory(next);
      return next;
    });
  }, [ollyMessages, ollyChatId, ollyLocalId, ollyModel]);

  // Keep the Traces panel filled with the selected stage's live hits.
  useEffect(() => {
    void loadTraces(selectedStage);
  }, [loadTraces, selectedStage]);

  // Initial Kubernetes context (checkout); box clicks call selectK8s.
  useEffect(() => {
    void loadK8s({ stage: "checkout", label: "CHECKOUT" });
  }, [loadK8s]);

  const isErrorTrace = useCallback((t: TraceHit) => {
    const s = (t.status || "").toLowerCase();
    if (!s) return false;
    if (s === "error" || s.startsWith("grpc")) return true;
    const n = Number(s);
    return Number.isFinite(n) && n >= 400;
  }, []);

  const displayedTraces = useMemo(() => {
    const rows = [...stageTraces];
    if (traceFilter === "errors") {
      return rows.filter(isErrorTrace);
    }
    if (traceFilter === "ms") {
      return rows.sort((a, b) => b.durationMs - a.durationMs);
    }
    return rows;
  }, [stageTraces, traceFilter, isErrorTrace]);

  const displayedSnapshotTraces = useMemo(() => {
    const rows = [...(data?.traces || [])];
    if (traceFilter === "errors") {
      return rows.filter(isErrorTrace);
    }
    if (traceFilter === "ms") {
      return rows.sort((a, b) => b.durationMs - a.durationMs);
    }
    return rows;
  }, [data?.traces, traceFilter, isErrorTrace]);

  const loadSlos = useCallback(async () => {
    setSlosLoading(true);
    setSlosError(null);
    try {
      const { start, end } = rangeIso();
      const res = await fetch(
        `/api/slos?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load SLOs");
      setSlos(json.slos || []);
    } catch (err) {
      setSlosError(err instanceof Error ? err.message : String(err));
    } finally {
      setSlosLoading(false);
    }
  }, [rangeIso]);

  useEffect(() => {
    void loadSlos();
  }, [loadSlos]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void loadJourney();
      void loadSlos();
    }, 60_000);
    return () => clearInterval(id);
  }, [autoRefresh, loadJourney, loadSlos]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  useEffect(() => {
    if (askDialog) {
      requestAnimationFrame(() => askInputRef.current?.focus());
    }
  }, [askDialog]);

  const startNewOllyChat = useCallback(() => {
    setOllyLocalId(newOllyLocalId());
    setOllyChatId(null);
    setOllyMessages([]);
    setOllyInput("");
  }, []);

  const openOllyChat = useCallback(
    (id: string) => {
      if (id === "__new__") {
        startNewOllyChat();
        return;
      }
      const chat = ollyHistory.find((c) => c.id === id);
      if (!chat) return;
      setOllyLocalId(chat.id);
      setOllyChatId(chat.chatId);
      setOllyMessages(chat.messages);
      if (chat.model) setOllyModel(chat.model);
      setOllyInput("");
    },
    [ollyHistory, startNewOllyChat]
  );

  const deleteOllyChat = useCallback(
    (id: string) => {
      setOllyHistory((prev) => {
        const next = prev.filter((c) => c.id !== id);
        saveOllyHistory(next);
        return next;
      });
      if (ollyLocalId === id) startNewOllyChat();
    },
    [ollyLocalId, startNewOllyChat]
  );

  const scrollToOlly = useCallback(() => {
    ollySectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const askOlly = useCallback(
    async (opts?: {
      message?: string;
      stage?: string;
      box?: OllyBoxContext;
      displayLabel?: string;
    }) => {
      const text = (opts?.message ?? ollyInput).trim();
      if (!text && !opts?.stage && !opts?.box) return;
      setOllyLoading(true);
      setError(null);
      const display =
        opts?.displayLabel ||
        text ||
        (opts?.stage ? `Analyze ${STAGE_LABELS[opts.stage] || opts.stage} stage` : "Ask Olly");
      setOllyMessages((prev) => [...prev, { role: "user", text: display }]);
      if (!opts?.message) setOllyInput("");
      scrollToOlly();
      try {
        const { start, end } = rangeIso();
        const res = await fetch("/api/olly", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text || undefined,
            stage: opts?.stage || undefined,
            box: opts?.box || undefined,
            chatId: ollyChatId || undefined,
            model: ollyModel,
            start,
            end,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Olly request failed");
        if (json.chat_id) setOllyChatId(String(json.chat_id));
        setOllyMessages((prev) => [
          ...prev,
          { role: "olly", text: String(json.response || "(empty response)") },
        ]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setOllyLoading(false);
      }
    },
    [ollyInput, ollyChatId, ollyModel, rangeIso, scrollToOlly]
  );

  const askCursor = useCallback(
    async (opts?: { message?: string }) => {
      const text = (opts?.message ?? cursorInput).trim();
      if (!text) return;
      setCursorLoading(true);
      setError(null);
      setCursorMessages((prev) => [...prev, { role: "user", text }]);
      if (!opts?.message) setCursorInput("");
      try {
        const { start, end } = rangeIso();
        const res = await fetch("/api/cursor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            agentId: cursorAgentId || undefined,
            start,
            end,
            stage: selectedStage,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || json.response || "Cursor request failed");
        if (json.agentId) setCursorAgentId(String(json.agentId));
        setCursorMessages((prev) => [
          ...prev,
          {
            role: "cursor",
            text: String(json.response || "(empty response)"),
          },
        ]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCursorLoading(false);
      }
    },
    [cursorInput, cursorAgentId, rangeIso, selectedStage]
  );

  function openContextMenu(e: React.MouseEvent, box: OllyBoxContext) {
    e.preventDefault();
    e.stopPropagation();
    const pad = 8;
    const menuW = 240;
    const menuH = 200;
    const x = Math.min(e.clientX, window.innerWidth - menuW - pad);
    const y = Math.min(e.clientY, window.innerHeight - menuH - pad);
    setAskDialog(null);
    setCtxMenu({ x: Math.max(pad, x), y: Math.max(pad, y), box });
  }

  function viewInfrastructure(box: OllyBoxContext) {
    setCtxMenu(null);
    selectK8s({
      stage: box.stageId,
      step: box.stepId,
      label: box.label,
      scroll: true,
    });
  }

  function openAskDialog(box: OllyBoxContext, preset?: string) {
    setCtxMenu(null);
    setAskDialog({
      box,
      draft: preset || "",
    });
  }

  function submitAskDialog() {
    if (!askDialog) return;
    const q = askDialog.draft.trim();
    if (!q) return;
    const { box } = askDialog;
    setAskDialog(null);
    void askOlly({
      message: q,
      box,
      displayLabel: `${box.label}: ${q}`,
    });
  }

  function applyPreset(minutes: number) {
    const end = new Date();
    const start = new Date(end.getTime() - minutes * 60 * 1000);
    setStartLocal(toLocalInputValue(start));
    setEndLocal(toLocalInputValue(end));
  }

  function openExplore(kind: "logs" | "tracing", query: string) {
    const { start, end } = rangeIso();
    // Lights use PromQL span metrics; Explore opens matching spans.
    window.open(
      exploreUrl({
        kind,
        query,
        start,
        end,
        spansView: kind === "tracing" ? "spans" : undefined,
      }),
      "_blank",
      "noopener,noreferrer"
    );
  }

  const critical = data?.stages.filter((s) => s.light === "red").length ?? 0;
  const degraded = data?.stages.filter((s) => s.light === "yellow").length ?? 0;
  const healthy = data?.stages.filter((s) => s.light === "green").length ?? 0;
  const stageTitle =
    STAGE_LABELS[selectedStage] || selectedStage.toUpperCase();

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Pathpoint · Online Boutique</h1>
          <p className="subtitle">
            astronomy-demo journey · span metrics lights · spans drill-down
            {data?.dataSource ? ` · ${data.dataSource}` : ""}
            {data?.fetchedAt
              ? ` · updated ${new Date(data.fetchedAt).toLocaleString("en")}`
              : ""}
            {" · right-click any box to ask Olly / View Infrastructure"}
          </p>
        </div>
        <div className="counts">
          <a
            className="docs-link"
            href="/architecture"
            title="Architecture, traffic lights, and data flows"
          >
            Architecture
          </a>
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
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            void loadJourney();
            void loadSlos();
          }}
          disabled={loading || slosLoading}
        >
          {loading || slosLoading ? "Refreshing…" : "Refresh"}
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
                selectK8s({ stage: stage.id, label: STAGE_LABELS[stage.id] || stage.name });
                if (stage.explore) openExplore(stage.explore.kind, stage.explore.query);
              }}
              onTraces={() => {
                selectK8s({ stage: stage.id, label: STAGE_LABELS[stage.id] || stage.name });
                setSelectedStage(stage.id);
              }}
              onOlly={() => {
                selectK8s({ stage: stage.id, label: STAGE_LABELS[stage.id] || stage.name });
                void askOlly({ stage: stage.id });
              }}
              onContextMenu={openContextMenu}
            />
          ))}
          {!data && loading ? (
            <p className="muted">Loading stages from Coralogix…</p>
          ) : null}
        </div>
      </section>

      <section>
        <div className="section-label">STEPS</div>
        <div className="steps-row">
          {(data?.stages || []).map((stage) => (
            <div key={stage.id} className="steps-col">
              {stage.steps.map((step, si) => {
                const box: OllyBoxContext = {
                  kind: "step",
                  label: `${STAGE_LABELS[stage.id] || stage.name} · ${step.name}`,
                  metric: step.metric,
                  light: step.light,
                  stageId: stage.id,
                  stepId: step.id,
                  exploreKind: step.explore?.kind,
                  exploreQuery: step.explore?.query,
                  source: sourceForStep(step.id),
                };
                return (
                  <button
                    key={step.id}
                    type="button"
                    className="step-box"
                    data-howto={step.howto || step.metric}
                    style={{ borderColor: LIGHT[step.light] }}
                    onClick={() => {
                      selectK8s({
                        stage: stage.id,
                        step: step.id,
                        label: `${STAGE_LABELS[stage.id] || stage.name} · ${step.name}`,
                        scroll: true,
                      });
                      if (step.explore) openExplore(step.explore.kind, step.explore.query);
                    }}
                    onContextMenu={(e) => openContextMenu(e, box)}
                    title="Left-click: Coralogix · Right-click: View Infrastructure / ask Olly"
                  >
                    <span className="step-num">{si + 1}</span>
                    <span className="step-body">
                      <strong>{step.name}</strong>
                      <span className="muted">{step.metric}</span>
                    </span>
                    <StatusDot light={step.light} size={8} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="biz-section">
        <div className="section-label">BUSINESS KPIs</div>
        <div className="biz-grid">
          {(data?.business || []).map((m) => {
            const box = {
              kind: "touchpoint" as const,
              label: m.label,
              metric: `${m.value}${m.hint ? ` · ${m.hint}` : ""}`,
              light: m.light,
              stageId: stageFromBizId(m.id),
              exploreKind: m.explore?.kind,
              exploreQuery: m.explore?.query,
              source: sourceForBiz(m.id),
            };
            return (
              <button
                key={m.id}
                type="button"
                className="biz-card"
                data-howto={m.howto || m.hint || m.label}
                style={{ borderColor: LIGHT[m.light] }}
                onClick={() => {
                  const stage = stageFromBizId(m.id);
                  if (stage) {
                    selectK8s({ stage, label: m.label, scroll: true });
                  }
                  if (m.explore) openExplore(m.explore.kind, m.explore.query);
                }}
                onContextMenu={(e) => openContextMenu(e, box)}
                title="Left-click: Kubernetes + Coralogix · Right-click: ask Olly"
              >
                <span className="muted">{m.label}</span>
                <strong style={{ color: LIGHT[m.light] }}>{m.value}</strong>
                {m.hint ? <span className="muted hint">{m.hint}</span> : null}
              </button>
            );
          })}
          {!data?.business?.length && loading ? (
            <p className="muted">Loading business KPIs…</p>
          ) : null}
        </div>
      </section>

      <section className="bottom-grid">
        <div>
          <div className="section-label">TOUCHPOINTS</div>
          <div className="panel">
            {(data?.touchpoints || []).map((tp) => {
              const box: OllyBoxContext = {
                kind: "touchpoint",
                label: tp.name,
                metric: tp.value,
                light: tp.light,
                exploreKind: tp.explore?.kind,
                exploreQuery: tp.explore?.query,
                source: sourceForKey("panel:touchpoints"),
              };
              return (
                <button
                  key={tp.name}
                  type="button"
                  className="touch-row"
                  onClick={() => {
                    const stage =
                      /checkout/i.test(tp.name)
                        ? "checkout"
                        : /charge|payment/i.test(tp.name)
                          ? "payment"
                          : /cart|redis/i.test(tp.name)
                            ? "cart"
                            : /catalog|product|browse/i.test(tp.name)
                              ? "browse"
                              : /ship|email|empty|fulfill/i.test(tp.name)
                                ? "fulfill"
                                : undefined;
                    if (stage) selectK8s({ stage, label: tp.name, scroll: true });
                    if (tp.explore) openExplore(tp.explore.kind, tp.explore.query);
                  }}
                  onContextMenu={(e) => openContextMenu(e, box)}
                  title="Right-click to ask Olly about this touchpoint"
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
              );
            })}
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
              <a href={data.links.rumSessions} target="_blank" rel="noreferrer">
                RUM logs
              </a>
              <a
                href={sessionReplayHubUrl({
                  start: rangeIso().start,
                  end: rangeIso().end,
                })}
                target="_blank"
                rel="noreferrer"
              >
                Session Replay hub
              </a>
            </div>
          ) : null}
        </div>

        <div>
          <div className="section-label">
            TRACES · {stageTitle}
            {tracesLoading ? " (loading…)" : ""}
          </div>
          <div className="panel">
            <div className="trace-filter-bar" role="group" aria-label="Filter traces">
              <button
                type="button"
                className={`btn-tiny${traceFilter === "all" ? " active" : ""}`}
                onClick={() => setTraceFilter("all")}
              >
                All
              </button>
              <button
                type="button"
                className={`btn-tiny${traceFilter === "errors" ? " active" : ""}`}
                onClick={() => setTraceFilter("errors")}
              >
                Errors
              </button>
              <button
                type="button"
                className={`btn-tiny${traceFilter === "ms" ? " active" : ""}`}
                onClick={() => setTraceFilter("ms")}
              >
                By ms
              </button>
              <span className="muted trace-filter-count">
                {displayedTraces.length}
                {traceFilter !== "all" ? ` / ${stageTraces.length}` : ""} shown
              </span>
            </div>
            {stageTraces.length === 0 && !tracesLoading ? (
              <p className="muted pad">
                Click <strong>Traces</strong> on a stage to pull slow or failing traces from
                Coralogix. Right-click a trace to ask Olly.
              </p>
            ) : null}
            {stageTraces.length > 0 && displayedTraces.length === 0 ? (
              <p className="muted pad">No traces match this filter.</p>
            ) : null}
            {displayedTraces.map((t) => {
              const box: OllyBoxContext = {
                kind: "trace",
                label: `Trace ${t.traceId.slice(0, 16)}…`,
                metric: `${t.operation} · ${t.durationMs.toFixed(0)} ms${t.status ? ` · ${t.status}` : ""}`,
                stageId: selectedStage,
                exploreKind: "tracing",
                exploreQuery: `source spans | filter $d.traceID == '${t.traceId}'`,
                extra: `traceId=${t.traceId}`,
                source: sourceForKey("panel:traces"),
              };
              return (
                <a
                  key={t.traceId}
                  className="trace-row"
                  href={t.url}
                  target="_blank"
                  rel="noreferrer"
                  onContextMenu={(e) => openContextMenu(e, box)}
                >
                  <code>{t.traceId.slice(0, 16)}…</code>
                  <span>{t.operation}</span>
                  <span className="muted">{t.durationMs.toFixed(0)} ms</span>
                  {t.status ? <span className="badge">{t.status}</span> : null}
                </a>
              );
            })}
            {(data?.traces || []).length > 0 && stageTraces.length === 0 ? (
              <>
                <p className="muted pad">Recent checkout 500s (snapshot):</p>
                {displayedSnapshotTraces.map((t) => {
                  const box: OllyBoxContext = {
                    kind: "trace",
                    label: `Trace ${t.traceId.slice(0, 16)}…`,
                    metric: `${t.operation} · ${t.durationMs.toFixed(0)} ms · 500`,
                    stageId: "checkout",
                    exploreKind: "tracing",
                    exploreQuery: `source spans | filter $d.traceID == '${t.traceId}'`,
                    extra: `traceId=${t.traceId}`,
                    source: sourceForKey("panel:traces"),
                  };
                  return (
                    <a
                      key={t.traceId}
                      className="trace-row"
                      href={t.url}
                      target="_blank"
                      rel="noreferrer"
                      onContextMenu={(e) => openContextMenu(e, box)}
                    >
                      <code>{t.traceId.slice(0, 16)}…</code>
                      <span>{t.operation}</span>
                      <span className="muted">{t.durationMs.toFixed(0)} ms</span>
                      <span className="badge">500</span>
                    </a>
                  );
                })}
              </>
            ) : null}
          </div>
        </div>

        <div>
          <div className="section-label">BUSINESS KPI · TOP PRODUCTS</div>
          <div className="panel product-list">
            {(data?.products || []).length > 0 ? (
              <div className="product-row product-header" aria-hidden="true">
                <span className="muted">#</span>
                <strong>Product</strong>
                <span className="muted">Units</span>
                <span className="muted">Amount</span>
              </div>
            ) : null}
            {(data?.products || []).map((p, i) => {
              const amount =
                p.revenue > 0
                  ? p.revenue.toLocaleString("en", {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: 0,
                    })
                  : "—";
              const box: OllyBoxContext = {
                kind: "product",
                label: p.name,
                metric: `${p.units.toLocaleString("en")} units · ${amount}`,
                extra: `productId=${p.id}`,
                exploreKind: "logs",
                exploreQuery: `source logs | filter $l.subsystemname == 'cart' && $d.message ~ 'AddItemAsync' && $d.productId == '${p.id}'`,
                source: sourceForKey("panel:products"),
              };
              return (
                <div
                  key={p.id || p.name}
                  className="product-row"
                  onContextMenu={(e) => openContextMenu(e, box)}
                  title="Right-click to ask Olly about this product"
                >
                  <span className="muted">#{i + 1}</span>
                  <strong className="product-name" title={p.name}>
                    {p.name}
                  </strong>
                  <span>{p.units.toLocaleString("en")}</span>
                  <span className="product-amount">{amount}</span>
                </div>
              );
            })}
            {!data?.products?.length ? (
              <p className="muted pad">No AddItem data in this range.</p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="audience-grid">
        <div>
          <div className="section-label">TOP USERS · SELECTED RANGE</div>
          <div className="panel">
            {(data?.topUsers || []).map((u) => {
              const box: OllyBoxContext = {
                kind: "touchpoint",
                label: u.name,
                metric: `${u.city}, ${u.country} · ${u.events} events`,
                extra: `userId=${u.userId}`,
                exploreKind: u.explore?.kind,
                exploreQuery: u.explore?.query,
                source: sourceForKey("panel:top-users"),
              };
              return (
                <div
                  key={u.userId || u.name}
                  className="user-row"
                  onContextMenu={(e) => openContextMenu(e, box)}
                >
                  <div className="user-main">
                    <strong>{u.name}</strong>
                    <span className="muted">
                      {u.city}, {u.country}
                    </span>
                  </div>
                  <span className="user-events">{u.events.toLocaleString("en")}</span>
                  {u.hasRecording && u.replayUrl ? (
                    <a
                      className="btn-tiny"
                      href={u.replayUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Replay
                    </a>
                  ) : u.explore ? (
                    <button
                      type="button"
                      className="btn-tiny"
                      onClick={() => openExplore(u.explore!.kind, u.explore!.query)}
                    >
                      RUM
                    </button>
                  ) : null}
                </div>
              );
            })}
            {!data?.topUsers?.length ? (
              <p className="muted pad">No RUM shoppers in this range.</p>
            ) : null}
          </div>
        </div>

        <div>
          <div className="section-label">SESSION REPLAY · SELECTED RANGE</div>
          <div className="panel">
            <div className="replay-hero">
              <div>
                <strong>
                  {(data?.business || []).find((m) => m.id === "recordings")?.value ??
                    data?.sessionReplays?.length ??
                    0}{" "}
                  recordings
                </strong>
                <p className="muted">
                  Playable Session Replay only: <code>hasRecording</code> with
                  real <code>isSnapshotEvent</code> frames (≥5), not
                  error-triggered screenshots. Showing top{" "}
                  {data?.sessionReplays?.length ?? 0} below.
                </p>
              </div>
              <a
                className="btn primary"
                href={
                  data?.links.sessionReplay ||
                  sessionReplayHubUrl({
                    start: rangeIso().start,
                    end: rangeIso().end,
                  })
                }
                target="_blank"
                rel="noreferrer"
              >
                Open Session Replay
              </a>
            </div>
            {(data?.sessionReplays || []).map((s) => {
              const box: OllyBoxContext = {
                kind: "touchpoint",
                label: `Replay · ${s.userName}`,
                metric: `${s.city}, ${s.country} · ${s.events} events`,
                extra: `sessionId=${s.sessionId}`,
                exploreKind: "logs",
                exploreQuery: `source logs | filter $d.cx_rum.session_context.session_id == '${s.sessionId}'`,
                source: sourceForKey("panel:session-replay"),
              };
              return (
                <a
                  key={s.sessionId}
                  className="replay-row"
                  href={
                    s.replayUrl ||
                    sessionReplayUrl(s.sessionId, {
                      userName: s.userName,
                      hasRecording: true,
                      hasScreenshot: false,
                      isArchive: false,
                    })
                  }
                  target="_blank"
                  rel="noreferrer"
                  onContextMenu={(e) => openContextMenu(e, box)}
                  title="Open session replay in Coralogix"
                >
                  <span className="replay-dot" />
                  <span className="replay-body">
                    <strong>{s.userName}</strong>
                    <span className="muted">
                      {s.city}, {s.country}
                    </span>
                  </span>
                  <code>{s.sessionId.slice(0, 8)}…</code>
                  <span className="muted">{s.events.toLocaleString("en")}</span>
                </a>
              );
            })}
            {!data?.sessionReplays?.length ? (
              <p className="muted pad">
                No recorded sessions in this window. Try expanding the time range.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="k8s-section" ref={k8sSectionRef}>
        <div className="section-label">
          KUBERNETES · INFRA EXPLORER
          {k8s?.selection?.label ? ` · ${k8s.selection.label}` : ""}
          {k8sLoading ? " (loading…)" : ""}
        </div>
        <div className="panel k8s-panel">
          {k8sError ? <p className="error pad">{k8sError}</p> : null}
          {!k8s && !k8sLoading && !k8sError ? (
            <p className="muted pad">Click any stage, step, or KPI box to populate cluster context.</p>
          ) : null}
          {k8s ? (
            <>
            <div className="k8s-grid">
              <div className="k8s-field">
                <span className="k8s-field-label">Cluster</span>
                <a href={k8s.cluster.url} target="_blank" rel="noreferrer" className="k8s-link">
                  {k8s.cluster.name}
                </a>
              </div>
              <div className="k8s-field">
                <span className="k8s-field-label">Namespace</span>
                <a href={k8s.namespace.url} target="_blank" rel="noreferrer" className="k8s-link">
                  {k8s.namespace.name}
                </a>
              </div>
              <div className="k8s-field k8s-field-wide">
                <span className="k8s-field-label">Deployment</span>
                <div className="k8s-chips">
                  {k8s.deployments.map((d) => (
                    <a key={d.name} href={d.url} target="_blank" rel="noreferrer" className="k8s-chip">
                      {d.name}
                    </a>
                  ))}
                  {!k8s.deployments.length ? <span className="muted">—</span> : null}
                </div>
              </div>
              <div className="k8s-field k8s-field-wide">
                <span className="k8s-field-label">Node</span>
                <div className="k8s-chips">
                  {k8s.nodes.map((n) => (
                    <a key={n.name} href={n.url} target="_blank" rel="noreferrer" className="k8s-chip">
                      {n.name}
                    </a>
                  ))}
                  {!k8s.nodes.length ? <span className="muted">—</span> : null}
                </div>
              </div>
              <div className="k8s-field k8s-field-full">
                <span className="k8s-field-label">Pod</span>
                <div className="k8s-pod-list">
                  {k8s.pods.map((p) => (
                    <div key={p.name} className="k8s-pod-row">
                      <a href={p.url} target="_blank" rel="noreferrer" className="k8s-link">
                        {p.name}
                      </a>
                      <span className="muted">
                        {p.deployment}
                        {p.node ? ` · ${p.node}` : ""}
                      </span>
                    </div>
                  ))}
                  {!k8s.pods.length ? (
                    <span className="muted">No matching pods in astronomy-demo</span>
                  ) : null}
                </div>
              </div>
            </div>

            {k8s.usage ? (
              <div className="k8s-metrics">
                <div className="k8s-metric">
                  <span className="k8s-field-label">CPU</span>
                  <strong className="k8s-metric-value">{k8s.usage.cpu}</strong>
                </div>
                <div className="k8s-metric">
                  <span className="k8s-field-label">CPU request</span>
                  <strong className="k8s-metric-value">{k8s.usage.cpuRequest}</strong>
                </div>
                <div className="k8s-metric">
                  <span className="k8s-field-label">Memory</span>
                  <strong className="k8s-metric-value">{k8s.usage.memory}</strong>
                </div>
                <div className="k8s-metric">
                  <span className="k8s-field-label">Memory request</span>
                  <strong className="k8s-metric-value">{k8s.usage.memoryRequest}</strong>
                </div>
                <div className="k8s-metric k8s-metric-trend">
                  <span className="k8s-field-label">Memory trend</span>
                  <div className="k8s-trend-row">
                    <MemorySparkline points={k8s.usage.memoryTrend.points} />
                    <span
                      className={
                        (k8s.usage.memoryTrend.changePct ?? 0) > 2
                          ? "k8s-trend-up"
                          : (k8s.usage.memoryTrend.changePct ?? 0) < -2
                            ? "k8s-trend-down"
                            : "muted"
                      }
                    >
                      {k8s.usage.memoryTrend.label}
                    </span>
                  </div>
                </div>
                <div className="k8s-metric k8s-metric-containers">
                  <span className="k8s-field-label">
                    Containers
                    {k8s.usage.containerCount
                      ? ` · ${k8s.usage.containerCount}`
                      : ""}
                  </span>
                  <div className="k8s-chips">
                    {k8s.usage.containers.map((c) => (
                      <span
                        key={c.name}
                        className={`k8s-chip k8s-chip-static ${c.ready ? "k8s-chip-ready" : "k8s-chip-not-ready"}`}
                        title={
                          c.restarts != null
                            ? `${c.name} · ready=${c.ready} · restarts=${c.restarts}`
                            : `${c.name} · ready=${c.ready}`
                        }
                      >
                        <span
                          className="k8s-container-dot"
                          style={{ background: c.ready ? "#3FA266" : "#CF2D56" }}
                        />
                        {c.name}
                        {c.restarts != null && c.restarts > 0
                          ? ` · ${c.restarts}↻`
                          : ""}
                      </span>
                    ))}
                    {!k8s.usage.containers.length ? (
                      <span className="muted">—</span>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            </>
          ) : null}
          <p className="muted k8s-hint">
            Links open Coralogix Infrastructure Explorer. Click a Pathpoint box to refine Cluster →
            Node → Pod → Namespace → Deployment.
          </p>
        </div>
      </section>

      <section className="olly-section" ref={ollySectionRef}>
        <div className="section-label">
          OLLY · CORALOGIX AI
          {ollyChatId ? ` · chat ${ollyChatId.slice(0, 8)}…` : ""}
          {ollyHistory.length ? ` · ${ollyHistory.length} saved` : ""}
          {ollyLoading ? " (thinking…)" : ""}
        </div>
        <div className="panel olly-panel">
          <div className="olly-toolbar">
            <select
              className="olly-model olly-history"
              value={ollyMessages.length === 0 && !ollyHistory.some((c) => c.id === ollyLocalId) ? "__new__" : ollyLocalId}
              onChange={(e) => openOllyChat(e.target.value)}
              aria-label="Previous Olly chats"
              title="Previous chats saved in this browser"
            >
              <option value="__new__">New chat</option>
              {ollyHistory.map((c) => (
                <option key={c.id} value={c.id}>
                  {formatOllyWhen(c.updatedAt)} · {c.title}
                </option>
              ))}
            </select>
            <select
              className="olly-model"
              value={ollyModel}
              onChange={(e) => setOllyModel(e.target.value)}
              aria-label="Olly model"
            >
              <option value="claude-haiku-4-5">claude-haiku-4-5</option>
              <option value="claude-sonnet-4-5">claude-sonnet-4-5</option>
              <option value="gpt-5.2">gpt-5.2</option>
              <option value="gpt-5.4">gpt-5.4</option>
            </select>
            <button type="button" className="btn" onClick={startNewOllyChat} disabled={ollyLoading}>
              New chat
            </button>
            {ollyHistory.some((c) => c.id === ollyLocalId) ? (
              <button
                type="button"
                className="btn"
                disabled={ollyLoading}
                onClick={() => deleteOllyChat(ollyLocalId)}
                title="Delete this chat from browser history"
              >
                Delete
              </button>
            ) : null}
          </div>
          <div className="olly-thread">
            {ollyMessages.length === 0 ? (
              <p className="muted pad">
                Right-click any box to ask Olly, or pick a stage below and hit{" "}
                <strong>Investigate</strong>. Previous chats stay in this browser — use the
                history dropdown above to reopen them.
              </p>
            ) : null}
            {ollyMessages.map((m, i) => (
              <div key={`${m.role}-${i}`} className={`olly-msg olly-msg-${m.role}`}>
                <span className="olly-role">{m.role === "user" ? "You" : "Olly"}</span>
                <pre>{m.text}</pre>
              </div>
            ))}
          </div>
          <form
            className="olly-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void askOlly();
            }}
          >
            <input
              type="text"
              value={ollyInput}
              onChange={(e) => setOllyInput(e.target.value)}
              placeholder="Ask Olly about astronomy-demo checkout, payment, Redis…"
              disabled={ollyLoading}
            />
            <button type="submit" className="btn primary" disabled={ollyLoading || !ollyInput.trim()}>
              {ollyLoading ? "…" : "Ask"}
            </button>
          </form>
          <div className="olly-stage-bar">
            <label htmlFor="olly-stage">Investigate stage</label>
            <select
              id="olly-stage"
              className="olly-model"
              value={ollyStage}
              onChange={(e) => setOllyStage(e.target.value)}
              aria-label="Stage for Olly to investigate"
            >
              <option value="browse">BROWSE</option>
              <option value="cart">CART</option>
              <option value="checkout">CHECKOUT</option>
              <option value="payment">PAYMENT</option>
              <option value="fulfill">FULFILL</option>
              <option value="journey">Full journey</option>
            </select>
            <button
              type="button"
              className="btn primary"
              disabled={ollyLoading}
              onClick={() => void askOlly({ stage: ollyStage })}
            >
              {ollyLoading
                ? "Investigating…"
                : `Investigate ${STAGE_LABELS[ollyStage] || ollyStage}`}
            </button>
          </div>
        </div>
      </section>

      <section className="cursor-section">
        <div className="section-label">
          CURSOR · AGENT
          {cursorAgentId ? ` · ${cursorAgentId.slice(0, 10)}…` : ""}
          {cursorStatus
            ? ` · ${
                !cursorStatus.configured
                  ? "not configured"
                  : cursorStatus.enabled === false
                    ? "disabled"
                    : cursorStatus.runtime
              }`
            : ""}
          {cursorLoading ? " (working…)" : ""}
        </div>
        <div className="panel olly-panel">
          <div className="olly-toolbar">
            <span className="muted hint">
              {!cursorStatus?.configured
                ? "Set CURSOR_API_KEY on the server to enable Cursor agents from this panel."
                : cursorStatus.enabled === false
                  ? "Cursor agent is temporarily disabled. Set CURSOR_ENABLED=true on the server to re-enable."
                  : `SDK · ${cursorStatus.model}${
                      cursorStatus.runtime === "cloud" && cursorStatus.cloudRepo
                        ? ` · cloud ${cursorStatus.cloudRepo}`
                        : cursorStatus.cwd
                          ? ` · local ${cursorStatus.cwd}`
                          : ""
                    }`}
            </span>
            {cursorAgentId ? (
              <button
                type="button"
                className="btn"
                disabled={cursorLoading}
                onClick={() => {
                  setCursorAgentId(null);
                  setCursorMessages([]);
                }}
              >
                New session
              </button>
            ) : null}
          </div>
          <div className="olly-thread">
            {cursorMessages.length === 0 ? (
              <p className="muted pad">
                Ask Cursor to inspect the Pathpoint / Online Boutique code and environment.
                Follow-ups reuse the same agent session. This uses the Cursor SDK (not MCP into
                the IDE).
              </p>
            ) : null}
            {cursorMessages.map((m, i) => (
              <div
                key={`${m.role}-${i}`}
                className={`olly-msg ${m.role === "user" ? "olly-msg-user" : "olly-msg-olly"}`}
              >
                <span className="olly-role">{m.role === "user" ? "You" : "Cursor"}</span>
                <pre>{m.text}</pre>
              </div>
            ))}
          </div>
          <form
            className="olly-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void askCursor();
            }}
          >
            <input
              type="text"
              value={cursorInput}
              onChange={(e) => setCursorInput(e.target.value)}
              placeholder="e.g. Why are checkout 500s happening? Check the Pathpoint journey queries…"
              disabled={
                cursorLoading ||
                !cursorStatus?.configured ||
                cursorStatus.enabled === false
              }
            />
            <button
              type="submit"
              className="btn primary"
              disabled={
                cursorLoading ||
                !cursorInput.trim() ||
                !cursorStatus?.configured ||
                cursorStatus.enabled === false
              }
            >
              {cursorLoading ? "…" : "Ask Cursor"}
            </button>
          </form>
        </div>
      </section>

      <section className="slo-section">
        <div className="section-label">
          SLOs &amp; SLIs · SELECTED RANGE
          {slosLoading ? " (loading…)" : ""}
          {slos.length ? ` · ${slos.length} boutique SLOs` : ""}
        </div>
        {slosError ? <div className="error">{slosError}</div> : null}
        <div className="slo-toolbar">
          <button type="button" className="btn" onClick={() => void loadSlos()} disabled={slosLoading}>
            {slosLoading ? "Refreshing SLOs…" : "Refresh SLOs"}
          </button>
          <span className="muted">
            SLI PromQL windows rewritten to the time picker · evaluated at range end
          </span>
        </div>
        <div className="slo-grid">
          {slos.map((slo) => {
            const valueText =
              slo.currentValue == null
                ? "—"
                : slo.unit === "%"
                  ? `${Math.round(slo.currentValue * 10) / 10}%`
                  : slo.unit === "ms"
                    ? `${Math.round(slo.currentValue)} ms`
                    : slo.unit === "rpm"
                      ? `${Math.round(slo.currentValue * 10) / 10} rpm`
                      : String(Math.round(slo.currentValue * 100) / 100);
            const box = {
              kind: "touchpoint" as const,
              label: slo.name,
              metric: `${valueText} vs target ${slo.target}% · ${slo.statusLabel}`,
              light: slo.light,
              stageId: slo.stage === "other" ? undefined : slo.stage,
              extra: `sloId=${slo.id}; service=${slo.service}; sli=${slo.sliType}`,
              source: sourceForKey("panel:slos"),
            };
            return (
              <button
                key={slo.id}
                type="button"
                className="slo-card"
                style={{ borderColor: LIGHT[slo.light] }}
                onClick={() => window.open(slo.url, "_blank", "noopener,noreferrer")}
                onContextMenu={(e) => openContextMenu(e, box)}
                title="Open SLO in Coralogix · Right-click to ask Olly"
              >
                <div className="slo-card-top">
                  <StatusDot light={slo.light} size={9} />
                  <span className="slo-stage">{slo.stage.toUpperCase()}</span>
                  <span className="muted">{slo.service}</span>
                </div>
                <strong className="slo-name">{slo.name}</strong>
                <div className="slo-values">
                  <span style={{ color: LIGHT[slo.light] }}>{valueText}</span>
                  <span className="muted">target {slo.target}%</span>
                </div>
                <span className="muted hint">
                  {slo.sliLabel} · {slo.sliSummary || slo.timeFrame} · {slo.statusLabel}
                </span>
              </button>
            );
          })}
          {!slos.length && !slosLoading ? (
            <p className="muted">No boutique-related SLOs found for this tenant.</p>
          ) : null}
        </div>
      </section>

      {ctxMenu ? (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ctx-menu-label">{ctxMenu.box.label}</div>
          {ctxMenu.box.stageId || ctxMenu.box.kind === "stage" || ctxMenu.box.kind === "step" ? (
            <button
              type="button"
              className="ctx-menu-item ctx-menu-item-primary"
              role="menuitem"
              onClick={() => viewInfrastructure(ctxMenu.box)}
            >
              View Infrastructure
            </button>
          ) : null}
          {ctxMenu.box.source ? (
            <>
              <button
                type="button"
                className="ctx-menu-item"
                role="menuitem"
                onClick={() => {
                  const src = ctxMenu.box.source!;
                  setCtxMenu(null);
                  window.open(githubViewUrl(src), "_blank", "noopener,noreferrer");
                }}
              >
                View source on GitHub
              </button>
              <button
                type="button"
                className="ctx-menu-item"
                role="menuitem"
                onClick={() => {
                  const src = ctxMenu.box.source!;
                  setCtxMenu(null);
                  window.open(githubEditUrl(src), "_blank", "noopener,noreferrer");
                }}
              >
                Edit on GitHub
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => openAskDialog(ctxMenu.box)}
          >
            Ask Olly a question…
          </button>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() =>
              openAskDialog(
                ctxMenu.box,
                `What is going wrong with ${ctxMenu.box.label}, and what should I check next?`
              )
            }
          >
            What’s wrong with this?
          </button>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            disabled={ollyLoading}
            onClick={() => {
              const box = ctxMenu.box;
              setCtxMenu(null);
              void askOlly({
                message: `Explain the current status of ${box.label}${box.metric ? ` (metric: ${box.metric})` : ""}${box.light ? ` [light=${box.light}]` : ""}. Be concise.`,
                box,
                displayLabel: `Explain ${box.label}`,
              });
            }}
          >
            Explain this box
          </button>
        </div>
      ) : null}

      {askDialog ? (
        <div
          className="ask-backdrop"
          onClick={() => setAskDialog(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setAskDialog(null);
          }}
        >
          <div
            className="ask-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Ask Olly"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ask-dialog-head">
              <strong>Ask Olly</strong>
              <span className="muted">{askDialog.box.label}</span>
            </div>
            {askDialog.box.metric ? (
              <p className="ask-dialog-meta muted">
                {askDialog.box.light ? (
                  <>
                    <StatusDot light={askDialog.box.light} size={8} />{" "}
                  </>
                ) : null}
                {askDialog.box.metric}
              </p>
            ) : null}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitAskDialog();
              }}
            >
              <input
                ref={askInputRef}
                type="text"
                value={askDialog.draft}
                onChange={(e) =>
                  setAskDialog((prev) =>
                    prev ? { ...prev, draft: e.target.value } : prev
                  )
                }
                placeholder={`Question about ${askDialog.box.label}…`}
                disabled={ollyLoading}
              />
              <div className="ask-dialog-actions">
                <button type="button" className="btn" onClick={() => setAskDialog(null)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  disabled={ollyLoading || !askDialog.draft.trim()}
                >
                  {ollyLoading ? "Asking…" : "Ask Olly"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
