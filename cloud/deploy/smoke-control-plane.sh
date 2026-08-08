#!/usr/bin/env bash
# Live pilot smoke: prove the deployed control plane is on the selected OCI
# capacity, then prove its public HTTPS health endpoint answers.
set -euo pipefail

EXPECTED_SHAPE="${OCI_CONTROL_PLANE_SHAPE:-VM.Standard.A2.Flex}"
EXPECTED_OCPUS="${OCI_CONTROL_PLANE_OCPUS:-1}"
EXPECTED_MEMORY_GB="${OCI_CONTROL_PLANE_MEMORY_GB:-4}"
EXPECTED_BOOT_VOLUME_GB="${OCI_CONTROL_PLANE_BOOT_VOLUME_GB:-50}"
PROFILE="${OCI_PROFILE:-DEFAULT}"

require() { [[ -n "${!1:-}" ]] || { echo "missing: $1" >&2; exit 2; }; }
for name in CP_BASE_URL OCI_REGION OCI_COMPARTMENT_OCID OCI_AVAILABILITY_DOMAIN \
  OCI_CONTROL_PLANE_INSTANCE_OCID; do
  require "$name"
done
command -v oci >/dev/null 2>&1 || { echo "missing required command: oci" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "missing required command: curl" >&2; exit 2; }

instance_json="$(oci compute instance get --profile "$PROFILE" --region "$OCI_REGION" \
  --instance-id "$OCI_CONTROL_PLANE_INSTANCE_OCID")"
shape="$(printf '%s' "$instance_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["shape"])')"
ocpus="$(printf '%s' "$instance_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["shape-config"]["ocpus"])')"
memory="$(printf '%s' "$instance_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["shape-config"]["memory-in-gbs"])')"

[[ "$shape" == "$EXPECTED_SHAPE" ]] || { echo "shape mismatch: expected $EXPECTED_SHAPE, got $shape" >&2; exit 1; }
[[ "$ocpus" == "$EXPECTED_OCPUS" || "$ocpus" == "$EXPECTED_OCPUS.0" ]] || { echo "OCPU mismatch: expected $EXPECTED_OCPUS, got $ocpus" >&2; exit 1; }
[[ "$memory" == "$EXPECTED_MEMORY_GB" || "$memory" == "$EXPECTED_MEMORY_GB.0" ]] || { echo "memory mismatch: expected $EXPECTED_MEMORY_GB GB, got $memory" >&2; exit 1; }

boot_volume_id="$(oci compute boot-volume-attachment list --profile "$PROFILE" --region "$OCI_REGION" \
  --availability-domain "$OCI_AVAILABILITY_DOMAIN" --compartment-id "$OCI_COMPARTMENT_OCID" \
  --instance-id "$OCI_CONTROL_PLANE_INSTANCE_OCID" --query 'data[0]."boot-volume-id"' --raw-output)"
boot_volume_size="$(oci bv boot-volume get --profile "$PROFILE" --region "$OCI_REGION" \
  --boot-volume-id "$boot_volume_id" --query 'data."size-in-gbs"' --raw-output)"
[[ "$boot_volume_size" == "$EXPECTED_BOOT_VOLUME_GB" ]] || { echo "boot volume mismatch: expected $EXPECTED_BOOT_VOLUME_GB GB, got $boot_volume_size" >&2; exit 1; }

curl --fail --silent --show-error --max-time 15 "${CP_BASE_URL%/}/healthz" >/dev/null
echo "control-plane smoke: A2 capacity and HTTPS health OK"
