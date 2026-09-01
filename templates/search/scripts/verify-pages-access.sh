#!/usr/bin/env bash
# Verify Cloudflare Pages public/private exposure after a deployment.
#
# Required:
#   CLOUDFLARE_API_TOKEN
#   CLOUDFLARE_ACCOUNT_ID
#   PROJECT_NAME
#   PAGES_DOMAIN
#
# Optional:
#   PROTECT_SITE          true for private KBs, false for public KBs
#   VERIFY_WAIT_SECONDS  propagation wait, default 15
#   CURL                 curl binary, default curl

set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${PROJECT_NAME:?PROJECT_NAME is required}"
: "${PAGES_DOMAIN:?PAGES_DOMAIN is required}"

PROTECT_SITE="${PROTECT_SITE:-true}"
VERIFY_WAIT_SECONDS="${VERIFY_WAIT_SECONDS:-15}"
CURL="${CURL:-curl}"

if [ "$VERIFY_WAIT_SECONDS" != "0" ]; then
  sleep "$VERIFY_WAIT_SECONDS"
fi

DOMAIN="${PAGES_DOMAIN}"
BASE="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${PROJECT_NAME}"
body="$(mktemp)"
status="$("$CURL" -sS -L -o "$body" -w "%{http_code}" --max-time 20 "https://${DOMAIN}" || true)"
status="${status:-000}"
echo "https://${DOMAIN} returned HTTP ${status}"

rollback_latest_deployment() {
  local deployments latest_id delete_response
  deployments="$("$CURL" -sS "${BASE}/deployments" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
  if [ "$(jq -r '.success // false' <<<"$deployments")" != "true" ]; then
    echo "::error::Private KB verification failed and deployments could not be listed for rollback."
    echo "$deployments" >&2
    return 1
  fi
  latest_id="$(jq -r '.result[0].id // empty' <<<"$deployments")"
  if [ -z "$latest_id" ]; then
    echo "::error::Private KB verification failed and no deployment id was available for rollback."
    echo "$deployments" >&2
    return 1
  fi
  delete_response="$("$CURL" -sS -X DELETE "${BASE}/deployments/${latest_id}?force=true" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
  if [ "$(jq -r '.success // false' <<<"$delete_response")" != "true" ]; then
    echo "::error::Private KB verification failed and rollback delete failed for deployment ${latest_id}."
    echo "$delete_response" >&2
    return 1
  fi
  echo "Rolled back latest deployment ${latest_id}."
}

if [ "$PROTECT_SITE" = "true" ]; then
  case "$status" in
    200)
      echo "::error::Private KB is publicly accessible. Rolling back latest deployment."
      rollback_latest_deployment
      exit 1
      ;;
    000|5*)
      echo "::error::Private KB verification could not reach https://${DOMAIN}; failing closed."
      rollback_latest_deployment
      exit 1
      ;;
    *)
      echo "Private KB is not publicly readable."
      ;;
  esac
else
  if [ "$status" != "200" ]; then
    echo "::error::Public KB verification expected HTTP 200 from https://${DOMAIN}, got ${status}."
    exit 1
  fi
  echo "Public KB is reachable."
fi
