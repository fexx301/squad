#!/bin/bash
# Run on the server (via SSM) once DOMAIN resolves to it: HTTPS via Caddy, public connect links, start services.
set -euo pipefail
DOMAIN="$1"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ ]] || { echo "bad domain"; exit 1; }
printf '%s {\n\treverse_proxy 127.0.0.1:8787\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
ENV=/opt/squad/app/.env
grep -q '^PUBLIC_URL=' $ENV && sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" $ENV || echo "PUBLIC_URL=https://$DOMAIN" >> $ENV
systemctl enable --now caddy squad
systemctl restart squad
