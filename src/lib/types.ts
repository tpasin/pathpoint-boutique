export type Light = "green" | "yellow" | "red" | "grey";

export type Step = {
  id: string;
  name: string;
  light: Light;
  metric: string;
  /** Hover explanation of how the step metric/status is gathered */
  howto?: string;
  explore?: { kind: "logs" | "tracing"; query: string };
};

export type Stage = {
  id: string;
  name: string;
  light: Light;
  metric: string;
  metricLabel: string;
  /** Hover explanation of how the stage metric/status is gathered */
  howto?: string;
  steps: Step[];
  explore?: { kind: "logs" | "tracing"; query: string };
};

export type Touchpoint = {
  name: string;
  light: Light;
  value: string;
  explore?: { kind: "logs" | "tracing"; query: string };
};

export type TraceHit = {
  traceId: string;
  service: string;
  operation: string;
  durationMs: number;
  status?: string;
  url: string;
};

export type ProductUnit = {
  id: string;
  name: string;
  units: number;
  /** Sum of qty × unit price (USD) from product enrichment */
  revenue: number;
  /** Unit price in USD when known */
  price?: number;
};

export type BusinessMetric = {
  id: string;
  label: string;
  value: string;
  /** Short line under the value */
  hint?: string;
  /** Hover explanation of how the metric is gathered / calculated */
  howto?: string;
  light: Light;
  explore?: { kind: "logs" | "tracing"; query: string };
};

export type TopUser = {
  userId: string;
  name: string;
  country: string;
  city: string;
  events: number;
  sessionId?: string;
  hasRecording?: boolean;
  replayUrl?: string;
  explore?: { kind: "logs" | "tracing"; query: string };
};

export type SessionReplayHit = {
  sessionId: string;
  userName: string;
  city: string;
  country: string;
  events: number;
  replayUrl: string;
  explore?: { kind: "logs" | "tracing"; query: string };
};

export type SloCard = {
  id: string;
  name: string;
  description: string;
  target: number;
  timeFrame: string;
  sliType: "request" | "window" | "unknown";
  sliLabel: string;
  service: string;
  stage: "browse" | "cart" | "checkout" | "payment" | "fulfill" | "other";
  sloType: string;
  currentValue: number | null;
  unit: "%" | "ms" | "rpm" | "";
  light: Light;
  statusLabel: string;
  sliSummary: string;
  url: string;
};

export type TimeRange = {
  start: string;
  end: string;
};

export type JourneySnapshot = {
  range: TimeRange;
  fetchedAt: string;
  /** `live` when Coralogix answered; `seed` only if every block fell back. */
  dataSource: "live" | "seed";
  stages: Stage[];
  touchpoints: Touchpoint[];
  products: ProductUnit[];
  business: BusinessMetric[];
  topUsers: TopUser[];
  sessionReplays: SessionReplayHit[];
  traces: TraceHit[];
  links: {
    checkoutErrors: string;
    paymentErrors: string;
    cartRedis: string;
    productCatalog: string;
    allTraces: string;
    rumSessions: string;
    sessionReplay: string;
  };
};
