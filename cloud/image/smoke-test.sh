#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  cat >&2 <<'EOF'
Usage:
  cloud/image/smoke-test.sh https://workspace.example.com \
    BOOTSTRAP_CREDENTIAL first-admin@example.com

The script verifies public HTTPS, issues a single-use first-Administrator setup
link, and verifies that the link is accepted. Complete the returned setup page
manually and confirm the delivered email to finish the ADR-0037/0042 trust loop.
EOF
  exit 2
fi

base_url="${1%/}"
bootstrap_credential="$2"
administrator_email="$3"

if [[ "$base_url" != https://* ]]; then
  echo "the smoke target must use https://" >&2
  exit 2
fi

for _ in $(seq 1 120); do
  if curl --fail --silent --show-error "$base_url/health" >/dev/null; then
    break
  fi
  sleep 5
done
curl --fail --silent --show-error "$base_url/health" >/dev/null

response="$(curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bootstrap $bootstrap_credential" \
  --header 'Content-Type: application/json' \
  --data "$(jq -cn --arg email "$administrator_email" '{purpose:"setup",email:$email}')" \
  "$base_url/api/workspace/v1/operator/links")"
token="$(jq -er '.data.token' <<<"$response")"
setup_url="$base_url/setup/$token"
curl --fail --silent --show-error "$setup_url" >/dev/null

cat <<EOF
HTTPS and the setup-link issuer are healthy.

Open this single-use link:
  $setup_url

Then:
  1. Submit the Workspace name and $administrator_email.
  2. Confirm the magic-link email arrived from the configured sender.
  3. Open that confirmation link and verify /app loads.
  4. Run: systemctl is-active gbrain-web gbrain-worker gbrain-scheduler caddy postgresql
EOF
