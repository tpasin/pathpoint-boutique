/**
 * Assemble Online Boutique stages/steps from span metrics (Pomelo pattern).
 * Explore links always open matching raw spans.
 */
import type { BusinessMetric, Light, Stage, Touchpoint } from "./types";
import {
  BROWSE_SVCS,
  CART_SVCS,
  FULFILL_SVCS,
  PAYMENT_SVCS,
  fmtCount,
  fmtMs,
  fmtPct,
  promWindow,
  promqlHowto,
  serviceStats,
  spanExplore,
  checkoutHttpErrorExplore,
  paymentChargeErrorExplore,
  worstLight,
  type SvcStats,
} from "./span-metrics";
import type { TimeRange } from "./coralogix";

export type StageBundle = {
  window: string;
  browse: SvcStats;
  cart: SvcStats;
  checkout: SvcStats;
  payment: SvcStats;
  fulfill: SvcStats;
  catalog: SvcStats;
  productPage: SvcStats;
  recs: SvcStats;
  addItem: SvcStats;
  getCart: SvcStats;
  redis: SvcStats;
  postCheckout: SvcStats;
  placeOrder: SvcStats;
  orderPrep: SvcStats;
  charge: SvcStats;
  insert: SvcStats;
  postgres: SvcStats;
  emptyCart: SvcStats;
  shipping: SvcStats;
  email: SvcStats;
  stages: Stage[];
  touchpoints: Touchpoint[];
  spanBusiness: BusinessMetric[];
  live: boolean;
};

