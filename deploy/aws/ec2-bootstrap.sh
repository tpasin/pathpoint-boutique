#!/usr/bin/env bash
# Bootstrap Boutique Pathpoint on Amazon Linux 2023 (Node + cx + nginx).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/boutique-pathpoint}"
APP_USER="${APP_USER:-pathpoint}"
NODE_MAJOR="${NODE_MAJOR:-22}"
CX_VERSION="${CX_VERSION:-0.1.14}"

echo "==> Installing system packages"
dnf -y update || true
# AL2023 ships curl-minimal; do not install `curl` (conflicts). Install nginx separately.
dnf -y install git tar gzip which rsync || true
dnf -y install nginx
mkdir -p /etc/nginx/conf.d /var/cache/nginx/pathpoint


echo "==> Installing Node ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  dnf -y install nodejs
fi
node -v
npm -v

echo "==> Installing Coralogix cx CLI ${CX_VERSION} (linux musl)"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) CX_ARCH=x86_64-unknown-linux-musl ;;
  aarch64|arm64) CX_ARCH=aarch64-unknown-linux-musl ;;
  *) echo "Unsupported arch $ARCH"; exit 1 ;;
esac
curl -fsSL "https://github.com/coralogix/cx-cli/releases/download/v${CX_VERSION}/cx-${CX_VERSION}-${CX_ARCH}.tar.gz" \
  -o /tmp/cx.tgz
tar -xzf /tmp/cx.tgz -C /tmp
install -m 755 /tmp/cx /usr/local/bin/cx
cx --version || true

echo "==> Creating app user"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [[ ! -f /etc/boutique-pathpoint.env ]]; then
  cat >/etc/boutique-pathpoint.env <<'EOF'
NEXT_PUBLIC_CORALOGIX_UI_BASE=https://onlineboutique-dev.app.cx498.coralogix.com
CX_REGION=https://api.cx498.coralogix.com
CX_BIN=/usr/local/bin/cx
CX_MAX_CONCURRENT=3
CX_TIER=archive
JOURNEY_CACHE_TTL_MS=180000
SLO_CACHE_TTL_MS=180000
QUERY_CACHE_TTL_MS=180000
NODE_OPTIONS=--max-old-space-size=1536
# CX_API_KEY injected by launch script
PORT=3000
HOSTNAME=0.0.0.0
EOF
  chmod 600 /etc/boutique-pathpoint.env
fi

cat >/etc/systemd/system/boutique-pathpoint.service <<EOF
[Unit]
Description=Boutique Pathpoint (Next.js)
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/boutique-pathpoint.env
Environment=NODE_ENV=production
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

echo "==> Configuring nginx reverse proxy + API cache"
mkdir -p /var/cache/nginx/pathpoint
cat >/etc/nginx/conf.d/boutique-pathpoint.conf <<'NGINX'
limit_req_zone $binary_remote_addr zone=pathpoint_api:10m rate=8r/s;
limit_req_zone $binary_remote_addr zone=pathpoint_olly:10m rate=1r/s;

proxy_cache_path /var/cache/nginx/pathpoint levels=1:2 keys_zone=pathpoint:32m
  max_size=256m inactive=10m use_temp_path=off;

upstream boutique_next {
  server 127.0.0.1:3000;
  keepalive 32;
}

server {
  listen 80 default_server;
  server_name _;
  client_max_body_size 1m;

  # Static / Next assets — long cache at edge
  location /_next/static/ {
    proxy_pass http://boutique_next;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    expires 7d;
    add_header Cache-Control "public, max-age=604800, immutable";
  }

  location /api/journey {
    limit_req zone=pathpoint_api burst=20 nodelay;
    proxy_pass http://boutique_next;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 5s;
    proxy_read_timeout 130s;
    proxy_cache pathpoint;
    proxy_cache_methods GET HEAD;
    proxy_cache_valid 200 45s;
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_cache_lock on;
    proxy_cache_lock_timeout 10s;
    add_header X-Cache-Status $upstream_cache_status;
  }

  location /api/slos {
    limit_req zone=pathpoint_api burst=20 nodelay;
    proxy_pass http://boutique_next;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_cache pathpoint;
    proxy_cache_methods GET HEAD;
    proxy_cache_valid 200 60s;
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_cache_lock on;
    add_header X-Cache-Status $upstream_cache_status;
  }

  location /api/olly {
    limit_req zone=pathpoint_olly burst=5 nodelay;
    proxy_pass http://boutique_next;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 200s;
  }

  location /api/cursor {
    limit_req zone=pathpoint_olly burst=3 nodelay;
    proxy_pass http://boutique_next;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 300s;
  }

  location / {
    limit_req zone=pathpoint_api burst=40 nodelay;
    proxy_pass http://boutique_next;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 130s;
  }
}
NGINX

# Drop default AL2023 welcome server if present
rm -f /etc/nginx/conf.d/default.conf 2>/dev/null || true

systemctl daemon-reload
systemctl enable nginx
systemctl restart nginx || systemctl start nginx
echo "==> Bootstrap done"
