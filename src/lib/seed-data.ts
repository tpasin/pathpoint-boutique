/**
 * Live astronomy-demo snapshot from onlineboutique-dev (cx498 / Thiago profile)
 * via Coralogix MCP + CLI. Used when CX_PROFILE / CX_API_KEY are unset.
 */
export type SeedKey =
  | "checkoutStatus"
  | "chargeStatus"
  | "emptyCart"
  | "catalogStatus"
  | "browseStatus"
  | "cartErrors"
  | "products"
  | "errorTraces"
  | "topUsers"
  | "sessionReplays"
  | "rumSessionCount"
  | "uniqueUserCount"
  | "recordingCount";

export const SEED_FETCHED_AT = "2026-08-03T21:40:00Z";
export const SEED_RANGE = {
  start: "2026-08-03T20:40:00Z",
  end: "2026-08-03T21:40:00Z",
};

export const SEED: Record<SeedKey, Record<string, unknown>[]> = {
  checkoutStatus: [
    { cnt: 99, status: "200" },
    { cnt: 404, status: "500" },
  ],
  chargeStatus: [
    { cnt: 320, code: "2", errored: "true" },
    { cnt: 99, code: "0", errored: null },
  ],
  emptyCart: [
    {
      avg_ms: 492.75,
      cnt: 99,
      code: "9",
      errored: "true",
      max_ms: 5208.76,
    },
  ],
  catalogStatus: [
    { cnt: 963, code: "13", errored: "true" },
    { cnt: 10046, code: "0", errored: null },
  ],
  browseStatus: [
    { cnt: 8038, status: "200" },
    { cnt: 1720, status: "500" },
    { cnt: 148, status: "304" },
  ],
  cartErrors: [
    { cnt: 213, message: "Wasn't able to connect to redis" },
    { cnt: 213, message: "Error emptying cart" },
  ],
  products: [
    { pid: "HQTGWGPNH4", pname: "HQTGWGPNH4", units: 760, revenue: 0, price: 0 },
    { pid: "2ZYFJ3GM2N", pname: "Hairdryer", units: 706, revenue: 38830, price: 55 },
    { pid: "LS4PSXUNUM", pname: "Seasoning Rack", units: 683, revenue: 12294, price: 18 },
    { pid: "6E92ZMYYFZ", pname: "Mug", units: 666, revenue: 5328, price: 8 },
    { pid: "66VCHSJNUP", pname: "Tank Top", units: 655, revenue: 11790, price: 18 },
    { pid: "L9ECAV7KIM", pname: "White Sneakers", units: 623, revenue: 55447, price: 89 },
    { pid: "1YMWWN1N4O", pname: "Steel Watch Womens", units: 613, revenue: 67430, price: 110 },
    { pid: "0PUK6V6EV0", pname: "Blanket White", units: 608, revenue: 7296, price: 12 },
    { pid: "9SIQT8TOJO", pname: "Glass Jar", units: 585, revenue: 2925, price: 5 },
    { pid: "OLJCESPC7Z", pname: "Bracelet", units: 548, revenue: 10412, price: 19 },
  ],
  errorTraces: [
    {
      traceID: "seed-checkout-500-example",
      duration_ms: 3200,
      operationName: "POST /api/checkout",
    },
  ],
  topUsers: [
    {
      uid: "628025",
      uname: "Charlotte Martin",
      country: "United States",
      city: "San Jose",
      cnt: 259,
    },
    {
      uid: "861115",
      uname: "Elijah Moore",
      country: "United States",
      city: "San Jose",
      cnt: 221,
    },
    {
      uid: "676457",
      uname: "Harper Singh",
      country: "United States",
      city: "San Jose",
      cnt: 199,
    },
    {
      uid: "447821",
      uname: "Evelyn Martinez",
      country: "United States",
      city: "San Jose",
      cnt: 197,
    },
    {
      uid: "823094",
      uname: "Noah Lopez",
      country: "United States",
      city: "San Jose",
      cnt: 191,
    },
    {
      uid: "977935",
      uname: "Mason Garcia",
      country: "United States",
      city: "San Jose",
      cnt: 186,
    },
    {
      uid: "684009",
      uname: "Isabella Nguyen",
      country: "United States",
      city: "San Jose",
      cnt: 185,
    },
    {
      uid: "998974",
      uname: "Daniel Jackson",
      country: "United States",
      city: "San Jose",
      cnt: 184,
    },
  ],
  sessionReplays: [
    {
      sid: "6f3d9a5d-a301-40d7-9aba-fd4f45a3839e",
      uname: "Ava Thomas",
      city: "San Jose",
      country: "United States",
      cnt: 131,
    },
    {
      sid: "db0f4b60-e2cb-4df1-bb8b-bbcac0a657b2",
      uname: "Evelyn Martinez",
      city: "San Jose",
      country: "United States",
      cnt: 126,
    },
    {
      sid: "ecf66d34-7c8a-474c-a7ba-8e580696c8d2",
      uname: "Aisha Schmidt",
      city: "San Jose",
      country: "United States",
      cnt: 123,
    },
    {
      sid: "5c2af008-3a02-4881-816e-c3bc9a212cea",
      uname: "James Martinez",
      city: "San Jose",
      country: "United States",
      cnt: 123,
    },
    {
      sid: "550d0fd9-ea78-4ae0-8c25-0c7d93ea6819",
      uname: "Fatima Williams",
      city: "San Jose",
      country: "United States",
      cnt: 122,
    },
    {
      sid: "dd3d08c7-f15f-4fef-a1e4-396d92c457a8",
      uname: "Isabella Rodriguez",
      city: "San Jose",
      country: "United States",
      cnt: 121,
    },
  ],
  rumSessionCount: [{ sessions: 84 }],
  uniqueUserCount: [{ users: 80 }],
  recordingCount: [{ recordings: 13 }],
};
