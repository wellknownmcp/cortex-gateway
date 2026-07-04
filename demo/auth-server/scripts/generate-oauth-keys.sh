#!/usr/bin/env bash
# Generates the RSA 2048 signing keypair for the demo authorization server.
# Output is ready to paste into .env (PEM with \n escapes on one line).
# NEVER commit the private key.
set -euo pipefail

PRIV=$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)
PUB=$(printf '%s\n' "$PRIV" | openssl pkey -pubout 2>/dev/null)

esc() { printf '%s' "$1" | awk 'BEGIN{ORS="\\n"} {print}'; }

echo "OAUTH_KEY_ID=cortex-demo-auth-$(date +%Y-%m)"
echo "OAUTH_SIGNING_PRIVATE_KEY=\"$(esc "$PRIV")\""
echo "OAUTH_SIGNING_PUBLIC_KEY=\"$(esc "$PUB")\""