export async function buildStagesFromSpanMetrics(
  range: TimeRange
): Promise<StageBundle> {
  const window = promWindow(range);
  const time = range.end;

  const [
    browse,
    cart,
    payment,
    fulfill,
    catalog,
    productPage,
    recs,
    addItem,
    getCart,
    redis,
    postCheckout,
    placeOrder,
    orderPrep,
    charge,
    insert,
    postgres,
    emptyCart,
    shipping,
    email,
  ] = await Promise.all([
    serviceStats(BROWSE_SVCS, window, time),
    serviceStats(CART_SVCS, window, time),
    serviceStats(PAYMENT_SVCS, window, time),
    serviceStats(FULFILL_SVCS, window, time),
    serviceStats(["product-catalog"], window, time),
    // HTTP 500s stay STATUS_CODE_UNSET in calls_total — count http.status_code.
    serviceStats(["frontend"], window, time, {
      spanNameRe: ".*products.*",
      httpOperation: "~ 'GET /api/products'",
      errorMode: "http",
      range,
    }),
    serviceStats(["recommendation", "frontend"], window, time, ".*recommend.*"),
    serviceStats(["cart"], window, time, ".*AddItem.*"),
    serviceStats(["cart"], window, time, ".*GetCart.*"),
    serviceStats(["cart"], window, time, "HGET|HMSET|EXPIRE|redis"),
    serviceStats(["frontend"], window, time, {
      spanNameRe: "POST /api/checkout",
      httpOperation: "POST /api/checkout",
      errorMode: "http",
      range,
    }),
    serviceStats(["checkout"], window, time, ".*PlaceOrder.*"),
    serviceStats(["checkout"], window, time, ".*prepare.*|GetCart|GetQuote|GetProduct|Convert"),
    serviceStats(["payment"], window, time, ".*Charge.*|charge"),
    serviceStats(["payment"], window, time, ".*INSERT.*|pg\\.query"),
    serviceStats(["payment"], window, time, "pg\\.|postgres|tcp\\.connect"),
    serviceStats(["cart", "checkout"], window, time, ".*EmptyCart.*"),
    serviceStats(["shipping"], window, time),
    serviceStats(["email"], window, time),
  ]);

  // Stage light = worst of its steps (don't dilute PlaceOrder/HTTP 500s with UNSET volume).
  const checkout: SvcStats = {
    total: postCheckout.total + placeOrder.total,
    errors: postCheckout.errors + placeOrder.errors,
    rate:
      postCheckout.total + placeOrder.total > 0
        ? (postCheckout.errors + placeOrder.errors) /
          (postCheckout.total + placeOrder.total)
        : 0,
    latencyMs: Math.max(postCheckout.latencyMs, placeOrder.latencyMs),
    light: worstLight(postCheckout.light, placeOrder.light, orderPrep.light),
  };

  const live =
    browse.total + cart.total + checkout.total + payment.total + fulfill.total > 0;

  const stages: Stage[] = [
    {
      id: "browse",
      name: "BROWSE",
      light: browse.light,
      metric: browse.total ? fmtPct(browse.rate) : "—",
      metricLabel: browse.total ? "error rate" : "no signal",
      howto: promqlHowto(BROWSE_SVCS, window),
      explore: spanExplore(BROWSE_SVCS),
      steps: [
        {
          id: "catalog",
          name: "Catalog",
          light: catalog.light,
          metric: `${fmtCount(catalog.total)} · ${fmtCount(catalog.errors)} err · ${fmtMs(catalog.latencyMs)}`,
          howto: promqlHowto(["product-catalog"], window),
          explore: spanExplore(["product-catalog"]),
        },
        {
          id: "product-page",
          name: "Product page",
          light: productPage.light,
          metric: `${fmtCount(productPage.total)} · ${fmtPct(productPage.rate)} err`,
          howto: promqlHowto(["frontend"], window, ".*products.*"),
          explore: spanExplore(["frontend"], ".*products.*"),
        },
        {
          id: "recs",
          name: "Recommendations",
          light: recs.light,
          metric: recs.total
            ? `${fmtCount(recs.total)} · ${fmtMs(recs.latencyMs)}`
            : "no traffic",
          howto: promqlHowto(["recommendation", "frontend"], window, ".*recommend.*"),
          explore: spanExplore(["recommendation", "frontend"], ".*recommend.*"),
        },
      ],
    },
    {
      id: "cart",
      name: "CART",
      light: cart.light,
      metric: cart.total ? fmtCount(cart.total) : "—",
      metricLabel: "calls",
      howto: promqlHowto(CART_SVCS, window),
      explore: spanExplore(CART_SVCS),
      steps: [
        {
          id: "add-item",
          name: "Add item",
          light: addItem.light,
          metric: `${fmtCount(addItem.total)} · ${fmtCount(addItem.errors)} err`,
          howto: promqlHowto(["cart"], window, ".*AddItem.*"),
          explore: spanExplore(["cart"], ".*AddItem.*"),
        },
        {
          id: "get-cart",
          name: "Get cart",
          light: getCart.light,
          metric: `${fmtCount(getCart.total)} · ${fmtMs(getCart.latencyMs)}`,
          howto: promqlHowto(["cart"], window, ".*GetCart.*"),
          explore: spanExplore(["cart"], ".*GetCart.*"),
        },
        {
          id: "redis",
          name: "Redis",
          light: redis.light,
          metric: redis.total
            ? `${fmtCount(redis.total)} · ${fmtPct(redis.rate)} err`
            : "no Redis spans",
          howto: promqlHowto(["cart"], window, "HGET|HMSET|EXPIRE|redis"),
          explore: spanExplore(["cart"], "HGET|HMSET|EXPIRE"),
        },
      ],
    },
    {
      id: "checkout",
      name: "CHECKOUT",
      light: checkout.light,
      metric: checkout.total ? fmtPct(checkout.rate) : "—",
      metricLabel: checkout.total ? "error rate" : "no signal",
      howto: [
        promqlHowto(["frontend"], window, "POST /api/checkout", "http"),
        "",
        promqlHowto(["checkout"], window, ".*PlaceOrder.*"),
      ].join("\n"),
      explore: checkoutHttpErrorExplore(),
      steps: [
        {
          id: "post-checkout",
          name: "POST /api/checkout",
          light: postCheckout.light,
          metric: `${fmtCount(postCheckout.total)} · ${fmtCount(postCheckout.errors)} × 500 · ${fmtPct(postCheckout.rate)}`,
          howto: promqlHowto(["frontend"], window, "POST /api/checkout", "http"),
          explore: checkoutHttpErrorExplore(),
        },
        {
          id: "place-order",
          name: "PlaceOrder",
          light: placeOrder.light,
          metric: `${fmtCount(placeOrder.total)} · ${fmtPct(placeOrder.rate)} err`,
          howto: promqlHowto(["checkout"], window, ".*PlaceOrder.*"),
          explore: spanExplore(["checkout"], ".*PlaceOrder.*"),
        },
        {
          id: "order-prep",
          name: "Prepare order",
          light: orderPrep.light,
          metric: `${fmtCount(orderPrep.total)} · ${fmtMs(orderPrep.latencyMs)}`,
          howto: promqlHowto(
            ["checkout"],
            window,
            ".*prepare.*|GetCart|GetQuote|GetProduct|Convert"
          ),
          explore: spanExplore(
            ["checkout"],
            ".*prepare.*|GetCart|GetQuote|GetProduct|Convert"
          ),
        },
      ],
    },
    {
      id: "payment",
      name: "PAYMENT",
      light: payment.light,
      metric: payment.total ? fmtPct(payment.rate) : "—",
      metricLabel: payment.total ? "Charge / insert errors" : "no signal",
      howto: promqlHowto(PAYMENT_SVCS, window),
      explore: spanExplore(PAYMENT_SVCS),
      steps: [
        {
          id: "charge",
          name: "Charge",
          light: charge.light,
          metric: `${fmtCount(charge.total)} · ${fmtCount(charge.errors)} err · ${fmtPct(charge.rate)}`,
          howto: promqlHowto(["payment"], window, ".*Charge.*|charge"),
          explore: paymentChargeErrorExplore(),
        },
        {
          id: "insert",
          name: "INSERT transactions",
          light: insert.light,
          metric: `${fmtCount(insert.total)} · ${fmtCount(insert.errors)} err`,
          howto: promqlHowto(["payment"], window, ".*INSERT.*|pg\\.query"),
          explore: spanExplore(["payment"], ".*INSERT.*|pg\\.query"),
        },
        {
          id: "postgres",
          name: "Postgres",
          light: postgres.light,
          metric: postgres.total
            ? `${fmtCount(postgres.total)} · ${fmtMs(postgres.latencyMs)}`
            : "no traffic",
          howto: promqlHowto(["payment"], window, "pg\\.|postgres|tcp\\.connect"),
          explore: spanExplore(["payment"], "pg\\.|tcp\\.connect"),
        },
      ],
    },
    {
      id: "fulfill",
      name: "FULFILL",
      light: fulfill.light,
      metric: emptyCart.latencyMs ? fmtMs(emptyCart.latencyMs) : fmtCount(fulfill.total),
      metricLabel: emptyCart.total ? "EmptyCart avg" : "fulfill calls",
      howto: promqlHowto(FULFILL_SVCS, window),
      explore: spanExplore(FULFILL_SVCS),
      steps: [
        {
          id: "empty-cart",
          name: "Empty cart",
          light: emptyCart.light,
          metric: `${fmtCount(emptyCart.total)} · ${fmtCount(emptyCart.errors)} err · ${fmtMs(emptyCart.latencyMs)}`,
          howto: promqlHowto(["cart", "checkout"], window, ".*EmptyCart.*"),
          explore: spanExplore(["cart", "checkout"], ".*EmptyCart.*"),
        },
        {
          id: "shipping",
          name: "Shipping",
          light: shipping.light,
          metric: shipping.total
            ? `${fmtCount(shipping.total)} · ${fmtMs(shipping.latencyMs)}`
            : "no traffic",
          howto: promqlHowto(["shipping"], window),
          explore: spanExplore(["shipping"]),
        },
        {
          id: "email",
          name: "Confirmation email",
          light: email.light,
          metric: email.total
            ? `${fmtCount(email.total)} · ${fmtMs(email.latencyMs)}`
            : "no traffic",
          howto: promqlHowto(["email"], window),
          explore: spanExplore(["email"]),
        },
      ],
    },
  ];

  const touchpoints: Touchpoint[] = [
    {
      name: "Checkout error rate (HTTP 500s)",
      light: postCheckout.light,
      value: postCheckout.total ? fmtPct(postCheckout.rate) : "—",
      explore: checkoutHttpErrorExplore(),
    },
    {
      name: "Charge failure rate (span metrics)",
      light: charge.light,
      value: charge.total ? fmtPct(charge.rate) : "—",
      explore: paymentChargeErrorExplore(),
    },
    {
      name: "Browse volume (frontend + catalog + recs)",
      light: browse.light,
      value: fmtCount(browse.total),
      explore: spanExplore(BROWSE_SVCS),
    },
    {
      name: "Payment latency (avg)",
      light: payment.light,
      value: fmtMs(payment.latencyMs),
      explore: spanExplore(PAYMENT_SVCS),
    },
  ];

  const spanBusiness: BusinessMetric[] = [
    {
      id: "checkout-errors",
      label: "Checkout errors",
      value: postCheckout.total ? fmtPct(postCheckout.rate) : "—",
      hint: "HTTP 500s on POST /api/checkout",
      howto: promqlHowto(["frontend"], window, "POST /api/checkout", "http"),
      light: postCheckout.light,
      explore: checkoutHttpErrorExplore(),
    },
    {
      id: "payment-errors",
      label: "Payment / Charge errors",
      value: charge.total ? fmtPct(charge.rate) : "—",
      hint: "span metrics · payment",
      howto: promqlHowto(["payment"], window, ".*Charge.*|charge"),
      light: charge.light,
      explore: paymentChargeErrorExplore(),
    },
    {
      id: "cart-units",
      label: "Cart calls",
      value: fmtCount(cart.total),
      hint: "span metrics · cart service",
      howto: promqlHowto(CART_SVCS, window),
      light: cart.light,
      explore: spanExplore(CART_SVCS),
    },
    {
      id: "fulfill-latency",
      label: "EmptyCart latency",
      value: fmtMs(emptyCart.latencyMs),
      hint: "span metrics · EmptyCart",
      howto: promqlHowto(["cart", "checkout"], window, ".*EmptyCart.*"),
      light: emptyCart.light,
      explore: spanExplore(["cart", "checkout"], ".*EmptyCart.*"),
    },
  ];

  return {
    window,
    browse,
    cart,
    checkout,
    payment,
    fulfill,
    catalog,
    productPage,
    recs,
    addItem,
    getCart,
    redis,
    postCheckout,
    placeOrder,
    orderPrep,
    charge,
    insert,
    postgres,
    emptyCart,
    shipping,
    email,
    stages,
    touchpoints,
    spanBusiness,
    live,
  };
}

export function lightOf(s: SvcStats): Light {
  return s.light;
}
