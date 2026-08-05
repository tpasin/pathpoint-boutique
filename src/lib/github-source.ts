/** Client-safe GitHub deep links for Pathpoint boxes. */

export type SourceRef = {
  /** Repo-relative path, e.g. src/lib/journey.ts */
  path: string;
  /**
   * Unique marker string that appears in the file (searchable / scroll target).
   * Prefer `@pathpoint-source …` comments next to the definition.
   */
  marker: string;
  /** Optional 1-based line (best-effort; drifts as the file changes). */
  line?: number;
};

export function githubRepoSlug(): string {
  return (
    process.env.NEXT_PUBLIC_GITHUB_REPO ||
    "tpasin/pathpoint-boutique"
  ).replace(/^\/|\/$/g, "");
}

export function githubBranch(): string {
  return process.env.NEXT_PUBLIC_GITHUB_BRANCH || "main";
}

export function githubConfigured(): boolean {
  return Boolean(githubRepoSlug());
}

/** View file on GitHub (blob). Uses line when known, else text-fragment on marker. */
export function githubViewUrl(ref: SourceRef): string {
  const base = `https://github.com/${githubRepoSlug()}/blob/${githubBranch()}/${ref.path}`;
  if (ref.line && ref.line > 0) return `${base}#L${ref.line}`;
  // Browser text fragment — scrolls to the @pathpoint-source marker when supported.
  return `${base}#:~:text=${encodeURIComponent(ref.marker)}`;
}

/** Open the GitHub web editor for this file (requires write access). */
export function githubEditUrl(ref: SourceRef): string {
  const base = `https://github.com/${githubRepoSlug()}/edit/${githubBranch()}/${ref.path}`;
  if (ref.line && ref.line > 0) return `${base}#L${ref.line}`;
  return base;
}

/** Fallback: GitHub code search for the marker inside the repo. */
export function githubSearchUrl(ref: SourceRef): string {
  const q = `repo:${githubRepoSlug()} ${ref.marker}`;
  return `https://github.com/search?q=${encodeURIComponent(q)}&type=code`;
}

/**
 * Stable source map for Pathpoint UI boxes.
 * Markers must exist as comments in the referenced files.
 */
export const PATHPOINT_SOURCES: Record<string, SourceRef> = {
  // Stages
  "stage:browse": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source stage:browse",
    line: 314,
  },
  "stage:cart": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source stage:cart",
    line: 369,
  },
  "stage:checkout": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source stage:checkout",
    line: 426,
  },
  "stage:payment": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source stage:payment",
    line: 481,
  },
  "stage:fulfill": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source stage:fulfill",
    line: 536,
  },

  // Steps
  "step:catalog": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:catalog",
    line: 328,
  },
  "step:product-page": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:product-page",
    line: 341,
  },
  "step:recs": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:recs",
    line: 354,
  },
  "step:add-item": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:add-item",
    line: 383,
  },
  "step:get-cart": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:get-cart",
    line: 396,
  },
  "step:redis": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:redis",
    line: 409,
  },
  "step:post-checkout": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:post-checkout",
    line: 440,
  },
  "step:place-order": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:place-order",
    line: 453,
  },
  "step:order-prep": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:order-prep",
    line: 466,
  },
  "step:charge": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:charge",
    line: 495,
  },
  "step:insert": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:insert",
    line: 508,
  },
  "step:postgres": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:postgres",
    line: 521,
  },
  "step:empty-cart": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:empty-cart",
    line: 550,
  },
  "step:shipping": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:shipping",
    line: 565,
  },
  "step:email": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source step:email",
    line: 578,
  },

  // Business KPIs
  "biz:cart-demand": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:cart-demand",
    line: 761,
  },
  "biz:checkout-success": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:checkout-success",
    line: 775,
  },
  "biz:checkout-conv": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:checkout-conv",
    line: 789,
  },
  "biz:pay-success": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:pay-success",
    line: 809,
  },
  "biz:catalog-health": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:catalog-health",
    line: 823,
  },
  "biz:browse-health": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:browse-health",
    line: 837,
  },
  "biz:cart-friction": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:cart-friction",
    line: 851,
  },
  "biz:units-to-checkout": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:units-to-checkout",
    line: 865,
  },
  "biz:rum-sessions": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:rum-sessions",
    line: 885,
  },
  "biz:unique-users": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:unique-users",
    line: 899,
  },
  "biz:recordings": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:recordings",
    line: 913,
  },
  "biz:fulfill-latency": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source biz:fulfill-latency",
    line: 927,
  },

  // Panels / APIs
  "panel:traces": {
    path: "src/app/api/traces/route.ts",
    marker: "@pathpoint-source panel:traces",
    line: 1,
  },
  "panel:products": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source panel:products",
    line: 301,
  },
  "panel:touchpoints": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source panel:touchpoints",
    line: 595,
  },
  "panel:top-users": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source panel:top-users",
    line: 737,
  },
  "panel:session-replay": {
    path: "src/lib/journey.ts",
    marker: "@pathpoint-source panel:session-replay",
    line: 692,
  },
  "panel:olly": {
    path: "src/app/api/olly/route.ts",
    marker: "@pathpoint-source panel:olly",
    line: 1,
  },
  "panel:cursor": {
    path: "src/lib/cursor-agent.ts",
    marker: "@pathpoint-source panel:cursor",
    line: 1,
  },
  "panel:slos": {
    path: "src/lib/slos.ts",
    marker: "@pathpoint-source panel:slos",
    line: 1,
  },
  "panel:dashboard": {
    path: "src/components/PathpointDashboard.tsx",
    marker: "@pathpoint-source panel:dashboard",
    line: 3,
  },
};

export function sourceForStage(stageId: string): SourceRef | undefined {
  return PATHPOINT_SOURCES[`stage:${stageId}`];
}

export function sourceForStep(stepId: string): SourceRef | undefined {
  return PATHPOINT_SOURCES[`step:${stepId}`];
}

export function sourceForBiz(metricId: string): SourceRef | undefined {
  return PATHPOINT_SOURCES[`biz:${metricId}`];
}

export function sourceForKey(key: string): SourceRef | undefined {
  return PATHPOINT_SOURCES[key];
}
