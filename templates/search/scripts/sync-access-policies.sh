#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# sync-access-policies.sh - idempotently sync Cloudflare Access policies.
#
# Mirrors the logic driven by .github/actions/sync-access-policies/action.yml,
# extracted so it can be run locally and unit-tested in isolation.
#
# Required environment variables:
#   CLOUDFLARE_API_TOKEN   Cloudflare API token
#   CLOUDFLARE_ACCOUNT_ID  Cloudflare account ID
#   APP_ID                 Cloudflare Access application ID
#
# Optional environment variables:
#   EMAIL_DOMAIN   Primary employee email domain. Empty by default for public ProDocStore KBs.
#   CLIENT_EMAILS  Comma-separated client email addresses to allow
#   CLIENT_DOMAIN  Single client email domain to allow
#   OFFICE_CIDRS   Comma-separated office CIDRs that bypass auth entirely
#   ACCESS_RULES_JSON  JSON object with include, require, and/or exclude arrays.
#                      A JSON array is accepted as shorthand for include.
#
# Overrides for testing:
#   CURL           curl binary to invoke (default: curl)
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${APP_ID:?APP_ID is required}"

EMAIL_DOMAIN="${EMAIL_DOMAIN:-}"
CLIENT_EMAILS="${CLIENT_EMAILS:-}"
CLIENT_DOMAIN="${CLIENT_DOMAIN:-}"
OFFICE_CIDRS="${OFFICE_CIDRS:-}"
ACCESS_RULES_JSON="${ACCESS_RULES_JSON:-}"
CURL="${CURL:-curl}"

BASE="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access"
ALLOW_NAME="Allow ProDocStore users"
BYPASS_NAME="Office network bypass"

# ── Build allow-policy include array ──
if [ -n "$EMAIL_DOMAIN" ]; then
  ALLOW_INCLUDES=$(jq -nc --arg d "$EMAIL_DOMAIN" \
    '[{email_domain:{domain:$d}}]')
else
  ALLOW_INCLUDES='[]'
fi
ALLOW_REQUIRES='[]'
ALLOW_EXCLUDES='[]'

if [ -n "$CLIENT_DOMAIN" ]; then
  ALLOW_INCLUDES=$(jq -c --arg d "$CLIENT_DOMAIN" \
    '. + [{email_domain:{domain:$d}}]' <<<"$ALLOW_INCLUDES")
fi

if [ -n "$CLIENT_EMAILS" ]; then
  IFS=',' read -ra _emails <<< "$CLIENT_EMAILS"
  for e in "${_emails[@]}"; do
    e_trim=$(echo "$e" | xargs)
    [ -z "$e_trim" ] && continue
    ALLOW_INCLUDES=$(jq -c --arg e "$e_trim" \
      '. + [{email:{email:$e}}]' <<<"$ALLOW_INCLUDES")
  done
fi

if [ -n "$ACCESS_RULES_JSON" ]; then
  if ! jq -e 'if type == "array" then true elif type == "object" then ((keys - ["include","require","exclude"]) | length == 0) and ((.include? // []) | type == "array") and ((.require? // []) | type == "array") and ((.exclude? // []) | type == "array") else false end' >/dev/null <<<"$ACCESS_RULES_JSON"; then
    echo "::error::ACCESS_RULES_JSON must be an array, or an object with include, require, and exclude arrays"
    exit 1
  fi
  ACCESS_INCLUDE=$(jq -c 'if type == "array" then . else (.include // []) end' <<<"$ACCESS_RULES_JSON")
  ACCESS_REQUIRE=$(jq -c 'if type == "array" then [] else (.require // []) end' <<<"$ACCESS_RULES_JSON")
  ACCESS_EXCLUDE=$(jq -c 'if type == "array" then [] else (.exclude // []) end' <<<"$ACCESS_RULES_JSON")
  ALLOW_INCLUDES=$(jq -c --argjson rules "$ACCESS_INCLUDE" '. + $rules' <<<"$ALLOW_INCLUDES")
  ALLOW_REQUIRES=$(jq -c --argjson rules "$ACCESS_REQUIRE" '. + $rules' <<<"$ALLOW_REQUIRES")
  ALLOW_EXCLUDES=$(jq -c --argjson rules "$ACCESS_EXCLUDE" '. + $rules' <<<"$ALLOW_EXCLUDES")
fi

if { [ "$ALLOW_REQUIRES" != "[]" ] || [ "$ALLOW_EXCLUDES" != "[]" ]; } && [ "$ALLOW_INCLUDES" = "[]" ]; then
  echo "::error::Access require/exclude rules need at least one include rule"
  exit 1
fi

# ── Build bypass-policy include array ──
BYPASS_INCLUDES="[]"
if [ -n "$OFFICE_CIDRS" ]; then
  IFS=',' read -ra _cidrs <<< "$OFFICE_CIDRS"
  for c in "${_cidrs[@]}"; do
    c_trim=$(echo "$c" | xargs)
    [ -z "$c_trim" ] && continue
    BYPASS_INCLUDES=$(jq -c --arg c "$c_trim" \
      '. + [{ip:{ip:$c}}]' <<<"$BYPASS_INCLUDES")
  done
