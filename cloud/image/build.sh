#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/workspace.pkr.hcl"
ARTIFACT_DIR="${GBRAIN_IMAGE_ARTIFACT_DIR:-$SCRIPT_DIR/.artifacts}"

usage() {
  cat <<'EOF'
Build the 2Brain Workspace Oracle Cloud Infrastructure custom image.

Usage:
  cloud/image/build.sh
  cloud/image/build.sh --check

Required environment for a real build:
  OCI_REGION
  OCI_AVAILABILITY_DOMAIN
  OCI_COMPARTMENT_OCID
  OCI_SUBNET_OCID
  OCI_BASE_IMAGE_OCID

`smoke-preflight.ts --discover` prints OCI_BASE_IMAGE_OCID and OCI_PACKER_SHAPE
alongside the rest, read-only.

Optional:
  OCI_PACKER_SHAPE         default: VM.Standard.A2.Flex
  OCI_CONFIG_FILE          default: ~/.oci/config
  OCI_PROFILE              default: DEFAULT
  OCI_PACKER_OCPUS         default: 1
  OCI_PACKER_MEMORY_GB     default: 8
  OCI_SSH_USERNAME         default: ubuntu
  GBRAIN_IMAGE_NAME        default: 2brain-workspace-<git-sha>-<UTC timestamp>
  GBRAIN_IMAGE_ARTIFACT_DIR
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  --check)
    bun run "$SCRIPT_DIR/verify-contract.ts" --json
    if command -v packer >/dev/null 2>&1; then
      packer init "$TEMPLATE"
      packer fmt -check "$TEMPLATE"
      packer validate -syntax-only "$TEMPLATE"
    else
      echo "[image] packer is not installed; skipped HCL plugin/syntax validation" >&2
    fi
    exit 0
    ;;
  '') ;;
  *)
    usage >&2
    exit 2
    ;;
esac

for command_name in bun git packer; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 2
  fi
done

dirty_paths="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)"
if [[ -n "$dirty_paths" ]]; then
  echo "Refusing to build from a dirty worktree. Commit or stash every image input first:" >&2
  printf '%s\n' "$dirty_paths" >&2
  exit 2
fi

required_env=(
  OCI_REGION
  OCI_AVAILABILITY_DOMAIN
  OCI_COMPARTMENT_OCID
  OCI_SUBNET_OCID
  OCI_BASE_IMAGE_OCID
)
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 2
  fi
done

bun run "$SCRIPT_DIR/verify-contract.ts"
packer init "$TEMPLATE"
packer fmt -check "$TEMPLATE"

mkdir -p "$ARTIFACT_DIR"
git_sha="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"
short_sha="${git_sha:0:12}"
timestamp="$(date -u +%Y%m%d%H%M%S)"
image_name="${GBRAIN_IMAGE_NAME:-2brain-workspace-${short_sha}-${timestamp}}"
source_archive="$ARTIFACT_DIR/gbrain-${short_sha}.tar.gz"
bundle_archive="$ARTIFACT_DIR/workspace-image-bundle-${short_sha}.tar.gz"
manifest_path="$ARTIFACT_DIR/packer-manifest.json"

git -C "$REPO_ROOT" archive --format=tar.gz --output="$source_archive" HEAD
git -C "$REPO_ROOT" archive \
  --format=tar.gz \
  --output="$bundle_archive" \
  HEAD:cloud/image \
  files openclaw scripts/provision.sh

common_vars=(
  -var "region=$OCI_REGION"
  -var "availability_domain=$OCI_AVAILABILITY_DOMAIN"
  -var "compartment_ocid=$OCI_COMPARTMENT_OCID"
  -var "subnet_ocid=$OCI_SUBNET_OCID"
  -var "base_image_ocid=$OCI_BASE_IMAGE_OCID"
  -var "oci_config_file=${OCI_CONFIG_FILE:-$HOME/.oci/config}"
  -var "oci_profile=${OCI_PROFILE:-DEFAULT}"
  -var "shape=${OCI_PACKER_SHAPE:-VM.Standard.A2.Flex}"
  -var "ocpus=${OCI_PACKER_OCPUS:-1}"
  -var "memory_in_gbs=${OCI_PACKER_MEMORY_GB:-8}"
  -var "ssh_username=${OCI_SSH_USERNAME:-ubuntu}"
  -var "image_name=$image_name"
  -var "gbrain_git_sha=$git_sha"
  -var "source_archive=$source_archive"
  -var "image_bundle_archive=$bundle_archive"
  -var "manifest_path=$manifest_path"
)

packer validate "${common_vars[@]}" "$TEMPLATE"
packer build "${common_vars[@]}" "$TEMPLATE"

echo "[image] build complete: $image_name"
echo "[image] manifest: $manifest_path"
