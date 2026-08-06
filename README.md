# Pathpoint · Online Boutique

Purchase-journey traffic lights for Coralogix application **`astronomy-demo`** (Online Boutique microservices). Business path first — Browse → Cart → Checkout → Payment → Fulfill — with lights from **span metrics** (`calls_total` / `duration_ms_*`) and drill-down into **raw spans**, plus RUM, Session Replay, and Kubernetes Infra Explorer.

**Live:** [http://18.226.161.158/](http://18.226.161.158/)  
**Source:** [github.com/tpasin/pathpoint-boutique](https://github.com/tpasin/pathpoint-boutique)  
**Architecture:** [http://18.226.161.158/architecture](http://18.226.161.158/architecture) (also `/architecture` via `ARCHITECTURE.md`)

## Features

- Traffic-light **stages → steps → touchpoints** driven by **span metrics**
- Explore deep-links open matching **spans** (HTTP 500s for checkout; Charge errors for payment)
- Datetime range + presets (15m / 1h / 6h / 24h)
- **Right-click → View Infrastructure** (K8s cluster / node / pod / CPU / memory)
- **Right-click → View / Edit on GitHub** for the defining source file
- Traces panel (errors / by ms filters) from raw spans
- Top products, RUM users, Session Replay hub
- Olly chat (Coralogix AI)
- **Architecture** page with live diagrams (`ARCHITECTURE.md`)

## Deploy (AWS only)

This Pathpoint runs on **AWS EC2** (nginx :80 → Next.js :3000). Local `next dev` is not the supported runtime.

```bash
# Credentials (never commit)
# CX_PROFILE=Thiago (preferred) and/or CX_API_KEY in /etc/boutique-pathpoint.env
# AWS credentials with EC2 rights in us-east-2

npm run deploy:aws      # first launch + Elastic IP
npm run redeploy:aws    # rsync + build + restart
```

On the instance: systemd `boutique-pathpoint`, env `/etc/boutique-pathpoint.env` (includes `CX_PROFILE=Thiago`), PEM under `deploy/aws/.secrets/` (gitignored).

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
| Checkout | `POST /api/checkout` (HTTP 500s), `checkout` PlaceOrder |
| Payment | `payment` / Charge |
| Fulfill | EmptyCart, `shipping`, `email` |

## API

| Route | Purpose |
|---|---|
| `GET /api/journey` | Journey snapshot (span-metric lights + enrichment) |
| `GET /api/traces` | Diversified raw spans for a stage |
| `GET /api/k8s` | Kubernetes context + usage for a stage/step |
| `POST /api/olly` | Ask Olly |
| `GET /api/slos` | Boutique SLOs |
| `GET /api/health` | Health / cx probe |
| `GET /architecture` | Architecture docs + diagrams |
