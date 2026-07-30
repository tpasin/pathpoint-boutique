export type Light = "green" | "yellow" | "red" | "grey";

export type Step = {
  id: string;
  name: string;
  light: Light;
  metric: string;
  explore?: { kind: "logs" | "tracing"; query: string };
};

export type Stage = {
  id: string;
  name: string;
  light: Light;
  metric: string;
  metricLabel: string;
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
};

export type TimeRange = {
  start: string;
  end: string;
};

export type JourneySnapshot = {
  range: TimeRange;
  fetchedAt: string;
  stages: Stage[];
  touchpoints: Touchpoint[];
  products: ProductUnit[];
  traces: TraceHit[];
  links: {
    checkoutErrors: string;
    paymentErrors: string;
    cartRedis: string;
    productCatalog: string;
    allTraces: string;
  };
};
