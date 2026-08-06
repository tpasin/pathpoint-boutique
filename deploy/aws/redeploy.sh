#!/usr/bin/env bash
# Redeploy Boutique Pathpoint to the existing EC2 (no new instance).
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-cenco-deploy}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SECRETS_DIR="$REPO_ROOT/deploy/aws/.secrets"
KEY_NAME="${KEY_NAME:-boutique-pathpoint}"
PEM="$SECRETS_DIR/${KEY_NAME}.pem"
PUBLIC_IP="${PUBLIC_IP:-$(cat "$REPO_ROOT/deploy/aws/.last-public-ip" 2>/dev/null || true)}"

: "${PUBLIC_IP:?Set PUBLIC_IP or run launch-ec2.sh first}"
[[ -f "$PEM" ]] || { echo "Missing PEM: $PEM" >&2; exit 1; }

if [[ -f "${CX_ENV_FILE:-$HOME/.cx/boutique-api-key.env}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${CX_ENV_FILE:-$HOME/.cx/boutique-api-key.env}"
  set +a
fi
: "${CX_API_KEY:?Set CX_API_KEY or create ~/.cx/boutique-api-key.env}"
: "${NEXT_PUBLIC_CORALOGIX_UI_BASE:=https://onlineboutique-dev.app.cx498.coralogix.com}"
: "${CX_REGION:=https://api.cx498.coralogix.com}"

SSH=(ssh -i "$PEM" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o BatchMode=yes)

echo "==> Syncing to $PUBLIC_IP"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .next --exclude 'deploy/aws/.secrets' \
  --exclude '.env.local' \
  -e "ssh -i $PEM -o StrictHostKeyChecking=accept-new" \
  "$REPO_ROOT/" "ec2-user@${PUBLIC_IP}:/tmp/boutique-pathpoint-src/"

REMOTE_ENV=$(mktemp)
chmod 600 "$REMOTE_ENV"
cat >"$REMOTE_ENV" <<EOF
NEXT_PUBLIC_CORALOGIX_UI_BASE=${NEXT_PUBLIC_CORALOGIX_UI_BASE}
CX_REGION=${CX_REGION}
CX_API_KEY=${CX_API_KEY}
CX_PROFILE=Thiago
CX_BIN=/usr/local/bin/cx
CX_MAX_CONCURRENT=3
CX_TIER=archive
JOURNEY_CACHE_TTL_MS=180000
SLO_CACHE_TTL_MS=180000
QUERY_CACHE_TTL_MS=180000
NODE_OPTIONS=--max-old-space-size=1536
PORT=3000
HOSTNAME=0.0.0.0
EOF
scp -i "$PEM" -o StrictHostKeyChecking=accept-new "$REMOTE_ENV" "ec2-user@${PUBLIC_IP}:/tmp/boutique-pathpoint.env"
rm -f "$REMOTE_ENV"

"${SSH[@]}" ec2-user@"$PUBLIC_IP" bash -s <<'REMOTE'
set -euo pipefail
sudo rsync -a /tmp/boutique-pathpoint-src/ /opt/boutique-pathpoint/
sudo mv /tmp/boutique-pathpoint.env /etc/boutique-pathpoint.env
sudo chown root:pathpoint /etc/boutique-pathpoint.env
sudo chmod 640 /etc/boutique-pathpoint.env
sudo bash /opt/boutique-pathpoint/deploy/aws/ec2-bootstrap.sh
sudo chown -R pathpoint:pathpoint /opt/boutique-pathpoint
# Keep env group-readable by the service user
sudo chown root:pathpoint /etc/boutique-pathpoint.env
sudo chmod 640 /etc/boutique-pathpoint.env
cd /opt/boutique-pathpoint
sudo -u pathpoint bash -lc 'set -a; source /etc/boutique-pathpoint.env; set +a; cd /opt/boutique-pathpoint; npm ci; npm run build'
sudo systemctl daemon-reload
sudo systemctl restart boutique-pathpoint
sudo systemctl restart nginx
sleep 4
systemctl is-active boutique-pathpoint
systemctl is-active nginx
curl -s -o /dev/null -w "local80:%{http_code}\n" http://127.0.0.1/
curl -s http://127.0.0.1:3000/api/health; echo
REMOTE

echo "Redeployed: http://${PUBLIC_IP}/"
