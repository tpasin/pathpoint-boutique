# Pathpoint Boutique · Online Boutique

Live **Pathpoint-style** purchase journey for `astronomy-demo`, powered by your local Coralogix `cx` CLI — same pattern as Jumbo (Cenco) and Akua Pathpoints.

Modeled after [New Relic Pathpoint](https://docs.newrelic.com/docs/new-relic-solutions/business-observability/intro-pathpoint/): **business path first**, then attach system signals.

## Features

- Traffic-light **stages → steps → touchpoints** for Browse → Cart → Checkout → Payment → Fulfill
- **Datetime range picker** + presets (15m / 1h / 6h / 24h)
- **Refresh** and optional **auto-refresh every 60s**
- Buttons that open **Coralogix Explore** (logs/traces) for each stage, step, and touchpoint
- **Right-click → View / Edit on GitHub** — jump to the exact Pathpoint source file for that box
- **Traces** panel: pull recent failing/slow traces per stage and deep-link by trace ID
- Product demand ranking from cart `AddItemAsync` logs
- **Olly** panel: ask Coralogix AI via `cx olly ask` (journey brief, per-stage analysis, free-form chat)

## GitHub source links

Set in `.env.local` (defaults shown):

```bash
NEXT_PUBLIC_GITHUB_REPO=tpasin/pathpoint-boutique
NEXT_PUBLIC_GITHUB_BRANCH=main
```

Each stage, step, KPI, and panel is tagged with an `@pathpoint-source …` marker. Right-click a box and choose **View source on GitHub** or **Edit on GitHub**.

## Prerequisites

1. [Coralogix CLI](https://coralogix.com/) (`cx`) with the **Thiago** profile pointing at onlineboutique-dev  
   ```bash
   cx profiles list
   # Thiago · onlineboutique-dev · https://api.cx498.coralogix.com
   ```
2. Node.js 20+

## Run

```bash
cp .env.local.example .env.local
npm install
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)** (3001 = Jumbo/Cenco, 3002 = Akua).

Deep-links default to `https://onlineboutique-dev.app.cx498.coralogix.com`. Override with `NEXT_PUBLIC_CORALOGIX_UI_BASE` in `.env.local` if needed.

## Deploy on AWS (public URL)

Same pattern as Cenco/Akua: EC2 + Elastic IP, `AWS_PROFILE=cenco-deploy`, region `us-east-2`.

Boutique uses a **t3.medium**, **nginx on :80** (API cache + rate limits), and longer in-process caches so demo traffic does not stampede Coralogix.

```bash
# One-time: API key file (chmod 600)
# ~/.cx/boutique-api-key.env  →  CX_API_KEY + CX_REGION + NEXT_PUBLIC_CORALOGIX_UI_BASE

npm run deploy:aws
# → http://<elastic-ip>/

# Later updates (same instance)
npm run redeploy:aws
```

SSH PEM lands in `deploy/aws/.secrets/` (gitignored).

## Sales path (Online Boutique)

| Stage | Primary services |
|---|---|
| Browse | `frontend`, `product-catalog`, `recommendation` |
| Cart | `cart`, Redis |
| Checkout | `frontend` `POST /api/checkout`, `checkout` PlaceOrder |
| Payment | `payment` / Charge |
| Fulfill | EmptyCart, `shipping`, `email` |

## API

| Endpoint | Description |
|---|---|
| `GET /api/journey?start=&end=` | Build full Pathpoint snapshot from Coralogix |
| `GET /api/traces?stage=&start=&end=` | Recent traces for `browse` \| `cart` \| `checkout` \| `payment` \| `fulfill` |
| `POST /api/olly` | Ask Olly (`cx olly ask`). Body: `{ message?, stage?, chatId?, model?, start?, end? }` |

Queries run server-side via `cx -p Thiago dataprime query`. Olly uses `cx -p Thiago olly ask`.

### Olly examples

```bash
# Free-form
curl -s localhost:3000/api/olly -H 'content-type: application/json' \
  -d '{"message":"Why is checkout failing in astronomy-demo?"}'

# Stage preset (also available as Ask Olly on each chevron)
curl -s localhost:3000/api/olly -H 'content-type: application/json' \
  -d '{"stage":"checkout"}'

# Continue a chat
curl -s localhost:3000/api/olly -H 'content-type: application/json' \
  -d '{"message":"Drill into payment Charge errors","chatId":"<uuid>"}'
```

## Env

| Variable | Purpose |
|---|---|
| `CX_PROFILE` | Named `~/.cx` profile (default `Thiago`) |
| `CX_API_KEY` / `CX_REGION` | Alternate auth |
| `NEXT_PUBLIC_CORALOGIX_UI_BASE` | Explore deep-link host |
| `CX_OLLY_MODEL` | Default Olly model |
| `CX_OLLY_TIMEOUT` | Olly timeout seconds (default 180) |
| `CX_MAX_CONCURRENT` | Parallel `cx` processes (default 2) |

*Refs: cenco-pathpoint · Akua pathpoint · Coralogix MCP service map for `frontend`*
