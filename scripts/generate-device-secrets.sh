#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <device-name>" >&2
  exit 1
fi

device="$1"
encryption_key="$(openssl rand -base64 32)"
ota_password="$(openssl rand -hex 16)"

cat <<EOF
${device}_encryption_key: "${encryption_key}"
${device}_ota_password: "${ota_password}"
EOF
