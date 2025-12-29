#!/usr/bin/env bash
set -euo pipefail
shopt -s expand_aliases

# Constants
OP_SECRET_ID="el6e5q2vujlpu37glz4xhl6mkm"

# Parse arguments
DRY_RUN=0
FORCE=0
OP_CMD_OVERRIDE=""
name_parts=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dry-run)
      DRY_RUN=1
      shift
      ;;
    -f|--force)
      FORCE=1
      shift
      ;;
    --op)
      if [[ -z "${2-}" ]]; then
        echo "Missing argument for --op" >&2
        exit 1
      fi
      OP_CMD_OVERRIDE="$2"
      shift 2
      ;;
    --op=*)
      OP_CMD_OVERRIDE="${1#--op=}"
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [-d|--dry-run] [-f|--force] [--op <op|op.exe|path>] <friendly device name>" >&2
      exit 0
      ;;
    --*)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
    *)
      name_parts+=("$1")
      shift
      ;;
  esac
done

# Parse and validate name
if [[ ${#name_parts[@]} -eq 0 ]]; then
  echo "Usage: $0 [--dry-run] [-f|--force] [--op <op|op.exe|path>] <friendly device name>" >&2
  exit 1
fi
friendly_name="$(echo "${name_parts[*]}" | sed -e 's/^ *//' -e 's/ *$//')"
if [[ -z "${friendly_name}" ]]; then
  echo "Friendly name cannot be empty" >&2
  exit 1
fi
if [[ ! "${friendly_name}" =~ ^[A-Za-z][A-Za-z0-9\ ]*$ ]]; then
  echo "Friendly name must start with a letter and contain only letters, numbers, and spaces" >&2
  exit 1
fi

# Parse and validate slug
slug="$(echo "${friendly_name}" | tr '[:upper:]' '[:lower:]' | sed -e 's/^ *//' -e 's/ *$//' -e 's/ \+/-/g')"
if [[ ! "${slug}" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "Derived device key '${slug}' is not valid" >&2
  exit 1
fi

# Resolve and validate 1Password CLI dependency
OP_CMD=""
if [[ -n "${OP_CMD_OVERRIDE}" ]]; then
  OP_CMD="${OP_CMD_OVERRIDE}"
elif type op >/dev/null 2>&1; then
  OP_CMD="op"
elif type op.exe >/dev/null 2>&1; then
  OP_CMD="op.exe"
fi
if [[ -z "${OP_CMD}" ]]; then
  echo "Could not find 1Password CLI (op or op.exe) in PATH." >&2
  exit 1
fi
if ! type "${OP_CMD}" >/dev/null 2>&1; then
  echo "Resolved 1Password CLI '${OP_CMD}' not found" >&2
  exit 1
fi

# Validate openssl dependency
if ! command -v openssl >/dev/null 2>&1; then
  echo "Required command 'openssl' not found in PATH" >&2
  exit 1
fi

# Calculate paths.
PROJECT_ROOT="$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")"
CONFIG_DIR="${PROJECT_ROOT}/config"
TEMPLATE_PATH="${PROJECT_ROOT}/secrets.template.yaml"

# Validate paths
if [[ ! -f "${TEMPLATE_PATH}" ]]; then
  echo "Template file not found: ${TEMPLATE_PATH}" >&2
  exit 1
fi
if [[ ! -d "${CONFIG_DIR}" ]]; then
  echo "Config directory not found: ${CONFIG_DIR}" >&2
  exit 1
fi

# Derive keys and references.
yaml_key_encryption="${slug}_encryption_key"
yaml_key_ota="${slug}_ota_password"
op_ref_encryption="op://${OP_SECRET_ID}/${friendly_name}/encryption key"
op_ref_ota="op://${OP_SECRET_ID}/${friendly_name}/ota password"
device_config="${CONFIG_DIR}/${slug}.yaml"

# Prevent overwriting data in files
echo "Checking files..."
if grep -Eq "^${yaml_key_encryption}:" "${TEMPLATE_PATH}" || grep -Eq "^${yaml_key_ota}:" "${TEMPLATE_PATH}"; then
  echo "Secrets for '${slug}' already exist in ${TEMPLATE_PATH}; aborting." >&2
  exit 1
fi
if [[ -e "${device_config}" ]]; then
  echo "Device config already exists: ${device_config}; aborting." >&2
  exit 1
fi


# Prevent overwriting data in 1Password
echo "Checking 1Password..."
if ! "${OP_CMD}" account get >/dev/null 2>&1; then
  echo "1Password CLI is locked or not authenticated; please sign in/unlock and try again." >&2
  exit 1
fi
if "${OP_CMD}" item get "${OP_SECRET_ID}" --field "${friendly_name}.encryption key" >/dev/null 2>&1 || \
  "${OP_CMD}" item get "${OP_SECRET_ID}" --field "${friendly_name}.ota password" >/dev/null 2>&1; then
  echo "Secrets for '${friendly_name}' already exist in 1Password; aborting." >&2
  exit 1
fi

# Generate content for secrets template
echo "Generating content..."
template_block=$(cat <<EOF
# ${friendly_name}
${yaml_key_encryption}: "${op_ref_encryption}"
${yaml_key_ota}: "${op_ref_ota}"
EOF
)

# Generate content for the device file
device_block=$(cat <<EOF
substitutions:
  name: ${slug}
  encryption_key: !secret ${yaml_key_encryption}
  ota_password: !secret ${yaml_key_ota}

packages: []
EOF
)

# Generate secrets
encryption_key="$(openssl rand -base64 32)"
ota_password="$(openssl rand -hex 16)"

echo "Ready."
echo ""

# Show plan and optionally confirm
echo "+++ secrets.template.yaml"
echo "${template_block}"
echo ""
echo "+++ config/${slug}.yaml"
echo "${device_block}"
echo ""
echo "+++ 1Password Secrets"
echo "- ${op_ref_encryption}"
echo "- ${op_ref_ota}"
echo ""

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "Dry run: no changes will be applied."
elif [[ "${FORCE}" -ne 1 ]]; then
  read -r -p "Create device and secrets? [y/N] " confirm
  case "${confirm}" in
    [Yy][Ee][Ss]|[Yy]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi
echo ""

# Apply the changes
if [[ "${DRY_RUN}" -eq 0 ]]; then
  "${OP_CMD}" item edit "${OP_SECRET_ID}" \
    "${friendly_name}.encryption key=${encryption_key}" \
    "${friendly_name}.ota password=${ota_password}"
  echo -e "\n${template_block}" >> "${TEMPLATE_PATH}"
  cat >"${device_config}" <<< "${device_block}"
fi

# Emit a summary of all changes.
if [[ "${DRY_RUN}" -eq 1 ]]; then
  result_label="Dry Run Complete"
  encryption_key_emit="${encryption_key}"
  ota_password_emit="${ota_password}"
else
  result_label="Creation Complete"
  encryption_key_emit="[hidden]"
  ota_password_emit="[hidden]"
fi
cat <<EOF
=== ${result_label} ===
Generated device '${friendly_name}' (${slug}):
- Device config: ./config/${slug}.yaml
- Encryption Key:
  - Secret ID: ${yaml_key_encryption}
  - Reference: "${op_ref_encryption}"
  - Generated: ${encryption_key_emit}
- OTA Password:
  - Secret ID: ${yaml_key_ota}
  - Reference: "${op_ref_ota}"
  - Generated: ${ota_password_emit}
EOF
