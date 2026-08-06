import {
  queryPromql,
  queryPromqlRange,
  queryPromqlSeries,
  runCxJson,
} from "./coralogix";
import { infraExplorerUrl } from "./coralogix-links";

export const K8S_CLUSTER =
  process.env["K8S_CLUSTER_NAME"] || process.env["NEXT_PUBLIC_K8S_CLUSTER"] || "onlineboutique";
export const K8S_NAMESPACE =
  process.env["K8S_NAMESPACE"] || process.env["NEXT_PUBLIC_K8S_NAMESPACE"] || "astronomy-demo";

/** Stage → Kubernetes deployments in the Online Boutique demo. */
export const STAGE_DEPLOYMENTS: Record<string, string[]> = {
  browse: ["frontend", "product-catalog", "recommendation"],
  cart: ["cart", "valkey-cart"],
  checkout: ["checkout", "frontend"],
  payment: ["payment"],
  fulfill: ["shipping", "email", "cart"],
};

/** Step → tighter deployment focus when a step box is clicked. */
export const STEP_DEPLOYMENTS: Record<string, string[]> = {
  catalog: ["product-catalog"],
  "product-page": ["frontend"],
  recs: ["recommendation"],
  "add-item": ["cart"],
  "get-cart": ["cart"],
  redis: ["valkey-cart", "cart"],
  "post-checkout": ["frontend", "checkout"],
  "place-order": ["checkout"],
  "order-prep": ["checkout", "cart", "product-catalog", "shipping"],
  charge: ["payment"],
  insert: ["payment"],
  postgres: ["payment"],
  "empty-cart": ["cart"],
  shipping: ["shipping"],
  email: ["email"],
};

/** Business KPI / touchpoint id → stage for K8s focus. */
export const BIZ_STAGE: Record<string, string> = {
  "checkout-errors": "checkout",
  "checkout-rate": "checkout",
  "payment-errors": "payment",
  "charge-fail": "payment",
  "cart-units": "cart",
  "cart-redis": "cart",
  "fulfill-latency": "fulfill",
  catalog: "browse",
  browse: "browse",
};

export type InfraLink = {
  name: string;
  url: string;
  resourceId?: string;
};

export type K8sPodLink = InfraLink & {
  deployment: string;
  node?: string;
};

export type K8sContainerInfo = {
  name: string;
  ready: boolean;
  restarts?: number;
};

export type K8sUsage = {
  /** Formatted CPU usage (cores / millicores). */
  cpu: string;
  cpuRaw: number | null;
  /** Formatted CPU request. */
  cpuRequest: string;
  cpuRequestRaw: number | null;
  /** Formatted memory working set. */
  memory: string;
  memoryRaw: number | null;
  /** Formatted memory request. */
  memoryRequest: string;
  memoryRequestRaw: number | null;
  /** 30m sparkline points (normalized 0–1) + change %. */
  memoryTrend: {
    points: number[];
    changePct: number | null;
    label: string;
  };
  containers: K8sContainerInfo[];
  containerCount: number;
};

export type K8sSnapshot = {
  cluster: InfraLink;
  namespace: InfraLink;
  deployments: InfraLink[];
  nodes: InfraLink[];
  pods: K8sPodLink[];
  usage: K8sUsage;
  selection: {
    stage?: string;
    step?: string;
    deployments: string[];
    label: string;
  };
};

type InfraResource = {
  resource_id?: string;
  name?: string;
  columns?: Record<string, unknown>;
};

function parseIdField(resourceId: string, key: string): string {
  const re = new RegExp(`(?:^|[|:])${key}=([^|]+)`);
  const m = resourceId.match(re);
  return m?.[1] || "";
}

function resourceName(r: InfraResource): string {
  if (typeof r.name === "string" && r.name) return r.name;
  const col = r.columns?.Name;
  if (typeof col === "string" && col) return col;
  const id = r.resource_id || "";
  const pod = parseIdField(id, "k8s_pod_name");
  if (pod) return pod;
  const dep = parseIdField(id, "k8s_deployment_name");
  if (dep) return dep;
  const node = parseIdField(id, "k8s_node_name");
  if (node) return node;
  const ns = parseIdField(id, "k8s_namespace_name");
  if (ns) return ns;
  const cluster = parseIdField(id, "k8s_cluster_name");
  return cluster || id;
}

