import { exploreUrl, queryDataprime, type TimeRange } from "./coralogix";
import type {
  JourneySnapshot,
  Light,
  ProductUnit,
  Stage,
  Step,
  Touchpoint,
  TraceHit,
} from "./types";

export type { JourneySnapshot, Light, Stage, Step, Touchpoint, TraceHit, ProductUnit };

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

async function safeQuery(
  query: string,
  range: TimeRange,
  limit = 50
): Promise<Record<string, unknown>[]> {
  try {
    return await queryDataprime(query, range, limit);
  } catch {
    return [];
  }
}

export async function buildJourney(range: TimeRange): Promise<JourneySnapshot> {
  const [
    checkoutStatus,
    chargeStatus,
    emptyCart,
    catalogStatus,
    browseStatus,
    cartErrors,
    products,
    errorTraces,
  ] = await Promise.all([
    safeQuery(
      `source spans | filter $l.serviceName == 'frontend' && $l.operationName == 'POST /api/checkout' | create status from $d.tags['http.status_code']:string | groupby status aggregate count() as cnt`,
      range,
      20
    ),
    safeQuery(
      `source spans | filter $l.serviceName == 'checkout' && $l.operationName == 'oteldemo.PaymentService/Charge' | create code from $d.tags['rpc.grpc.status_code']:string | create errored from $d.tags['error']:string | groupby code, errored aggregate count() as cnt`,
      range,
      20
    ),
    safeQuery(
      `source spans | filter $l.serviceName == 'checkout' && $l.operationName == 'oteldemo.CartService/EmptyCart' | create code from $d.tags['rpc.grpc.status_code']:string | create errored from $d.tags['error']:string | groupby code, errored aggregate count() as cnt, avg($m.duration / 1000) as avg_ms, max($m.duration / 1000) as max_ms`,
      range,
      20
    ),
    safeQuery(
      `source spans | filter $l.serviceName == 'product-catalog' | create code from $d.tags['rpc.grpc.status_code']:string | create errored from $d.tags['error']:string | groupby code, errored aggregate count() as cnt`,
      range,
      20
    ),
    safeQuery(
      `source spans | filter $l.serviceName == 'frontend' && ($l.operationName ~ '/api/products' || $l.operationName ~ 'recommendations') | create status from $d.tags['http.status_code']:string | groupby status aggregate count() as cnt`,
      range,
      20
    ),
    safeQuery(
      `source logs | filter $l.applicationname == 'astronomy-demo' && $l.subsystemname == 'cart' && $m.severity == ERROR | create message from $d.message:string | groupby message aggregate count() as cnt | orderby cnt desc | limit 10`,
      range,
      20
    ),
    safeQuery(
      `source logs | filter $l.applicationname == 'astronomy-demo' && $l.subsystemname == 'cart' && $d.message ~ 'AddItemAsync' && $d.productId != null | create qty from $d.quantity:num | create pid from $d.productId:string | create pname from $d.productId_enriched.product_name:string | groupby pid, pname aggregate sum(qty) as units | orderby units desc | limit 10`,
      range,
      20
    ),
    safeQuery(
      `source spans | filter $l.serviceName == 'frontend' && $l.operationName == 'POST /api/checkout' | create status from $d.tags['http.status_code']:string | filter status == '500' | create duration_ms from $m.duration / 1000 | orderby $m.timestamp desc | choose $m.timestamp, duration_ms, $d.traceID, $l.operationName | limit 8`,
      range,
      10
    ),
  ]);

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
    {
      id: "browse",
      name: "BROWSE",
      light: worst(browseLight, catalogLight),
      metric: `${Math.round(browseFailRate * 100)}%`,
      metricLabel: "API 500s",
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.serviceName == 'frontend' && ($l.operationName ~ '/api/products' || $l.operationName ~ 'recommendations')`,
      },
      steps: [
        {
          id: "catalog",
          name: "Catalog",
          light: catalogLight,
          metric: `${catalogErr.toLocaleString()} × GetProduct 13 · ${Math.round(catalogFailRate * 1000) / 10}%`,
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'product-catalog'`,
          },
        },
        {
          id: "product-page",
          name: "Product page",
          light: browseLight,
          metric: `${browse500.toLocaleString()} × 500`,
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'frontend' && $l.operationName ~ '/api/products'`,
          },
        },
        {
          id: "recs",
          name: "Recommendations",
          light: browseLight,
          metric: "cascading product failures",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.operationName ~ 'recommendations'`,
          },
        },
      ],
    },
    {
      id: "cart",
      name: "CART",
      light: worst(cartAddLight, cartRedisLight),
      metric: productUnits > 1000 ? `${(productUnits / 1000).toFixed(1)}k` : String(productUnits),
      metricLabel: "units added",
      explore: {
        kind: "logs",
        query: `source logs | filter $l.applicationname == 'astronomy-demo' && $l.subsystemname == 'cart'`,
      },
      steps: [
        {
          id: "add-item",
          name: "Add item",
          light: cartAddLight,
          metric: productUnits ? "demand healthy" : "no adds in range",
          explore: {
            kind: "logs",
            query: `source logs | filter $l.subsystemname == 'cart' && $d.message ~ 'AddItemAsync'`,
          },
        },
        {
          id: "get-cart",
          name: "Get cart",
          light: "green",
          metric: "HGET path",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'cart' && $l.operationName ~ 'GetCart'`,
          },
        },
        {
          id: "redis",
          name: "Redis",
          light: cartRedisLight,
          metric: redisFails
            ? `${redisFails} connect fails · ${emptyLogFails} empty errors`
            : "no Redis errors",
          explore: {
            kind: "logs",
            query: `source logs | filter $l.subsystemname == 'cart' && $d.message ~ 'redis'`,
          },
        },
      ],
    },
    {
      id: "checkout",
      name: "CHECKOUT",
      light: checkoutLight,
      metric: `${Math.round(checkoutFailRate * 100)}%`,
      metricLabel: "checkout 500s",
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.serviceName == 'frontend' && $l.operationName == 'POST /api/checkout'`,
      },
      steps: [
        {
          id: "post-checkout",
          name: "POST /api/checkout",
          light: checkoutLight,
          metric: `${checkout500} × 500 · ${checkout200} × 200`,
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.operationName == 'POST /api/checkout'`,
          },
        },
        {
          id: "place-order",
          name: "PlaceOrder",
          light: checkoutLight,
          metric: "gRPC 13 when payment fails",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.operationName ~ 'PlaceOrder'`,
          },
        },
        {
          id: "order-prep",
          name: "Order prep",
          light: "green",
          metric: "cart · catalog · ship",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'checkout' && $l.operationName ~ 'prepare'`,
          },
        },
      ],
    },
    {
      id: "payment",
      name: "PAYMENT",
      light: paymentLight,
      metric: `${Math.round(chargeFailRate * 100)}%`,
      metricLabel: "Charge fails",
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.serviceName == 'payment' || $l.operationName ~ 'Charge'`,
      },
      steps: [
        {
          id: "charge",
          name: "Charge",
          light: paymentLight,
          metric: `${chargeErr} errors · ${chargeOk} OK`,
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.operationName ~ 'Charge'`,
          },
        },
        {
          id: "insert",
          name: "INSERT transactions",
          light: paymentLight,
          metric: 'amount_cents = "NaN"',
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'payment' && $l.operationName ~ 'INSERT'`,
          },
        },
        {
          id: "postgres",
          name: "Postgres",
          light: paymentLight,
          metric: "22P02 reject",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'payment' && $d.tags['db.system'] == 'postgresql'`,
          },
        },
      ],
    },
    {
      id: "fulfill",
      name: "FULFILL",
      light: fulfillLight,
      metric: emptyMax ? `${(emptyMax / 1000).toFixed(1)}s` : "—",
      metricLabel: "EmptyCart max",
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.operationName ~ 'EmptyCart'`,
      },
      steps: [
        {
          id: "empty-cart",
          name: "Empty cart",
          light: fulfillLight,
          metric: emptyErr
            ? `${emptyErr} × gRPC 9 · avg ${emptyAvg.toFixed(0)}ms`
            : "no EmptyCart errors",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.operationName ~ 'EmptyCart'`,
          },
        },
        {
          id: "shipping",
          name: "Shipping",
          light: checkout200 > 0 ? "yellow" : "grey",
          metric: "on paid orders only",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'shipping'`,
          },
        },
        {
          id: "email",
          name: "Email confirm",
          light: checkout200 > 0 ? "yellow" : "grey",
          metric: "on paid orders only",
          explore: {
            kind: "tracing",
            query: `source spans | filter $l.serviceName == 'email'`,
          },
        },
      ],
    },
  ];

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
      name: "Payment Charge failure rate",
      light: paymentLight,
      value: `${Math.round(chargeFailRate * 100)}%`,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.operationName ~ 'Charge'`,
      },
    },
    {
      name: "Cart Redis connect failures",
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
      name: "Product catalog GetProduct INTERNAL",
      light: catalogLight,
      value: `${Math.round(catalogFailRate * 1000) / 10}%`,
      explore: {
        kind: "tracing",
        query: `source spans | filter $l.serviceName == 'product-catalog'`,
      },
    },
    {
      name: "Browse / product API 500 rate",
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
      value: productUnits.toLocaleString(),
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
  }));

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
    stages,
    touchpoints,
    products: productList,
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
    },
  };
}
