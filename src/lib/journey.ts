import { exploreUrl, queryDataprime, sessionReplayUrl, type TimeRange } from "./coralogix";
import { sessionReplayHubUrl } from "./coralogix-links";
import { buildStagesFromSpanMetrics } from "./journey-stages";
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
import { checkoutHttpErrorExplore, paymentChargeErrorExplore, spanExplore } from "./span-metrics";

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
  // Span metrics drive stage/step lights (Pomelo pattern). RUM / products stay
  // as enrichment. Explore links open matching raw spans.
  const spanBundlePromise = buildStagesFromSpanMetrics(range);

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
    spanBundlePromise,
  ]);

  const [
    productsResult,
    errorTracesResult,
    topUsersResult,
    rumSessionCountResult,
    uniqueUserCountResult,
    spanBundle,
  ] = results;

  const products = productsResult.rows;
  const errorTraces = errorTracesResult.rows;
  const topUsersRows = topUsersResult.rows;
  const rumSessionCountRows = rumSessionCountResult.rows;
  const uniqueUserCountRows = uniqueUserCountResult.rows;
  const sessionReplayRows = sessionReplayResult.rows;
  const recordingCountRows = sessionReplayRows;

  const usedSeed =
    !spanBundle.live &&
    [productsResult, errorTracesResult, topUsersResult].every((r) => r.fromSeed);

  const checkoutFailRate = spanBundle.postCheckout.rate;
  const chargeFailRate = spanBundle.charge.rate;
  const emptyMax = spanBundle.emptyCart.latencyMs;
  const fulfillLight = spanBundle.fulfill.light;
  const checkoutLight = spanBundle.checkout.light;
  const paymentLight = spanBundle.payment.light;
  const cartAddLight = spanBundle.addItem.light;
  const productUnits = products.reduce((s, r) => s + num(r, "units"), 0);

  const stages: Stage[] = spanBundle.stages;
  const touchpoints: Touchpoint[] = spanBundle.touchpoints;

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
  const browseTotal = spanBundle.browse.total;
  const checkoutTotal = spanBundle.postCheckout.total;
  const chargeTotal = spanBundle.charge.total;
  const catalogTotal = spanBundle.catalog.total;
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
    ...spanBundle.spanBusiness,
    // @pathpoint-source biz:cart-demand
    {
      id: "cart-demand",
      label: "Add-to-cart demand",
      value: fmtCount(productUnits),
      hint: "units via AddItemAsync logs",
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
      hint: "1 − span metric error rate",
      howto: spanBundle.postCheckout.total
        ? `Span metrics · frontend checkout · ${spanBundle.window}`
        : "No checkout span-metric signal in this window.",
      light: checkoutLight,
      explore: checkoutHttpErrorExplore(),
    },
    // @pathpoint-source biz:checkout-conv
    {
      id: "checkout-conv",
      label: "Browse → checkout",
      value: browseTotal ? fmtPct(checkoutConversion) : "—",
      hint: "checkout ÷ browse span calls",
      howto:
        "How: (checkout span-metric calls) ÷ (browse stage calls) from calls_total.",
      light: browseTotal
        ? checkoutConversion >= 0.05
          ? "green"
          : checkoutConversion >= 0.02
            ? "yellow"
            : "red"
        : "grey",
      explore: spanExplore(["frontend"]),
    },
    // @pathpoint-source biz:pay-success
    {
      id: "pay-success",
      label: "Payment success",
      value: chargeTotal ? fmtPct(1 - chargeFailRate) : "—",
      hint: "1 − Charge STATUS_CODE_ERROR",
      howto: "Span metrics · payment Charge · calls_total status_code.",
      light: paymentLight,
      explore: paymentChargeErrorExplore(),
    },
    // @pathpoint-source biz:catalog-health
    {
      id: "catalog-health",
      label: "Catalog health",
      value: catalogTotal ? fmtPct(1 - spanBundle.catalog.rate) : "—",
      hint: "1 − product-catalog errors",
      howto: "Span metrics · product-catalog calls_total.",
      light: spanBundle.catalog.light,
      explore: spanExplore(["product-catalog"]),
    },
    // @pathpoint-source biz:browse-health
    {
      id: "browse-health",
      label: "Browse API health",
      value: browseTotal ? fmtPct(1 - spanBundle.browse.rate) : "—",
      hint: "1 − browse stage errors",
      howto: "Span metrics · frontend + product-catalog + recommendation.",
      light: spanBundle.browse.light,
      explore: spanExplore(["frontend", "product-catalog", "recommendation"]),
    },
    // @pathpoint-source biz:cart-friction
    {
      id: "cart-friction",
      label: "Cart Redis friction",
      value: spanBundle.redis.errors
        ? fmtCount(spanBundle.redis.errors)
        : fmtPct(spanBundle.redis.rate),
      hint: "span metrics · Redis ops",
      howto: "Span metrics · cart HGET/HMSET/EXPIRE error share.",
      light: spanBundle.redis.light,
      explore: spanExplore(["cart"], "HGET|HMSET|EXPIRE"),
    },
    // @pathpoint-source biz:units-to-checkout
    {
      id: "units-to-checkout",
      label: "Units → checkout",
      value: productUnits ? fmtPct(Math.min(1, cartToCheckout)) : "—",
      hint: "checkouts ÷ units added",
      howto:
        "How: checkout span-metric count ÷ sum(AddItemAsync quantity). Rough conversion from cart demand to checkout attempts.",
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
      label: "EmptyCart latency",
      value: emptyMax ? `${Math.round(emptyMax)}ms` : "—",
      hint: "span metrics · EmptyCart avg",
      howto: "Span metrics · EmptyCart duration_ms avg in the window.",
      light: fulfillLight,
      explore: spanExplore(["cart", "checkout"], ".*EmptyCart.*"),
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
        query: checkoutHttpErrorExplore().query,
        start: range.start,
        end: range.end,
        spansView: "spans",
      }),
      paymentErrors: exploreUrl({
        kind: "tracing",
        query: paymentChargeErrorExplore().query,
        start: range.start,
        end: range.end,
        spansView: "spans",
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
        spansView: "spans",
      }),
      allTraces: exploreUrl({
        kind: "tracing",
        query: `source spans | filter $l.applicationName == 'astronomy-demo'`,
        start: range.start,
        end: range.end,
        spansView: "spans",
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