function inBoutiqueCluster(resourceId: string): boolean {
  return (
    resourceId.includes(`k8s_cluster_name=${K8S_CLUSTER}`) &&
    (resourceId.includes(`k8s_namespace_name=${K8S_NAMESPACE}`) ||
      !resourceId.includes("k8s_namespace_name="))
  );
}

async function listInfra(
  type: string,
  nameFilter?: string
): Promise<InfraResource[]> {
  const args = ["infra", "resources", "list", "--category", "Kubernetes", "--type", type];
  if (nameFilter) args.push("--name-filter", nameFilter);
  const parsed = await runCxJson(args, { timeoutMs: 40_000, priority: true });
  if (!parsed || typeof parsed !== "object") return [];
  const resources = (parsed as { resources?: InfraResource[] }).resources;
  return Array.isArray(resources) ? resources : [];
}

type PodEnrichment = {
  node?: string;
  containers: K8sContainerInfo[];
};

async function enrichPod(resourceId: string): Promise<PodEnrichment> {
  const parsed = await runCxJson(["infra", "resources", "raw-data", resourceId], {
    timeoutMs: 25_000,
    priority: true,
  });
  if (!parsed || typeof parsed !== "object") return { containers: [] };
  const otel = (parsed as { OTEL?: Record<string, unknown> }).OTEL;
  if (!otel || typeof otel !== "object") return { containers: [] };
  const spec = otel.spec as Record<string, unknown> | undefined;
  const status = otel.status as Record<string, unknown> | undefined;
  const node = typeof spec?.nodeName === "string" ? spec.nodeName : undefined;

  const statuses = Array.isArray(status?.containerStatuses)
    ? (status!.containerStatuses as Record<string, unknown>[])
    : [];
  const containers: K8sContainerInfo[] = statuses.map((s) => {
    const name = typeof s.name === "string" ? s.name : "container";
    const ready = Boolean(s.ready);
    const restarts =
      typeof s.restartCount === "number"
        ? s.restartCount
        : typeof s.restartCount === "string"
          ? Number(s.restartCount)
          : undefined;
    return {
      name,
      ready,
      restarts: Number.isFinite(restarts) ? restarts : undefined,
    };
  });

  if (!containers.length && Array.isArray(spec?.containers)) {
    for (const c of spec!.containers as Record<string, unknown>[]) {
      if (typeof c.name === "string") {
        containers.push({ name: c.name, ready: true });
      }
    }
  }

  return { node, containers };
}

function deploymentsFor(stage?: string | null, step?: string | null): string[] {
  if (step && STEP_DEPLOYMENTS[step]) return [...STEP_DEPLOYMENTS[step]];
  if (stage && STAGE_DEPLOYMENTS[stage]) return [...STAGE_DEPLOYMENTS[stage]];
  return ["frontend", "checkout", "payment", "cart"];
}

function podMatchesDeployment(podName: string, deployment: string): boolean {
  return podName === deployment || podName.startsWith(`${deployment}-`);
}

function depSelector(deps: string[]): string {
  const escaped = deps.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 1) return `k8s_deployment_name="${escaped[0]}"`;
  return `k8s_deployment_name=~"${escaped.join("|")}"`;
}

function baseSelector(deps: string[]): string {
  return `k8s_cluster_name="${K8S_CLUSTER}",k8s_namespace_name="${K8S_NAMESPACE}",${depSelector(deps)}`;
}

