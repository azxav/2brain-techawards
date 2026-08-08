#!/usr/bin/env bash
# Generate the control-plane env file (#46). The two machine secrets are minted
# fresh here so they never pass through a chat transcript or a wiki; the seven
# external values are yours to supply. The fleet infrastructure identifiers below
# are hard-coded because the pilot is a single tenancy in one region — there is
# exactly one right value for each, and threading them through the environment
# would only add seven more things an operator can fat-finger.
#
# Run it like this (the seven values are yours; the two secrets are generated):
#
#   CP_GITHUB_CLIENT_ID=Iv1.xxxx \
#   CP_GITHUB_CLIENT_SECRET=xxxx \
#   CP_CLOUDFLARE_API_TOKEN=xxxx \
#   CP_CLOUDFLARE_ZONE_ID=xxxx \
#   CP_EMAIL_RESEND_API_KEY=re_xxxx \
#   CP_EMAIL_FROM='2Brain <noreply@2brainai.tech>' \
#   CP_OPENROUTER_PROVISIONING_KEY=sk-or-v1-xxxx \
#   CP_OPERATOR_GITHUB_IDS=1234567 \
#   bash build-env.sh
#
# CP_OPENROUTER_PROVISIONING_KEY is a *provisioning* key from the platform's
# OpenRouter account (Settings -> Provisioning Keys), not an inference key. It
# mints the per-workspace embedding keys and stays on the control plane; no VM
# ever carries it.
#
# CP_OPERATOR_GITHUB_IDS is your GitHub *numeric* id (curl https://api.github.com/users/<login>
# -> "id"). It is the only thing that makes the first operator; omit it and the
# control plane boots with no one able to administer it.
#
# Writes ./control-plane.env (mode 600). Escrow that file off-machine, then it gets
# copied to the VM at /etc/gbrain-cp/control-plane.env. gbrain-cp-verify-env is the
# contract this output must satisfy; run it against the result before deploying.

set -euo pipefail

OUT="${OUT:-./control-plane.env}"
require() { [ -n "${!1:-}" ] || { echo "missing: $1" >&2; exit 1; }; }
for v in CP_GITHUB_CLIENT_ID CP_GITHUB_CLIENT_SECRET CP_CLOUDFLARE_API_TOKEN \
         CP_CLOUDFLARE_ZONE_ID CP_EMAIL_RESEND_API_KEY CP_EMAIL_FROM \
         CP_OPENROUTER_PROVISIONING_KEY CP_OPERATOR_GITHUB_IDS; do
  require "$v"
done
# Numeric (optionally comma-separated) -- index.ts drops anything else, silently
# leaving the control plane with no operator.
if ! [[ "$CP_OPERATOR_GITHUB_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "CP_OPERATOR_GITHUB_IDS must be your GitHub numeric id(s): got '$CP_OPERATOR_GITHUB_IDS'" >&2
  exit 1
fi

# --- generated machine secrets -------------------------------------------------
# 32 random bytes, base64 -- exactly what parseSealingKey/verify-env demand.
SECRET_KEY="$(openssl rand -base64 32)"
# URL-safe password (hex), so it needs no percent-encoding in the DSN. The db name
# and role must be simple SQL identifiers (verify-env enforces it); the password
# is free-form.
DB_PASSWORD="$(openssl rand -hex 24)"
DB_USER=gbrain_cp
DB_NAME=gbrain_cp

umask 077
cat > "$OUT" <<EOF
# 2Brain control-plane environment (#46). Generated $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Mode 600/640 only. Do not commit. Escrow with the OCI key -- without CP_SECRET_KEY
# a registry backup is unreadable ciphertext.

CP_DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
CP_BASE_URL=https://ws.2brainai.tech
CP_WORKSPACE_DOMAIN=ws.2brainai.tech
CP_SECRET_KEY=${SECRET_KEY}

CP_GITHUB_CLIENT_ID=${CP_GITHUB_CLIENT_ID}
CP_GITHUB_CLIENT_SECRET=${CP_GITHUB_CLIENT_SECRET}

CP_CLOUDFLARE_API_TOKEN=${CP_CLOUDFLARE_API_TOKEN}
CP_CLOUDFLARE_ZONE_ID=${CP_CLOUDFLARE_ZONE_ID}

CP_EMAIL_RESEND_API_KEY=${CP_EMAIL_RESEND_API_KEY}
# Quoted: CP_EMAIL_FROM legitimately contains a space (and <>), and both the
# systemd EnvironmentFile parser and verify-env's shlex.split treat an unquoted
# space as a field separator -> "must be one field" refusal.
CP_EMAIL_FROM="${CP_EMAIL_FROM}"

# Mints one spend-limited embedding key per workspace. Never injected into a VM;
# what a VM gets is a key minted from this one, capped at the limit below.
CP_OPENROUTER_PROVISIONING_KEY=${CP_OPENROUTER_PROVISIONING_KEY}
CP_OPENROUTER_KEY_LIMIT_USD=5

CP_BACKUP_BUCKET=gbrain-cp-backups
CP_BACKUP_NAMESPACE=fr6b8kqenqad

OCI_REGION=eu-frankfurt-1
OCI_TENANCY_OCID=ocid1.tenancy.oc1..aaaaaaaa5klepz7vnjc5gs2bj4wflzmz5me2mzrvp7de4wsbr4te5phigntq
OCI_USER_OCID=ocid1.user.oc1..aaaaaaaauibl35f22v5mihc5gg3cw2vzb5orq5dru23xz2np23n3cjr3a3qa
OCI_KEY_FINGERPRINT=ce:4f:38:c2:f8:78:98:11:8c:a5:80:b8:b4:fd:b2:44
OCI_PRIVATE_KEY_PATH=/etc/gbrain-cp/oci-api-key.pem
OCI_COMPARTMENT_OCID=ocid1.compartment.oc1..aaaaaaaatvoopgtdxx3j2qrttnhkiqvjodbtwslsssxs3ezz5r6kyvnj34ba
OCI_AVAILABILITY_DOMAIN=cyrb:EU-FRANKFURT-1-AD-1
OCI_SUBNET_OCID=ocid1.subnet.oc1.eu-frankfurt-1.aaaaaaaalagqs3rysq3f25ka2igfaf5vpgr3wthsrfwbvnpi3gnaxicx3tkq
# Attached to every workspace VM at launch (compute.ts). OCI unions the subnet
# security list and the NSG, so this NSG is what actually enforces per-workspace
# ingress (80/443 open, SSH only from the control plane). Required: index.ts
# refuses to boot without it, and verify-env refuses an env file that omits it.
OCI_WORKSPACE_NSG_OCID=ocid1.networksecuritygroup.oc1.eu-frankfurt-1.aaaaaaaa27ex4c2wsuwpasnejrysirhwkv7l2dqoxh43oprquc6vb3bwrtcq
OCI_WORKSPACE_IMAGE_OCID=ocid1.image.oc1.eu-frankfurt-1.aaaaaaaauhrh5yvg3kuqbixfzkpyxja254wjhjs5ljuk2hscmxcyfsq24ujq
OCI_INSTANCE_SHAPE=VM.Standard.A2.Flex
OCI_INSTANCE_OCPUS=1
OCI_INSTANCE_MEMORY_GB=4
OCI_INSTANCE_BOOT_VOLUME_GB=50

CP_OPERATOR_GITHUB_IDS=${CP_OPERATOR_GITHUB_IDS}
EOF

echo "wrote $OUT (mode $(stat -c '%a' "$OUT"))"
echo "escrow it now, alongside ~/.oci/gbrain-cp.pem, somewhere off this machine."
