#!/usr/bin/env bash
# Launch Boutique Pathpoint on EC2 (Amazon Linux 2023) with public Elastic IP + nginx :80.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-cenco-deploy}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
# Medium for higher demo traffic (nginx cache + Next + concurrent cx)
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.medium}"
KEY_NAME="${KEY_NAME:-boutique-pathpoint}"
SG_NAME="${SG_NAME:-boutique-pathpoint-sg}"
TAG_NAME="${TAG_NAME:-boutique-pathpoint}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SECRETS_DIR="$REPO_ROOT/deploy/aws/.secrets"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# Load Coralogix API key (never echo)
if [[ -f "${CX_ENV_FILE:-$HOME/.cx/boutique-api-key.env}" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "${CX_ENV_FILE:-$HOME/.cx/boutique-api-key.env}"
  set +a
fi
: "${CX_API_KEY:?Set CX_API_KEY or create ~/.cx/boutique-api-key.env}"
: "${NEXT_PUBLIC_CORALOGIX_UI_BASE:=https://onlineboutique-dev.app.cx498.coralogix.com}"
: "${CX_REGION:=https://api.cx498.coralogix.com}"

echo "==> AWS identity ($REGION, profile=$AWS_PROFILE)"
aws sts get-caller-identity --region "$REGION" >/dev/null
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "Account: $ACCOUNT  Region: $REGION"

PEM="$SECRETS_DIR/${KEY_NAME}.pem"
if ! aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
  echo "==> Creating key pair $KEY_NAME"
  aws ec2 create-key-pair --region "$REGION" --key-name "$KEY_NAME" \
    --query 'KeyMaterial' --output text >"$PEM"
  chmod 400 "$PEM"
elif [[ ! -f "$PEM" ]]; then
  echo "Key pair $KEY_NAME exists in AWS but local PEM missing: $PEM" >&2
  echo "Delete the key pair in AWS or place the PEM at that path." >&2
  exit 1
fi

MY_IP=$(curl -4 -s --max-time 8 https://checkip.amazonaws.com || echo 0.0.0.0)
MY_CIDR="${SSH_CIDR:-${MY_IP}/32}"
echo "==> SSH from $MY_CIDR ; ports 80/3000 open publicly"

SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [[ -z "$SG_ID" || "$SG_ID" == "None" ]]; then
  VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' --output text)
  SG_ID=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "$SG_NAME" --description "Boutique Pathpoint" --vpc-id "$VPC_ID" \
    --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MY_CIDR,Description=ssh}]" \
    "IpProtocol=tcp,FromPort=3000,ToPort=3000,IpRanges=[{CidrIp=0.0.0.0/0,Description=pathpoint}]" \
    "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=http}]"
fi

AMI=$(aws ssm get-parameters --region "$REGION" \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameters[0].Value' --output text)

echo "==> Launching $INSTANCE_TYPE AMI=$AMI"
INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --user-data "fileb://$REPO_ROOT/deploy/aws/ec2-bootstrap.sh" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TAG_NAME}]" \
  --query 'Instances[0].InstanceId' --output text)

echo "Instance: $INSTANCE_ID"
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

ALLOC=$(aws ec2 allocate-address --region "$REGION" --domain vpc --query AllocationId --output text)
aws ec2 associate-address --region "$REGION" --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC" >/dev/null
PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC" \
  --query 'Addresses[0].PublicIp' --output text)
echo "Elastic IP: $PUBLIC_IP"

SSH=(ssh -i "$PEM" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o BatchMode=yes)

echo "==> Waiting for SSH + cloud-init"
for i in $(seq 1 48); do
  if "${SSH[@]}" ec2-user@"$PUBLIC_IP" "cloud-init status --wait >/dev/null 2>&1 || true; command -v node >/dev/null && command -v cx >/dev/null && echo ready" 2>/dev/null | grep -q ready; then
    echo "Bootstrap ready"
    break
  fi
  echo "  waiting ($i)…"
  sleep 10
done

echo "==> Syncing app"
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
sudo mkdir -p /opt/boutique-pathpoint
sudo rsync -a /tmp/boutique-pathpoint-src/ /opt/boutique-pathpoint/
sudo mv /tmp/boutique-pathpoint.env /etc/boutique-pathpoint.env
sudo chown root:pathpoint /etc/boutique-pathpoint.env
sudo chmod 640 /etc/boutique-pathpoint.env

# Ensure bootstrap finished (idempotent)
if ! command -v cx >/dev/null || ! id pathpoint >/dev/null 2>&1 || ! command -v nginx >/dev/null; then
  sudo bash /opt/boutique-pathpoint/deploy/aws/ec2-bootstrap.sh
else
  # Refresh nginx config from repo bootstrap when already present
  sudo bash /opt/boutique-pathpoint/deploy/aws/ec2-bootstrap.sh
fi

sudo chown -R pathpoint:pathpoint /opt/boutique-pathpoint
sudo chown root:pathpoint /etc/boutique-pathpoint.env
sudo chmod 640 /etc/boutique-pathpoint.env
cd /opt/boutique-pathpoint
sudo -u pathpoint bash -lc 'set -a; source /etc/boutique-pathpoint.env; set +a; cd /opt/boutique-pathpoint; npm ci; npm run build'

sudo systemctl daemon-reload
sudo systemctl enable --now boutique-pathpoint
sudo systemctl restart boutique-pathpoint
sudo systemctl enable --now nginx
sudo systemctl restart nginx
sleep 5
systemctl is-active boutique-pathpoint
systemctl is-active nginx
curl -s -o /dev/null -w "local3000:%{http_code}\n" http://127.0.0.1:3000/ || true
curl -s -o /dev/null -w "local80:%{http_code}\n" http://127.0.0.1/ || true
curl -s http://127.0.0.1:3000/api/health || true; echo
REMOTE

echo "$PUBLIC_IP" >"$REPO_ROOT/deploy/aws/.last-public-ip"
echo "$INSTANCE_ID" >"$REPO_ROOT/deploy/aws/.last-instance-id"
echo "$ALLOC" >"$REPO_ROOT/deploy/aws/.last-eip-alloc"

echo ""
echo "============================================"
echo " Pathpoint:  http://${PUBLIC_IP}/"
echo " Direct:     http://${PUBLIC_IP}:3000"
echo " SSH:        ssh -i deploy/aws/.secrets/${KEY_NAME}.pem ec2-user@${PUBLIC_IP}"
echo "============================================"

sleep 2
curl -s -o /dev/null -w "external80:%{http_code}\n" --max-time 20 "http://${PUBLIC_IP}/" || echo "external80:fail (SG/propagation?)"
curl -s -o /dev/null -w "external3000:%{http_code}\n" --max-time 20 "http://${PUBLIC_IP}:3000/" || echo "external3000:fail"