export function formatCpuCores(cores: number | null | undefined): string {
  if (cores == null || !Number.isFinite(cores)) return "—";
  if (cores === 0) return "0";
  if (Math.abs(cores) < 1) return `${Math.round(cores * 1000)}m`;
  return `${cores.toFixed(cores >= 10 ? 1 : 2)}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${Math.round(bytes)} B`;
  if (abs < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (abs < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function normalizeSparkline(points: number[], maxPoints = 24): number[] {
  if (!points.length) return [];
  const step = Math.max(1, Math.floor(points.length / maxPoints));
  const sampled: number[] = [];
  for (let i = 0; i < points.length; i += step) sampled.push(points[i]);
  if (sampled[sampled.length - 1] !== points[points.length - 1]) {
    sampled.push(points[points.length - 1]);
  }
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  if (max <= min) return sampled.map(() => 0.5);
  return sampled.map((v) => (v - min) / (max - min));
}

async function fetchUsage(deps: string[]): Promise<K8sUsage> {
  const sel = baseSelector(deps);
  const empty: K8sUsage = {
    cpu: "—",
    cpuRaw: null,
    cpuRequest: "—",
    cpuRequestRaw: null,
    memory: "—",
    memoryRaw: null,
    memoryRequest: "—",
    memoryRequestRaw: null,
    memoryTrend: { points: [], changePct: null, label: "—" },
    containers: [],
    containerCount: 0,
  };

  try {
    const [
      cpu,
      cpuRequest,
      memory,
      memoryRequest,
      memoryPoints,
      containerSeries,
    ] = await Promise.all([
      queryPromql(`sum(k8s_pod_cpu_utilization_1{${sel}})`),
      queryPromql(`sum(k8s_container_cpu_request__cpu_{${sel}})`),
      queryPromql(`sum(k8s_pod_memory_working_set_By{${sel}})`),
      queryPromql(`sum(k8s_container_memory_request_By{${sel}})`),
      queryPromqlRange(`sum(k8s_pod_memory_working_set_By{${sel}})`, {
        start: "now-30m",
        end: "now",
        step: "1m",
      }),
      queryPromqlSeries(
        `max by (k8s_container_name) (k8s_container_ready{${sel}})`
      ),
    ]);

    let changePct: number | null = null;
    if (memoryPoints.length >= 2 && memoryPoints[0] > 0) {
      changePct =
        ((memoryPoints[memoryPoints.length - 1] - memoryPoints[0]) / memoryPoints[0]) * 100;
    }

    const trendLabel =
      changePct == null
        ? "—"
        : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}% · 30m`;

    const containers: K8sContainerInfo[] = containerSeries
      .map((s) => ({
        name: s.metric.k8s_container_name || "container",
        ready: s.value >= 1,
      }))
      .filter((c) => c.name && c.name !== "POD")
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      cpu: formatCpuCores(cpu),
      cpuRaw: cpu,
      cpuRequest: formatCpuCores(cpuRequest),
      cpuRequestRaw: cpuRequest,
      memory: formatBytes(memory),
      memoryRaw: memory,
      memoryRequest: formatBytes(memoryRequest),
      memoryRequestRaw: memoryRequest,
      memoryTrend: {
        points: normalizeSparkline(memoryPoints),
        changePct,
        label: trendLabel,
      },
      containers,
      containerCount: containers.length,
    };
  } catch {
    return empty;
  }
}

const cache = new Map<string, { at: number; snap: K8sSnapshot }>();
const CACHE_TTL_MS = Number(process.env["K8S_CACHE_TTL_MS"] || 90_000);

export async function buildK8sSnapshot(opts: {
  stage?: string | null;
  step?: string | null;
  label?: string | null;
}): Promise<K8sSnapshot> {
  const stage = opts.stage || undefined;
  const step = opts.step || undefined;
  const deps = deploymentsFor(stage, step);
  const cacheKey = `${stage || ""}|${step || ""}|${deps.join(",")}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.snap;

  const cluster: InfraLink = {
    name: K8S_CLUSTER,
    url: infraExplorerUrl({ menuItem: "Clusters", name: K8S_CLUSTER }),
    resourceId: `7001219:k8s_cluster_name=${K8S_CLUSTER}`,
  };
  const namespace: InfraLink = {
    name: K8S_NAMESPACE,
    url: infraExplorerUrl({ menuItem: "Namespaces", name: K8S_NAMESPACE }),
    resourceId: `7001219:k8s_cluster_name=${K8S_CLUSTER}|k8s_namespace_name=${K8S_NAMESPACE}`,
  };

  const [depLists, podLists, usage] = await Promise.all([
    Promise.all(deps.map((d) => listInfra("Deployments", d))),
    Promise.all(deps.map((d) => listInfra("Pods", d))),
    fetchUsage(deps),
  ]);
  const depRows = depLists.flat();

  const boutiqueDeps = depRows.filter((r) => {
    const id = r.resource_id || "";
    if (!inBoutiqueCluster(id)) return false;
    const name = resourceName(r);
    return deps.includes(name);
  });

  const uniqueDeps: InfraLink[] = deps.map((name) => {
    const match = boutiqueDeps.find((r) => resourceName(r) === name);
    return {
      name,
      url: infraExplorerUrl({ menuItem: "Deployments", name }),
      resourceId: match?.resource_id,
    };
  });

  const podRows = podLists.flat();
  const seenPodIds = new Set<string>();
  const matchingPods = podRows.filter((r) => {
    const id = r.resource_id || "";
    if (id && seenPodIds.has(id)) return false;
    if (id) seenPodIds.add(id);
    if (!inBoutiqueCluster(id)) return false;
    const name = resourceName(r);
    return deps.some((d) => podMatchesDeployment(name, d));
  });

  const podsToEnrich = matchingPods.slice(0, 6);
  const enrichByPod = new Map<string, PodEnrichment>();
  await Promise.all(
    podsToEnrich.map(async (r) => {
      const id = r.resource_id;
      if (!id) return;
      enrichByPod.set(id, await enrichPod(id));
    })
  );

  const pods: K8sPodLink[] = matchingPods.map((r) => {
    const name = resourceName(r);
    const id = r.resource_id || "";
    const deployment =
      deps.find((d) => podMatchesDeployment(name, d)) ||
      parseIdField(id, "k8s_deployment_name") ||
      name.split("-")[0] ||
      name;
    const enrich = id ? enrichByPod.get(id) : undefined;
    return {
      name,
      deployment,
      node: enrich?.node,
      url: infraExplorerUrl({ menuItem: "Pods", name }),
      resourceId: id || undefined,
    };
  });

  const nodeNames = [
    ...new Set(
      [...enrichByPod.values()]
        .map((e) => e.node)
        .filter((n): n is string => Boolean(n))
    ),
  ];

  let nodes: InfraLink[] = nodeNames.map((name) => ({
    name,
    url: infraExplorerUrl({ menuItem: "Nodes", name }),
  }));

  if (!nodes.length) {
    const nodeRows = await listInfra("Nodes");
    nodes = nodeRows
      .filter((r) => (r.resource_id || "").includes(`k8s_cluster_name=${K8S_CLUSTER}`))
      .slice(0, 8)
      .map((r) => {
        const name = resourceName(r);
        return {
          name,
          url: infraExplorerUrl({ menuItem: "Nodes", name }),
          resourceId: r.resource_id,
        };
      });
  }

  // Fallback containers from pod raw-data if metrics returned none
  let usageFinal = usage;
  if (!usage.containers.length) {
    const fromRaw = new Map<string, K8sContainerInfo>();
    for (const e of enrichByPod.values()) {
      for (const c of e.containers) {
        if (!fromRaw.has(c.name)) fromRaw.set(c.name, c);
      }
    }
    if (fromRaw.size) {
      const containers = [...fromRaw.values()].sort((a, b) => a.name.localeCompare(b.name));
      usageFinal = {
        ...usage,
        containers,
        containerCount: containers.length,
      };
    }
  }

  const label =
    opts.label ||
    (step ? step : undefined) ||
    (stage ? stage.toUpperCase() : "Kubernetes");

  const snap: K8sSnapshot = {
    cluster,
    namespace,
    deployments: uniqueDeps,
    nodes,
    pods,
    usage: usageFinal,
    selection: {
      stage,
      step,
      deployments: deps,
      label: String(label),
    },
  };
  cache.set(cacheKey, { at: Date.now(), snap });
  return snap;
}
