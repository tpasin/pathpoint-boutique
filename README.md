# Pathpoint Boutique

Live **Pathpoint-style** purchase journey for `astronomy-demo`, powered by your local Coralogix `cx` CLI.

## Features

- Traffic-light **stages → steps → touchpoints** for Browse → Cart → Checkout → Payment → Fulfill
- **Datetime range picker** + presets (15m / 1h / 6h / 24h)
- **Refresh** and optional **auto-refresh every 60s**
- Buttons that open **Coralogix Explore** (logs/traces) for each stage, step, and touchpoint
- **Traces** panel: pull recent failing/slow traces per stage and deep-link by trace ID
- Product demand ranking from cart `AddItemAsync` logs

## Prerequisites

1. [Coralogix CLI](https://coralogix.com/) (`cx`) installed and authenticated  
   ```bash
   cx profiles list
   ```
2. Node.js 20+

## Run

```bash
cp .env.local.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Set `NEXT_PUBLIC_CORALOGIX_UI_BASE` in `.env.local` to your Coralogix app URL if deep-links should use a different host than `https://us2.app.coralogix.com`.

## API

| Endpoint | Description |
|---|---|
| `GET /api/journey?start=&end=` | Build full Pathpoint snapshot from Coralogix |
| `GET /api/traces?stage=&start=&end=` | Recent traces for `browse` \| `cart` \| `checkout` \| `payment` \| `fulfill` |

Queries run server-side via `cx dataprime query` using your default profile (`Thiago` / `us2`).
