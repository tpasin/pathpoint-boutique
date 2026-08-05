import { exploreUrl, queryDataprime, sessionReplayUrl, type TimeRange } from "./coralogix";
import { sessionReplayHubUrl } from "./coralogix-links";
import { SEED, SEED_RANGE, type SeedKey } from "./seed-data";
import type {
  BusinessMetric,
  JourneySnapshot,
  Light,
  ProductUnit,
  SessionReplayHit,
  Stage,
  Step,
  TopUser,
  Touchpoint,
  TraceHit,
} from "./types";

export type {
  JourneySnapshot,
  Light,
  Stage,
  Step,
  Touchpoint,
  TraceHit,
  ProductUnit,
  BusinessMetric,
  TopUser,
  SessionReplayHit,
};

function num(row: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return 0;
}

function str(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}

function rateLight(errorRate: number): Light {
  if (errorRate >= 0.4) return "red";
  if (errorRate >= 0.05) return "yellow";
  return "green";
}

function worst(...lights: Light[]): Light {
  if (lights.includes("red")) return "red";
  if (lights.includes("yellow")) return "yellow";
  if (lights.includes("green")) return "green";
  return "grey";
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString("en");
}

function fmtPct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function rangeFactor(range: TimeRange): number {
  const seedMs = Date.parse(SEED_RANGE.end) - Date.parse(SEED_RANGE.start);
  const userMs = Date.parse(range.end) - Date.parse(range.start);
  if (!Number.isFinite(seedMs) || seedMs <= 0) return 1;
  if (!Number.isFinite(userMs) || userMs <= 0) return 1;
  return Math.max(0.02, Math.min(72, userMs / seedMs));
}

function scaleRows(
  rows: Record<string, unknown>[],
  factor: number
): Record<string, unknown>[] {
  return rows.map((r) => {
    const next = { ...r };
    for (const key of [
      "cnt",
      "units",
      "avg_ms",
      "max_ms",
      "duration_ms",
      "sessions",
      "users",
      "recordings",
      "shots",
      "revenue",
    ]) {
      if (typeof next[key] === "number") {
        next[key] = Math.max(0, Math.round((next[key] as number) * factor));
      }
    }
    return next;
  });
}

async function queryOrSeed(
  key: SeedKey,
  query: string,
  range: TimeRange,
  limit = 50,
  opts?: { tier?: string; priority?: boolean; noSeed?: boolean }
): Promise<{ rows: Record<string, unknown>[]; fromSeed: boolean }> {
  try {
    const live = await queryDataprime(query, range, limit, {
      tier: opts?.tier,
      priority: opts?.priority,
    });
    if (live.length > 0) return { rows: live, fromSeed: false };
  } catch {
    /* fall through */
  }
  // Never invent Session Replay rows — seed IDs are not playable in Coralogix.
  if (opts?.noSeed) return { rows: [], fromSeed: false };
  return { rows: scaleRows(SEED[key], rangeFactor(range)), fromSeed: true };
}

