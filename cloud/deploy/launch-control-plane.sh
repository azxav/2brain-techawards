#!/usr/bin/env bash
# Launch the pilot control-plane VM with the repository-owned ARM64 defaults.
# Re-running the command adopts the first non-terminated instance with the same
# display name. Capacity values may be overridden explicitly for an experiment.
set -euo pipefail

SHAPE="${OCI_CONTROL_PLANE_SHAPE:-VM.Standard.A2.Flex}"
OCPUS="${OCI_CONTROL_PLANE_OCPUS:-1}"
MEMORY_GB="${OCI_CONTROL_PLANE_MEMORY_GB:-4}"
BOOT_VOLUME_GB="${OCI_CONTROL_PLANE_BOOT_VOLUME_GB:-50}"
DISPLAY_NAME="${OCI_CONTROL_PLANE_DISPLAY_NAME:-2brain-control-plane}"
PROFILE="${OCI_PROFILE:-DEFAULT}"

require() { [[ -n "${!1:-}" ]] || { echo "missing: $1" >&2; exit 2; }; }
for name in OCI_REGION OCI_COMPARTMENT_OCID OCI_AVAILABILITY_DOMAIN OCI_SUBNET_OCID \
  OCI_CONTROL_PLANE_NSG_OCID OCI_CONTROL_PLANE_IMAGE_OCID \
  OCI_CONTROL_PLANE_PUBLIC_IP_OCID OCI_SSH_PUBLIC_KEY_FILE; do
  require "$name"
done
command -v oci >/dev/null 2>&1 || { echo "missing required command: oci" >&2; exit 2; }
[[ -f "$OCI_SSH_PUBLIC_KEY_FILE" ]] || { echo "SSH public key not found: $OCI_SSH_PUBLIC_KEY_FILE" >&2; exit 2; }
for value in "$OCPUS" "$MEMORY_GB" "$BOOT_VOLUME_GB"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "capacity values must be positive whole numbers" >&2; exit 2; }
done

image_name="$(oci compute image get --profile "$PROFILE" --region "$OCI_REGION" \
  --image-id "$OCI_CONTROL_PLANE_IMAGE_OCID" --query 'data."display-name"' --raw-output)"
if [[ ! "$image_name" =~ [Aa][Aa][Rr][Cc][Hh]64 ]]; then
  echo "control-plane image must be aarch64, got: $image_name" >&2
  exit 2
fi

existing="$(oci compute instance list --profile "$PROFILE" --region "$OCI_REGION" \
  --compartment-id "$OCI_COMPARTMENT_OCID" --display-name "$DISPLAY_NAME" \
  --query 'data[?"lifecycle-state" != `TERMINATED`].id | [0]' --raw-output)"
if [[ -n "$existing" && "$existing" != "null" && "$existing" != "None" ]]; then
  echo "control-plane instance already exists: $existing"
  instance_id="$existing"
else
  instance_id="$(oci compute instance launch --profile "$PROFILE" --region "$OCI_REGION" \
    --availability-domain "$OCI_AVAILABILITY_DOMAIN" \
    --compartment-id "$OCI_COMPARTMENT_OCID" \
    --subnet-id "$OCI_SUBNET_OCID" \
    --nsg-ids "[\"$OCI_CONTROL_PLANE_NSG_OCID\"]" \
    --image-id "$OCI_CONTROL_PLANE_IMAGE_OCID" \
    --display-name "$DISPLAY_NAME" \
    --shape "$SHAPE" \
    --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY_GB}" \
    --boot-volume-size-in-gbs "$BOOT_VOLUME_GB" \
    --ssh-authorized-keys-file "$OCI_SSH_PUBLIC_KEY_FILE" \
    --assign-public-ip false \
    --wait-for-state RUNNING \
    --query 'data.id' --raw-output)"
fi

vnic_id="$(oci compute vnic-attachment list --profile "$PROFILE" --region "$OCI_REGION" \
  --compartment-id "$OCI_COMPARTMENT_OCID" --instance-id "$instance_id" \
  --query 'data[0]."vnic-id"' --raw-output)"
private_ip_id="$(oci network private-ip list --profile "$PROFILE" --region "$OCI_REGION" \
  --vnic-id "$vnic_id" --query 'data[0].id' --raw-output)"
oci network public-ip update --profile "$PROFILE" --region "$OCI_REGION" \
  --public-ip-id "$OCI_CONTROL_PLANE_PUBLIC_IP_OCID" \
  --private-ip-id "$private_ip_id" --wait-for-state ASSIGNED >/dev/null

echo "control-plane instance ready: $instance_id"
