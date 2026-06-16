#!/bin/bash
# D.A.V.E. Production Deploy
# Usage: ./deploy.sh [be|fe]   (default: both)
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-all}"

CF_STACK="dave-mind-dev"
REGION="us-east-1"
DOMAIN="davemind.drawvid.com"
S3_BUCKET="dave-drawvid-frontend"
CF_DIST="E35QS6JIENO2IC"

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo "▸ $*"; }
ok()    { echo "✓ $*"; }
fail()  { echo "✗ $*" >&2; exit 1; }

# ── Backend ───────────────────────────────────────────────────────────────────
deploy_be() {
  info "Deploying backend…"
  cd "$PROJECT_ROOT/mind"

  # serverless-domain-manager fails with "Base path already exists" on every
  # re-deploy after the first. The Lambda + API Gateway stack is updated
  # successfully before that hook runs, so we allow exit code 1 and fix
  # the domain mapping ourselves below.
  npx sls deploy 2>&1 || true

  # Resolve the API Gateway ID from the CloudFormation stack.
  API_ID=$(aws cloudformation describe-stack-resource \
    --stack-name "$CF_STACK" \
    --logical-resource-id ApiGatewayRestApi \
    --region "$REGION" \
    --query 'StackResourceDetail.PhysicalResourceId' \
    --output text 2>/dev/null) || fail "Could not read CloudFormation stack. Did the deploy fail?"

  info "API Gateway ID: $API_ID"

  # Ensure the custom domain points to the current API + stage.
  CURRENT_API=$(aws apigateway get-base-path-mappings \
    --domain-name "$DOMAIN" \
    --region "$REGION" \
    --query 'items[?basePath==`(none)`].restApiId' \
    --output text 2>/dev/null || echo "")

  if [ "$CURRENT_API" != "$API_ID" ]; then
    info "Updating custom domain mapping ($CURRENT_API → $API_ID)…"
    # Delete old mapping if it exists.
    if [ -n "$CURRENT_API" ]; then
      aws apigateway delete-base-path-mapping \
        --domain-name "$DOMAIN" --base-path '(none)' --region "$REGION"
    fi
    aws apigateway create-base-path-mapping \
      --domain-name "$DOMAIN" \
      --rest-api-id "$API_ID" \
      --stage dev \
      --region "$REGION" > /dev/null
    ok "Domain mapping updated."
  else
    ok "Domain mapping already correct."
  fi

  # Smoke-test the live endpoint.
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://"$DOMAIN"/health)
  [ "$STATUS" = "200" ] || fail "Health check failed (HTTP $STATUS). Check Lambda logs."
  ok "Backend live at https://$DOMAIN"
}

# ── Frontend ──────────────────────────────────────────────────────────────────
deploy_fe() {
  info "Building frontend…"
  cd "$PROJECT_ROOT/body"
  npm run build

  info "Syncing to S3…"
  aws s3 sync dist/ "s3://$S3_BUCKET" --delete

  info "Invalidating CloudFront…"
  INV_ID=$(aws cloudfront create-invalidation \
    --distribution-id "$CF_DIST" --paths "/*" \
    --query 'Invalidation.Id' --output text)
  ok "Frontend live — invalidation $INV_ID in progress."
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "$TARGET" in
  be)  deploy_be ;;
  fe)  deploy_fe ;;
  all) deploy_be && deploy_fe ;;
  *)   fail "Unknown target '$TARGET'. Use: be | fe | all (default)" ;;
esac
