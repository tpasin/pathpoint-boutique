# Pathpoint · Online Boutique

Purchase-journey traffic lights for Coralogix application **`astronomy-demo`** (Online Boutique microservices). Business path first — Browse → Cart → Checkout → Payment → Fulfill — then attach live spans, logs, RUM, and Session Replay.

**Live:** [http://18.226.161.158/](http://18.226.161.158/)  
**Source:** [github.com/tpasin/pathpoint-boutique](https://github.com/tpasin/pathpoint-boutique)  
**Architecture:** [http://18.226.161.158/architecture](http://18.226.161.158/architecture) (also `/architecture` in this repo via `ARCHITECTURE.md`)

## Features

- Traffic-light **stages → steps → touchpoints**
- Datetime range + presets (15m / 1h / 6h / 24h)
- Coralogix Explore deep-links per box
- **Right-click → View / Edit on GitHub** for the defining source file
- Traces panel (errors / by ms filters)
- Top products, RUM users, Session Replay hub
- Olly chat (Coralogix AI)
- **Architecture** page with live diagrams

## Deploy (AWS only)

This Pathpoint runs on **AWS EC2** (nginx :80 → Next.js :3000). Local `next dev` is not the supported runtime.

```bash
# Credentials (never commit)
# ~/.cx/boutique-api-key.env → CX_API_KEY, CX_REGION, NEXT_PUBLIC_CORALOGIX_UI_BASE
# AWS credentials with EC2 rights in us-east-2

npm run deploy:aws      # first launch + Elastic IP
npm run redeploy:aws    # rsync + build + restart
```

On the instance: systemd `boutique-pathpoint`, env `/etc/boutique-pathpoint.env`, PEM under `deploy/aws/.secrets/` (gitignored).

Optional public UI vars (baked at build):

```bash
NEXT_PUBLIC_CORALOGIX_UI_BASE=https://onlineboutique-dev.app.cx498.coralogix.com
NEXT_PUBLIC_GITHUB_REPO=tpasin/pathpoint-boutique
NEXT_PUBLIC_GITHUB_BRANCH=main
```

## Sales path

| Stage | Primary services |
|---|---|
| Browse | `frontend`, `product-catalog`, `recommendation` |
| Cart | `cart`, Redis |
| Checkout | `POST /api/checkout`, `checkout` PlaceOrder |
| Payment | `payment` / Charge |
| Fulfill | EmptyCart, `shipping`, `email` |

## API

| Route | Purpose |
|---|---|
| `GET /api/journey` | Journey snapshot for the time range |
| `GET /api/traces` | Diversified traces for a stage |
| `POST /api/olly` | Ask Olly |
| `GET /api/slos` | Boutique SLOs |
| `GET /api/health` | Health / cx probe |
| `GET /architecture` | Architecture docs + diagrams |