export async function buildJourney(range: TimeRange): Promise<JourneySnapshot> {
  // Fetch playable Session Replay sessions first, with an extra retry after
  // rate-limit cooldown — empty seed fallback is disabled for replays.
  const replayQuery = `source logs | filter $l.applicationname == 'coralogixRum' && $d.cx_rum.environment == 'oteldemo' && $d.cx_rum.session_context.hasRecording == true && $d.cx_rum.isSnapshotEvent == true | create sid from $d.cx_rum.session_context.session_id:string | create uname from $d.cx_rum.session_context.user_name:string | create city from $d.cx_rum.session_context.ip_geoip.city_name:string | create country from $d.cx_rum.session_context.ip_geoip.country_name:string | create created from $d.cx_rum.session_context.session_creation_date:number | filter sid != null | groupby sid aggregate count() as snaps, min(created) as created, any_value(uname) as uname, any_value(city) as city, any_value(country) as country | orderby snaps desc | limit 20`;

  let sessionReplayResult = await queryOrSeed(
    "sessionReplays",
    replayQuery,
    range,
    25,
    { tier: "frequent", priority: true, noSeed: true }
  );
  if (sessionReplayResult.rows.length === 0) {
    await new Promise((r) => setTimeout(r, 4_000));
    sessionReplayResult = await queryOrSeed(
      "sessionReplays",
      replayQuery,
      range,
      25,
      { tier: "frequent", priority: true, noSeed: true }
    );
  }

  const results = await Promise.all([
    queryOrSeed(
      "checkoutStatus",
      `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'frontend' && $l.operationName == 'POST /api/checkout' | create status from $d.tags['http.status_code']:string | groupby status aggregate count() as cnt`,
      range,
      20
    ),
    queryOrSeed(
      "chargeStatus",
      `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'checkout' && $l.operationName == 'oteldemo.PaymentService/Charge' | create code from $d.tags['rpc.grpc.status_code']:string | create errored from $d.tags['error']:string | groupby code, errored aggregate count() as cnt`,
      range,
      20
    ),
    queryOrSeed(
      "emptyCart",
      `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'checkout' && $l.operationName == 'oteldemo.CartService/EmptyCart' | create code from $d.tags['rpc.grpc.status_code']:string | create errored from $d.tags['error']:string | groupby code, errored aggregate count() as cnt, avg($m.duration / 1000) as avg_ms, max($m.duration / 1000) as max_ms`,
      range,
      20
    ),
    queryOrSeed(
      "catalogStatus",
      `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'product-catalog' | create code from $d.tags['rpc.grpc.status_code']:string | create errored from $d.tags['error']:string | groupby code, errored aggregate count() as cnt`,
      range,
      20
    ),
    queryOrSeed(
      "browseStatus",
      `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'frontend' && ($l.operationName ~ '/api/products' || $l.operationName ~ 'recommendations') | create status from $d.tags['http.status_code']:string | groupby status aggregate count() as cnt`,
      range,
      20
    ),
    queryOrSeed(
      "cartErrors",
      `source logs | filter $l.applicationname == 'astronomy-demo' && $l.subsystemname == 'cart' && $m.severity == ERROR | create message from $d.message:string | groupby message aggregate count() as cnt | orderby cnt desc | limit 10`,
      range,
      20
    ),
    queryOrSeed(
      "products",
      `source logs | filter $l.applicationname == 'astronomy-demo' && $l.subsystemname == 'cart' && $d.message ~ 'AddItemAsync' && $d.productId != null | create qty from $d.quantity:num | create price from $d.productId_enriched.price_in_currency:num | create pid from $d.productId:string | create pname from $d.productId_enriched.product_name:string | create line from qty * price | groupby pid, pname aggregate sum(qty) as units, sum(line) as revenue, max(price) as price | orderby revenue desc | limit 10`,
      range,
      20
    ),
    queryOrSeed(
      "errorTraces",
      `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'frontend' && $l.operationName == 'POST /api/checkout' | create status from $d.tags['http.status_code']:string | filter status == '500' | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $m.timestamp, duration_ms, $d.traceID, $l.operationName | limit 8`,
      range,
      10
    ),
    queryOrSeed(
      "topUsers",
      `source logs | filter $l.applicationname == 'coralogixRum' && $d.cx_rum.environment == 'oteldemo' | create uid from $d.cx_rum.session_context.user_id:string | create uname from $d.cx_rum.session_context.user_name:string | create country from $d.cx_rum.session_context.ip_geoip.country_name:string | create city from $d.cx_rum.session_context.ip_geoip.city_name:string | filter uid != null | groupby uid, uname, country, city aggregate count() as cnt | orderby cnt desc | limit 10`,
      range,
      15,
      { tier: "frequent", priority: true }
    ),
    queryOrSeed(
      "rumSessionCount",
      `source logs | filter $l.applicationname == 'coralogixRum' && $d.cx_rum.environment == 'oteldemo' | create sid from $d.cx_rum.session_context.session_id:string | filter sid != null | groupby sid aggregate count() as events | aggregate count() as sessions`,
      range,
      5,
      { tier: "frequent", priority: true }
    ),
    queryOrSeed(
      "uniqueUserCount",
      `source logs | filter $l.applicationname == 'coralogixRum' && $d.cx_rum.environment == 'oteldemo' | create uid from $d.cx_rum.session_context.user_id:string | filter uid != null | groupby uid aggregate count() as events | aggregate count() as users`,
      range,
      5,
      { tier: "frequent", priority: true }
    ),
  ]);

  // noSeed replays report fromSeed=false even when empty — don't let that
  // mark the whole snapshot as "live" when every other query fell back to seed.
  const usedSeed =
    results.every((r) => r.fromSeed) &&
    (sessionReplayResult.fromSeed || sessionReplayResult.rows.length === 0);
  const [
    checkoutStatus,
    chargeStatus,
    emptyCart,
    catalogStatus,
    browseStatus,
    cartErrors,
    products,
    errorTraces,
    topUsersRows,
    rumSessionCountRows,
    uniqueUserCountRows,
  ] = results.map((r) => r.rows);
  const sessionReplayRows = sessionReplayResult.rows;
  // Derive recording count from the playable replay query (avoids a 2nd heavy RUM hit).
  const recordingCountRows = sessionReplayRows;

  const checkout500 = checkoutStatus
    .filter((r) => str(r, "status") === "500")
    .reduce((s, r) => s + num(r, "cnt"), 0);
  const checkout200 = checkoutStatus
    .filter((r) => str(r, "status") === "200")
    .reduce((s, r) => s + num(r, "cnt"), 0);
  const checkoutTotal = checkout500 + checkout200;
  const checkoutFailRate = checkoutTotal ? checkout500 / checkoutTotal : 0;

  const chargeErr = chargeStatus
    .filter((r) => str(r, "errored") === "true" || str(r, "code") !== "0")
    .reduce((s, r) => s + num(r, "cnt"), 0);
  const chargeOk = chargeStatus
    .filter((r) => str(r, "code") === "0")
    .reduce((s, r) => s + num(r, "cnt"), 0);
  const chargeTotal = chargeErr + chargeOk;
  const chargeFailRate = chargeTotal ? chargeErr / chargeTotal : 0;

  const emptyErr = emptyCart.reduce((s, r) => s + num(r, "cnt"), 0);
  const emptyMax = emptyCart.reduce((m, r) => Math.max(m, num(r, "max_ms")), 0);
  const emptyAvg = emptyCart.length
    ? emptyCart.reduce((s, r) => s + num(r, "avg_ms"), 0) / emptyCart.length
    : 0;

  const catalogOk = catalogStatus
    .filter((r) => str(r, "code") === "0")
    .reduce((s, r) => s + num(r, "cnt"), 0);
  const catalogErr = catalogStatus
    .filter((r) => str(r, "code") === "13" || str(r, "errored") === "true")
    .reduce((s, r) => s + num(r, "cnt"), 0);
  const catalogTotal = catalogOk + catalogErr;
  const catalogFailRate = catalogTotal ? catalogErr / catalogTotal : 0;

  const browse500 = browseStatus
    .filter((r) => str(r, "status") === "500")
    .reduce((s, r) => s + num(r, "cnt"), 0);
  const browseOk = browseStatus
    .filter((r) => str(r, "status") === "200" || str(r, "status") === "304")
    .reduce((s, r) => s + num(r, "cnt"), 0);
  const browseTotal = browse500 + browseOk;
  const browseFailRate = browseTotal ? browse500 / browseTotal : 0;

  const redisFails = cartErrors
    .filter((r) => /redis/i.test(str(r, "message")))
    .reduce((s, r) => s + num(r, "cnt"), 0);
  const emptyLogFails = cartErrors
    .filter((r) => /emptying cart/i.test(str(r, "message")))
    .reduce((s, r) => s + num(r, "cnt"), 0);
  // @pathpoint-source panel:products
  const productUnits = products.reduce((s, r) => s + num(r, "units"), 0);

  const browseLight = rateLight(browseFailRate);
  const catalogLight = rateLight(catalogFailRate);
  const cartRedisLight: Light = redisFails > 0 ? "red" : "green";
  const cartAddLight: Light = productUnits > 0 ? "green" : "grey";
  const checkoutLight = rateLight(checkoutFailRate);
  const paymentLight = rateLight(chargeFailRate);
  const fulfillLight: Light =
    emptyErr > 0 || emptyMax > 2000 ? "red" : emptyAvg > 200 ? "yellow" : "green";

  const stages: Stage[] = [
    // @pathpoint-source stage:browse
    {
      id: "browse",
      name: "BROWSE",
      light: worst(browseLight, catalogLight),
      metric: `${Math.round(browseFailRate * 100)}%`,
      metricLabel: "API 500s",
      howto:
        "How: frontend spans for GET /api/products and recommendations. Metric = share of those calls with HTTP 500 in the selected window. Light also factors product-catalog gRPC errors.",
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.serviceName == 'frontend' && ($l.operationName ~ '/api/products' || $l.operationName ~ 'recommendations')`,
      },
      steps: [
        // @pathpoint-source step:catalog
        {
          id: "catalog",
          name: "Catalog",
          light: catalogLight,
          metric: `${catalogErr.toLocaleString("en")} × GetProduct 13 · ${Math.round(catalogFailRate * 1000) / 10}%`,
          howto:
            "How: product-catalog spans grouped by rpc.grpc.status_code / error. Counts GetProduct failures (often gRPC 13) and the fail rate across catalog calls.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'product-catalog'`,
          },
        },
        // @pathpoint-source step:product-page
        {
          id: "product-page",
          name: "Product page",
          light: browseLight,
          metric: `${browse500.toLocaleString("en")} × 500`,
          howto:
            "How: frontend spans matching /api/products. Counts HTTP 500 responses serving the product page API in this range.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'frontend' && $l.operationName ~ '/api/products'`,
          },
        },
        // @pathpoint-source step:recs
        {
          id: "recs",
          name: "Recommendations",
          light: browseLight,
          metric: "cascading catalog failures",
          howto:
            "How: spans whose operation matches recommendations. Status follows browse API health — catalog faults often cascade into empty or failing recs.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.operationName ~ 'recommendations'`,
          },
        },
      ],
    },
    // @pathpoint-source stage:cart
    {
      id: "cart",
      name: "CART",
      light: worst(cartAddLight, cartRedisLight),
      metric: productUnits > 1000 ? `${(productUnits / 1000).toFixed(1)}k` : String(productUnits),
      metricLabel: "units added",
      howto:
        "How: cart AddItemAsync logs with product enrichment. Metric = sum of quantities added in the window. Light worsens when Redis connection / empty-cart error logs appear.",
      explore: {
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'astronomy-demo' && $l.subsystemname == 'cart'`,
      },
      steps: [
        // @pathpoint-source step:add-item
        {
          id: "add-item",
          name: "Add item",
          light: cartAddLight,
          metric: productUnits ? "healthy demand" : "no adds in range",
          howto:
            "How: cart logs matching AddItemAsync. Healthy when units are flowing; grey/yellow when few or no adds appear in the selected range.",
          explore: {
            kind: "logs",
            query: `source logs | filter $l.subsystemname == 'cart' && $d.message ~ 'AddItemAsync'`,
          },
        },
        // @pathpoint-source step:get-cart
        {
          id: "get-cart",
          name: "Get cart",
          light: "green",
          metric: "HGET path",
          howto:
            "How: cart service spans for GetCart (Redis HGET path). Defaults green unless you open traces and see elevated latency or errors.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'cart' && $l.operationName ~ 'GetCart'`,
          },
        },
        // @pathpoint-source step:redis
        {
          id: "redis",
          name: "Redis",
          light: cartRedisLight,
          metric: redisFails
            ? `${redisFails} connection fails · ${emptyLogFails} empty errors`
            : "no Redis errors",
          howto:
            "How: cart ERROR logs mentioning redis / empty-cart failures. Counts connection failures and empty-cart error lines in this window.",
          explore: {
            kind: "logs",
            query: `source logs | filter $l.subsystemname == 'cart' && $d.message ~ 'redis'`,
          },
        },
      ],
    },
    // @pathpoint-source stage:checkout
    {
      id: "checkout",
      name: "CHECKOUT",
      light: checkoutLight,
      metric: `${Math.round(checkoutFailRate * 100)}%`,
      metricLabel: "checkout 500s",
      howto:
        "How: frontend POST /api/checkout spans grouped by http.status_code. Metric = 500s ÷ all checkout posts in the selected window.",
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.serviceName == 'frontend' && $l.operationName == 'POST /api/checkout'`,
      },
      steps: [
        // @pathpoint-source step:post-checkout
        {
          id: "post-checkout",
          name: "POST /api/checkout",
          light: checkoutLight,
          metric: `${checkout500} × 500 · ${checkout200} × 200`,
          howto:
            "How: exact counts of HTTP 500 vs 200 on POST /api/checkout spans for this range.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.operationName == 'POST /api/checkout'`,
          },
        },
        // @pathpoint-source step:place-order
        {
          id: "place-order",
          name: "PlaceOrder",
          light: checkoutLight,
          metric: "gRPC 13 when payment fails",
          howto:
            "How: checkout PlaceOrder spans. Often surfaces gRPC 13 when payment Charge fails upstream — light tracks overall checkout health.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.operationName ~ 'PlaceOrder'`,
          },
        },
        // @pathpoint-source step:order-prep
        {
          id: "order-prep",
          name: "Prepare order",
          light: "green",
          metric: "cart · catalog · shipping",
          howto:
            "How: checkout prepareOrder spans calling cart, catalog, and shipping. Defaults green; open traces to inspect prep latency or dependency errors.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'checkout' && $l.operationName ~ 'prepare'`,
          },
        },
      ],
    },
    // @pathpoint-source stage:payment
    {
      id: "payment",
      name: "PAYMENT",
      light: paymentLight,
      metric: `${Math.round(chargeFailRate * 100)}%`,
      metricLabel: "Charge failures",
      howto:
        "How: checkout→payment Charge spans by rpc.grpc.status_code / error. Metric = errored charges ÷ all Charge calls in the window.",
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.serviceName == 'payment' || $l.operationName ~ 'Charge'`,
      },
      steps: [
        // @pathpoint-source step:charge
        {
          id: "charge",
          name: "Charge",
          light: paymentLight,
          metric: `${chargeErr} errors · ${chargeOk} OK`,
          howto:
            "How: Charge operation spans. Counts errored vs OK gRPC outcomes for PaymentService/Charge.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.operationName ~ 'Charge'`,
          },
        },
        // @pathpoint-source step:insert
        {
          id: "insert",
          name: "INSERT transactions",
          light: paymentLight,
          metric: 'amount_cents = "NaN"',
          howto:
            "How: payment DB INSERT spans. Known demo failure writes amount_cents as NaN, which Postgres rejects — light follows Charge error rate.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'payment' && $l.operationName ~ 'INSERT'`,
          },
        },
        // @pathpoint-source step:postgres
        {
          id: "postgres",
          name: "Postgres",
          light: paymentLight,
          metric: "22P02 rejection",
          howto:
            "How: payment spans with db.system=postgresql. SQLSTATE 22P02 (invalid_text_representation) appears when NaN amount_cents is inserted.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'payment' && $d.tags['db.system'] == 'postgresql'`,
          },
        },
      ],
    },
    // @pathpoint-source stage:fulfill
    {
      id: "fulfill",
      name: "FULFILL",
      light: fulfillLight,
      metric: emptyMax ? `${(emptyMax / 1000).toFixed(1)}s` : "—",
      metricLabel: "EmptyCart max",
      howto:
        "How: EmptyCart spans after checkout. Metric = max duration in this window; light turns when EmptyCart errors (often gRPC 9) or latency spikes.",
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.operationName ~ 'EmptyCart'`,
      },
      steps: [
        // @pathpoint-source step:empty-cart
        {
          id: "empty-cart",
          name: "Empty cart",
          light: fulfillLight,
          metric: emptyErr
            ? `${emptyErr} × gRPC 9 · avg ${emptyAvg.toFixed(0)}ms`
            : "no EmptyCart errors",
          howto:
            "How: EmptyCart spans aggregated for errors, avg, and max latency. gRPC 9 usually means the cart was already empty or Redis race after payment.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.operationName ~ 'EmptyCart'`,
          },
        },
        // @pathpoint-source step:shipping
        {
          id: "shipping",
          name: "Shipping",
          light: checkout200 > 0 ? "yellow" : "grey",
          metric: "paid orders only",
          howto:
            "How: shipping service spans. Yellow when successful checkouts exist (orders should ship); grey when no paid orders in range.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'shipping'`,
          },
        },
        // @pathpoint-source step:email
        {
          id: "email",
          name: "Confirmation email",
          light: checkout200 > 0 ? "yellow" : "grey",
          metric: "paid orders only",
          howto:
            "How: email service spans for order confirmation. Yellow when paid checkouts exist; grey when none succeeded in this window.",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'email'`,
          },
        },
      ],
    },
  ];

  // @pathpoint-source panel:touchpoints
  const touchpoints: Touchpoint[] = [
    {
      name: "Checkout error rate (POST /api/checkout)",
      light: checkoutLight,
      value: `${Math.round(checkoutFailRate * 100)}%`,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.operationName == 'POST /api/checkout'`,
      },
    },
    {
      name: "Charge failure rate (payment)",
      light: paymentLight,
      value: `${Math.round(chargeFailRate * 100)}%`,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.operationName ~ 'Charge'`,
      },
    },
    {
      name: "Cart Redis connection failures",
      light: cartRedisLight,
      value: String(redisFails),
      explore: {
        kind: "logs",
        query: `source logs | filter $l.subsystemname == 'cart' && $d.message ~ 'redis'`,
      },
    },
    {
      name: "EmptyCart FAILED_PRECONDITION",
      light: fulfillLight,
      value: emptyErr ? `${emptyErr} spans` : "0",
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.operationName ~ 'EmptyCart'`,
      },
    },
    {
      name: "Catalog GetProduct INTERNAL",
      light: catalogLight,
      value: `${Math.round(catalogFailRate * 1000) / 10}%`,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.serviceName == 'product-catalog'`,
      },
    },
    {
      name: "Product API 500 rate",
      light: browseLight,
      value: `${Math.round(browseFailRate * 100)}%`,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.serviceName == 'frontend' && $l.operationName ~ '/api/products'`,
      },
    },
    {
      name: "Checkout success rate",
      light: checkoutLight,
      value: `${Math.round((1 - checkoutFailRate) * 100)}%`,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.operationName == 'POST /api/checkout'`,
      },
    },
    {
      name: "Add-to-cart demand (units)",
      light: cartAddLight,
      value: productUnits.toLocaleString("en"),
      explore: {
        kind: "logs",
        query: `source logs | filter $l.subsystemname == 'cart' && $d.message ~ 'AddItemAsync'`,
      },
    },
  ];

  const productList: ProductUnit[] = products.map((r) => ({
    id: str(r, "pid"),
    name: str(r, "pname") || str(r, "pid") || "Unknown",
    units: num(r, "units"),
    revenue: num(r, "revenue"),
    price: num(r, "price") || undefined,
  }));

  const rumSessionCount = rumSessionCountRows.reduce(
    (s, r) => s + num(r, "sessions", "cnt"),
    0
  );
  const uniqueUsers = uniqueUserCountRows.reduce(
    (s, r) => s + num(r, "users", "cnt"),
    0
  );
  const checkoutConversion =
    browseTotal > 0 ? checkoutTotal / browseTotal : checkoutTotal > 0 ? 1 : 0;
  const cartToCheckout =
    productUnits > 0 ? checkoutTotal / Math.max(productUnits, 1) : 0;

  // @pathpoint-source panel:session-replay
  const sessionReplays: SessionReplayHit[] = [];
  for (const r of sessionReplayRows) {
    const sessionId = str(r, "sid");
    if (!sessionId) continue;
    const snaps = num(r, "snaps", "shots", "cnt");
    // Guard: thin captures are not playable replays.
    if (snaps > 0 && snaps < 5) continue;
    const created = num(r, "created");
    // Player needs session_creation_date as timestamp — skip rows without it.
    if (!(created > 0)) continue;
    const city = titleCase(str(r, "city") || "Unknown");
    const country = titleCase(str(r, "country") || "Unknown");
    const userName = titleCase(str(r, "uname") || "Anonymous");
    sessionReplays.push({
      sessionId,
      userName,
      city,
      country,
      events: snaps,
      replayUrl: sessionReplayUrl(sessionId, {
        userName,
        hasRecording: true,
        // Snapshot-based web recordings often have hasScreenshot=false; the player
        // needs has-recording + timestamp, not error-screenshot flags.
        hasScreenshot: false,
        isArchive: false,
        timestamp: created,
      }),
      explore: {
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'coralogixRum' && $d.cx_rum.environment == 'oteldemo' && $d.cx_rum.session_context.session_id == '${sessionId}' && $d.cx_rum.isSnapshotEvent == true`,
      },
    });
    if (sessionReplays.length >= 8) break;
  }

  const recordingCount =
    recordingCountRows.filter((r) => num(r, "snaps", "cnt", "recordings") >= 5)
      .length || sessionReplays.length;

  const replayByUser = new Map(
    sessionReplays.map((s) => [s.userName.toLowerCase(), s])
  );

  // @pathpoint-source panel:top-users
  const topUsers: TopUser[] = topUsersRows.map((r) => {
    const name = str(r, "uname") || "Anonymous";
    const city = str(r, "city") || "Unknown";
    const country = str(r, "country") || "Unknown";
    const userId = str(r, "uid");
    const matched = replayByUser.get(name.toLowerCase());
    return {
      userId,
      name,
      country,
      city,
      events: num(r, "cnt"),
      sessionId: matched?.sessionId,
      hasRecording: Boolean(matched),
      replayUrl: matched?.replayUrl,
      explore: {
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'coralogixRum' && $d.cx_rum.session_context.user_id == '${userId}'`,
      },
    };
  });

  const business: BusinessMetric[] = [
    // @pathpoint-source biz:cart-demand
    {
      id: "cart-demand",
      label: "Add-to-cart demand",
      value: fmtCount(productUnits),
      hint: "units via AddItemAsync",
      howto:
        "How: cart logs (astronomy-demo / cart) matching AddItemAsync, summed quantity by product in the selected window.",
      light: cartAddLight,
      explore: {
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'astronomy-demo' && $l.subsystemname == 'cart' && $d.message ~ 'AddItemAsync'`,
      },
    },
    // @pathpoint-source biz:checkout-success
    {
      id: "checkout-success",
      label: "Checkout success",
      value: checkoutTotal ? fmtPct(1 - checkoutFailRate) : "—",
      hint: "1 − POST /api/checkout 500s",
      howto:
        "How: frontend spans POST /api/checkout grouped by http.status_code. Success = 200 ÷ (200+500).",
      light: checkoutLight,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.applicationName == 'astronomy-demo' && $l.operationName == 'POST /api/checkout'`,
      },
    },
    // @pathpoint-source biz:checkout-conv
    {
      id: "checkout-conv",
      label: "Browse → checkout",
      value: browseTotal ? fmtPct(checkoutConversion) : "—",
      hint: "checkout ÷ product API calls",
      howto:
        "How: (# POST /api/checkout spans) ÷ (# frontend /api/products|recommendations spans) in the window.",
      light: browseTotal
        ? checkoutConversion >= 0.05
          ? "green"
          : checkoutConversion >= 0.02
            ? "yellow"
            : "red"
        : "grey",
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'frontend'`,
      },
    },
    // @pathpoint-source biz:pay-success
    {
      id: "pay-success",
      label: "Payment success",
      value: chargeTotal ? fmtPct(1 - chargeFailRate) : "—",
      hint: "1 − Charge errors",
      howto:
        "How: checkout Charge spans grouped by rpc.grpc.status_code / error tag. Success = code 0 ÷ total.",
      light: paymentLight,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.applicationName == 'astronomy-demo' && $l.operationName ~ 'Charge'`,
      },
    },
    // @pathpoint-source biz:catalog-health
    {
      id: "catalog-health",
      label: "Catalog health",
      value: catalogTotal ? fmtPct(1 - catalogFailRate) : "—",
      hint: "OK ÷ product-catalog",
      howto:
        "How: product-catalog spans by grpc status. Health = OK (code 0) ÷ (OK + INTERNAL/errors).",
      light: catalogLight,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'product-catalog'`,
      },
    },
    // @pathpoint-source biz:browse-health
    {
      id: "browse-health",
      label: "Browse API health",
      value: browseTotal ? fmtPct(1 - browseFailRate) : "—",
      hint: "1 − product API 500s",
      howto:
        "How: frontend spans for /api/products and recommendations by http.status_code.",
      light: browseLight,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.applicationName == 'astronomy-demo' && $l.serviceName == 'frontend' && ($l.operationName ~ '/api/products' || $l.operationName ~ 'recommendations')`,
      },
    },
    // @pathpoint-source biz:cart-friction
    {
      id: "cart-friction",
      label: "Cart Redis friction",
      value: redisFails ? fmtCount(redisFails) : "0",
      hint: "connection failure logs",
      howto:
        "How: ERROR logs on cart subsystem whose message matches redis / emptying cart.",
      light: cartRedisLight,
      explore: {
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'astronomy-demo' && $l.subsystemname == 'cart' && $m.severity == ERROR`,
      },
    },
    // @pathpoint-source biz:units-to-checkout
    {
      id: "units-to-checkout",
      label: "Units → checkout",
      value: productUnits ? fmtPct(Math.min(1, cartToCheckout)) : "—",
      hint: "checkouts ÷ units added",
      howto:
        "How: checkout span count ÷ sum(AddItemAsync quantity). Rough conversion from cart demand to checkout attempts.",
      light: productUnits
        ? cartToCheckout >= 0.05
          ? "green"
          : cartToCheckout >= 0.02
            ? "yellow"
            : "red"
        : "grey",
      explore: {
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'astronomy-demo' && $l.subsystemname == 'cart' && $d.message ~ 'AddItemAsync'`,
      },
    },
    // @pathpoint-source biz:rum-sessions
    {
      id: "rum-sessions",
      label: "RUM sessions",
      value: rumSessionCount ? fmtCount(rumSessionCount) : "—",
      hint: "unique oteldemo sessions",
      howto:
        "How: distinct cx_rum.session_context.session_id for coralogixRum / oteldemo in the window.",
      light: rumSessionCount > 0 ? "green" : "grey",
      explore: {
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'coralogixRum' && $d.cx_rum.environment == 'oteldemo'`,
      },
    },
    // @pathpoint-source biz:unique-users
    {
      id: "unique-users",
      label: "Active shoppers",
      value: uniqueUsers ? fmtCount(uniqueUsers) : "—",
      hint: "distinct RUM user_id",
      howto:
        "How: distinct cx_rum.session_context.user_id for coralogixRum / oteldemo in the selected window.",
      light: uniqueUsers > 0 ? "green" : "grey",
      explore: {
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'coralogixRum' && $d.cx_rum.environment == 'oteldemo' && $d.cx_rum.session_context.user_id != null`,
      },
    },
    // @pathpoint-source biz:recordings
    {
      id: "recordings",
      label: "Session recordings",
      value: recordingCount ? fmtCount(recordingCount) : "0",
      hint: "hasRecording + snapshot events",
      howto:
        "How: distinct RUM sessions with hasRecording and ≥5 isSnapshotEvent frames (real Session Replay), not error screenshots.",
      light: recordingCount > 0 ? "green" : "grey",
      explore: {
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'coralogixRum' && $d.cx_rum.environment == 'oteldemo' && $d.cx_rum.session_context.hasRecording == true && $d.cx_rum.isSnapshotEvent == true`,
      },
    },
    // @pathpoint-source biz:fulfill-latency
    {
      id: "fulfill-latency",
      label: "EmptyCart max",
      value: emptyMax ? `${(emptyMax / 1000).toFixed(1)}s` : "—",
      hint: "fulfillment latency",
      howto:
        "How: max duration of EmptyCart spans under checkout in the window.",
      light: fulfillLight,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.applicationName == 'astronomy-demo' && $l.operationName ~ 'EmptyCart'`,
      },
    },
  ];

  const traces: TraceHit[] = errorTraces
    .map((r) => {
      const traceId = str(r, "traceID", "tid");
      const durationMs = num(r, "duration_ms");
      return {
        traceId,
        service: "frontend",
        operation: str(r, "operationName") || "POST /api/checkout",
        durationMs,
        status: "500",
        url: exploreUrl({
          kind: "tracing",
          traceId,
          start: range.start,
          end: range.end,
        }),
      };
    })
    .filter((t) => t.traceId);

  return {
    range,
    fetchedAt: new Date().toISOString(),
    dataSource: usedSeed ? "seed" : "live",
    stages,
    touchpoints,
    products: productList,
    business,
    topUsers,
    sessionReplays,
    traces,
    links: {
      checkoutErrors: exploreUrl({
        kind: "tracing",
        query: `source spans | filter $l.operationName == 'POST /api/checkout'`,
        start: range.start,
        end: range.end,
      }),
      paymentErrors: exploreUrl({
        kind: "tracing",
        query: `source spans | filter $l.operationName ~ 'Charge'`,
        start: range.start,
        end: range.end,
      }),
      cartRedis: exploreUrl({
        kind: "logs",
        query: `source logs | filter $l.subsystemname == 'cart' && $d.message ~ 'redis'`,
        start: range.start,
        end: range.end,
      }),
      productCatalog: exploreUrl({
        kind: "tracing",
        query: `source spans | filter $l.serviceName == 'product-catalog'`,
        start: range.start,
        end: range.end,
      }),
      allTraces: exploreUrl({
        kind: "tracing",
        query: `source spans | filter $l.applicationName == 'astronomy-demo'`,
        start: range.start,
        end: range.end,
      }),
      rumSessions: exploreUrl({
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'coralogixRum' && $d.cx_rum.environment == 'oteldemo'`,
        start: range.start,
        end: range.end,
      }),
      sessionReplay: sessionReplayHubUrl({
        start: range.start,
        end: range.end,
      }),
    },
  };
}