fi

# ── List existing policies (check API success first) ──
EXISTING=$("$CURL" -sS "${BASE}/apps/${APP_ID}/policies" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

if [ "$(echo "$EXISTING" | jq -r '.success // false')" != "true" ]; then
  echo "::error::Failed to list policies"
  echo "$EXISTING" | jq -r '.errors // [] | .[] | "  code=\(.code) message=\(.message)"' >&2
  exit 1
fi

echo "Existing policies:"
echo "$EXISTING" | jq -r '(.result // [])[] | "  \(.id) prec=\(.precedence) \(.name)"'

# Delete ALL existing policies (clean slate for idempotency).
ALL_IDS=$(echo "$EXISTING" | jq -r '(.result // [])[].id')
for pid in $ALL_IDS; do
  pname=$(echo "$EXISTING" | jq -r --arg id "$pid" '.result[] | select(.id==$id) | .name')
  echo "Deleting policy: $pname ($pid)"
  del_resp=$("$CURL" -sS -X DELETE \
    "${BASE}/apps/${APP_ID}/policies/${pid}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  if [ "$(echo "$del_resp" | jq -r '.success // false')" != "true" ]; then
    echo "::warning::Failed to delete policy $pname ($pid): $(echo "$del_resp" | jq -r '.errors[0].message // "unknown"')"
  fi
done

# Check what policies remain (some may be undeletable reusable policies).
REMAINING=$("$CURL" -sS "${BASE}/apps/${APP_ID}/policies" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
REMAIN_COUNT=$(echo "$REMAINING" | jq '(.result // []) | length')
if [ "$REMAIN_COUNT" -gt 0 ]; then
  echo "$REMAIN_COUNT undeletable policies remain:"
  echo "$REMAINING" | jq -r '(.result // [])[] | "  prec=\(.precedence) \(.name)"'
fi

if [ "$ALLOW_INCLUDES" = "[]" ] && [ "$BYPASS_INCLUDES" = "[]" ]; then
  echo "No Access allow rules configured; managed policies were removed so the app stays closed by default."
  exit 0
fi

# Find next available precedences (avoid conflicts with undeletable policies).
# Reserve a slot for bypass only if we'll actually create one, so the allow
# policy can take precedence 1 when it's the only managed policy.
USED_PRECS=$(echo "$REMAINING" | jq -r '[(.result // [])[].precedence] | sort | .[]')
next_prec() {
  local candidate=$1
  local taken="$2"
  while echo "$taken" | grep -qx "$candidate"; do
    candidate=$((candidate + 1))
  done
  echo "$candidate"
}

if [ "$BYPASS_INCLUDES" != "[]" ]; then
  BYPASS_PREC=$(next_prec 1 "$USED_PRECS")
  ALLOW_PREC=$(next_prec $((BYPASS_PREC + 1)) "$USED_PRECS"$'\n'"$BYPASS_PREC")
else
  BYPASS_PREC=""
  ALLOW_PREC=$(next_prec 1 "$USED_PRECS")
fi

# ── Create bypass policy if any office CIDRs ──
if [ "$BYPASS_INCLUDES" != "[]" ]; then
  payload=$(jq -nc \
    --arg name "$BYPASS_NAME" \
    --argjson inc "$BYPASS_INCLUDES" \
    --argjson prec "$BYPASS_PREC" \
    '{name:$name, decision:"bypass", precedence:$prec, include:$inc}')
  resp=$("$CURL" -sS -X POST "${BASE}/apps/${APP_ID}/policies" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$payload")
  if [ "$(jq -r '.success // false' <<<"$resp")" != "true" ]; then
    echo "::error::Failed to create bypass policy"
    echo "$resp" >&2
    exit 1
  fi
  echo "Created bypass policy at precedence $BYPASS_PREC ($(jq 'length' <<<"$BYPASS_INCLUDES") CIDR rule(s))"
fi

# ── Create allow policy if any identity rule is configured ──
if [ "$ALLOW_INCLUDES" != "[]" ]; then
  payload=$(jq -nc \
    --arg name "$ALLOW_NAME" \
    --argjson inc "$ALLOW_INCLUDES" \
    --argjson req "$ALLOW_REQUIRES" \
    --argjson exc "$ALLOW_EXCLUDES" \
    --argjson prec "$ALLOW_PREC" \
    '{name:$name, decision:"allow", precedence:$prec, include:$inc} + (if ($req | length) > 0 then {require:$req} else {} end) + (if ($exc | length) > 0 then {exclude:$exc} else {} end)')
  echo "Creating allow policy with $(jq 'length' <<<"$ALLOW_INCLUDES") include rule(s)..."
  echo "Payload: $payload"
  resp=$("$CURL" -sS -X POST "${BASE}/apps/${APP_ID}/policies" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$payload")
  if [ "$(jq -r '.success // false' <<<"$resp")" != "true" ]; then
    echo "::error::Failed to create allow policy"
    echo "$resp" >&2
    exit 1
  fi
  echo "Created allow policy at precedence $ALLOW_PREC ($(jq 'length' <<<"$ALLOW_INCLUDES") include rule(s))"
else
  echo "No identity allow rules configured; skipping allow policy."
fi
