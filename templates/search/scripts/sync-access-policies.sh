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
MANAGED_NAMES=$(jq -nc --arg allow "$ALLOW_NAME" --arg bypass "$BYPASS_NAME" '[$allow, $bypass]')
SIMPLE_EMAIL_ACCESS=false
if { [ -n "$EMAIL_DOMAIN" ] || [ -n "$CLIENT_DOMAIN" ] || [ -n "$CLIENT_EMAILS" ]; } && [ -z "$ACCESS_RULES_JSON" ]; then
  SIMPLE_EMAIL_ACCESS=true
fi

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

POLICIES=$(echo "$EXISTING" | jq -c '(.result // [])')

if [ "$ALLOW_INCLUDES" = "[]" ] && [ "$BYPASS_INCLUDES" = "[]" ]; then
  for managed_name in "$ALLOW_NAME" "$BYPASS_NAME"; do
    ids=$(jq -r --arg name "$managed_name" '.[] | select(.name == $name) | .id' <<<"$POLICIES")
    for pid in $ids; do
      echo "Deleting managed policy with no configured rules: $managed_name ($pid)"
      del_resp=$("$CURL" -sS -X DELETE \
        "${BASE}/apps/${APP_ID}/policies/${pid}" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
      if [ "$(echo "$del_resp" | jq -r '.success // false')" != "true" ]; then
        echo "::warning::Failed to delete managed policy $managed_name ($pid): $(echo "$del_resp" | jq -r '.errors[0].message // "unknown"')"
      fi
    done
  done
  echo "No Access allow rules configured; managed policies were removed so the app stays closed by default."
  exit 0
fi

# Find next available precedences. Manual policies are preserved and keep their
# precedence. ProDocStore-managed policies may be moved so bypass can remain
# ahead of allow without deleting a working policy before its replacement exists.
USED_PRECS=$(jq -r --argjson names "$MANAGED_NAMES" '[.[] | select((.name as $n | $names | index($n)) | not) | .precedence] | sort | .[]' <<<"$POLICIES")
next_prec() {
  local candidate=$1
  local taken="$2"
  while echo "$taken" | grep -qx "$candidate"; do
    candidate=$((candidate + 1))
  done
  echo "$candidate"
}

policy_id_by_name() {
  jq -r --arg name "$1" '[.[] | select(.name == $name)] | sort_by(.precedence // 999999) | .[0].id // empty' <<<"$POLICIES"
}

upsert_policy() {
  local name="$1"
  local payload="$2"
  local existing_id
  existing_id=$(policy_id_by_name "$name")
  if [ -n "$existing_id" ]; then
    echo "Updating managed policy: $name ($existing_id)" >&2
    resp=$("$CURL" -sS -X PUT "${BASE}/apps/${APP_ID}/policies/${existing_id}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "$payload")
    if [ "$(jq -r '.success // false' <<<"$resp")" != "true" ]; then
      echo "::error::Failed to update managed policy $name"
      echo "$resp" >&2
      exit 1
    fi
    echo "$existing_id"
  else
    echo "Creating managed policy: $name" >&2
    resp=$("$CURL" -sS -X POST "${BASE}/apps/${APP_ID}/policies" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "$payload")
    if [ "$(jq -r '.success // false' <<<"$resp")" != "true" ]; then
      echo "::error::Failed to create managed policy $name"
      echo "$resp" >&2
      exit 1
    fi
    jq -r '.result.id // empty' <<<"$resp"
  fi
}

delete_duplicate_managed_policies() {
  local name="$1"
  local keep_id="$2"
  ids=$(jq -r --arg name "$name" --arg keep "$keep_id" '.[] | select(.name == $name and .id != $keep) | .id' <<<"$POLICIES")
  for pid in $ids; do
    echo "Deleting duplicate managed policy: $name ($pid)"
    del_resp=$("$CURL" -sS -X DELETE \
      "${BASE}/apps/${APP_ID}/policies/${pid}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
    if [ "$(echo "$del_resp" | jq -r '.success // false')" != "true" ]; then
      echo "::warning::Failed to delete duplicate managed policy $name ($pid): $(echo "$del_resp" | jq -r '.errors[0].message // "unknown"')"
    fi
  done
}

if [ "$BYPASS_INCLUDES" != "[]" ]; then
  BYPASS_PREC=$(next_prec 1 "$USED_PRECS")
  ALLOW_PREC=$(next_prec $((BYPASS_PREC + 1)) "$USED_PRECS"$'\n'"$BYPASS_PREC")
else
  BYPASS_PREC=""
  ALLOW_PREC=$(next_prec 1 "$USED_PRECS")
fi

# For plain email-domain/email policies, force the Access application to use
# One-time PIN only. Otherwise Cloudflare may offer account-level social IdPs
# whose OAuth app belongs to a different product and can fail before Access
# policy evaluation.
if [ "$SIMPLE_EMAIL_ACCESS" = "true" ]; then
  echo "Ensuring One-time PIN login method for email-based Access policy..."
  idp_resp=$("$CURL" -sS "${BASE}/identity_providers" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  if [ "$(jq -r '.success // false' <<<"$idp_resp")" != "true" ]; then
    echo "::error::Cloudflare token cannot list Access identity providers. Add 'Access: Organizations, Identity Providers, and Groups Read' and Write permissions."
    echo "$idp_resp" >&2
    exit 1
  fi
  otp_id=$(jq -r '(.result // [])[] | select(.type == "onetimepin") | .id' <<<"$idp_resp" | head -1)
  if [ -z "$otp_id" ]; then
    create_idp_resp=$("$CURL" -sS -X POST "${BASE}/identity_providers" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data '{"name":"One-time PIN login","type":"onetimepin","config":{}}')
    otp_id=$(jq -r '.result.id // empty' <<<"$create_idp_resp")
    if [ -z "$otp_id" ]; then
      echo "::error::Cloudflare token cannot create the One-time PIN Access identity provider. Add 'Access: Organizations, Identity Providers, and Groups Write'."
      echo "$create_idp_resp" >&2
      exit 1
    fi
    echo "Created One-time PIN identity provider."
  fi

  app_resp=$("$CURL" -sS "${BASE}/apps/${APP_ID}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  if [ "$(jq -r '.success // false' <<<"$app_resp")" != "true" ]; then
    echo "::error::Failed to read Access app before login-method update"
    echo "$app_resp" >&2
    exit 1
  fi
  app_payload=$(jq -c --arg otp "$otp_id" '.result | {
    name,
    type,
    domain,
    self_hosted_domains,
    session_duration,
    allowed_idps: [$otp],
    auto_redirect_to_identity: false,
    app_launcher_visible: (.app_launcher_visible // true),
    enable_binding_cookie: (.enable_binding_cookie // false),
    http_only_cookie_attribute: (.http_only_cookie_attribute // true),
    options_preflight_bypass: (.options_preflight_bypass // false)
  }' <<<"$app_resp")
  update_app_resp=$("$CURL" -sS -X PUT "${BASE}/apps/${APP_ID}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$app_payload")
  if [ "$(jq -r '.success // false' <<<"$update_app_resp")" != "true" ]; then
    echo "::error::Failed to restrict Access app login method to One-time PIN"
    echo "$update_app_resp" >&2
    exit 1
  fi
  echo "Access app login method restricted to One-time PIN."
fi

# ── Create bypass policy if any office CIDRs ──
if [ "$BYPASS_INCLUDES" != "[]" ]; then
  payload=$(jq -nc \
    --arg name "$BYPASS_NAME" \
    --argjson inc "$BYPASS_INCLUDES" \
    --argjson prec "$BYPASS_PREC" \
    '{name:$name, decision:"bypass", precedence:$prec, include:$inc}')
  keep_id=$(upsert_policy "$BYPASS_NAME" "$payload")
  delete_duplicate_managed_policies "$BYPASS_NAME" "$keep_id"
  echo "Synced bypass policy at precedence $BYPASS_PREC ($(jq 'length' <<<"$BYPASS_INCLUDES") CIDR rule(s))"
else
  delete_duplicate_managed_policies "$BYPASS_NAME" ""
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
  echo "Syncing allow policy with $(jq 'length' <<<"$ALLOW_INCLUDES") include rule(s)..."
  echo "Payload: $payload"
  keep_id=$(upsert_policy "$ALLOW_NAME" "$payload")
  delete_duplicate_managed_policies "$ALLOW_NAME" "$keep_id"
  echo "Synced allow policy at precedence $ALLOW_PREC ($(jq 'length' <<<"$ALLOW_INCLUDES") include rule(s))"
else
  delete_duplicate_managed_policies "$ALLOW_NAME" ""
  echo "No identity allow rules configured; skipping allow policy."
fi
