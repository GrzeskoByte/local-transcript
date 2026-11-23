#!/usr/bin/env bash
set -euo pipefail

public_url="${LT_PUBLIC_URL%/}"
mkdir -p /opt/keycloak/data/import
while IFS= read -r line; do
  printf '%s\n' "${line//__LT_PUBLIC_URL__/$public_url}"
done < /opt/keycloak/demo/local-transcribe-realm.json > /opt/keycloak/data/import/local-transcribe-realm.json

exec /opt/keycloak/bin/kc.sh "$@"
