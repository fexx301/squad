#!/bin/bash
# EC2 bootstrap (Amazon Linux 2023, arm64): Node 24 + Caddy (checksum-verified), app from GitHub,
# secrets from SSM Parameter Store. Services start later via deploy/activate.sh once DNS points here.
set -euxo pipefail
NODE_V=v24.14.0; CADDY_V=2.11.7; REGION=us-east-1
cd /tmp
curl -fsSLO --retry 6 --retry-all-errors --retry-delay 5 https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-arm64.tar.xz
curl -fsSL --retry 6 --retry-all-errors --retry-delay 5 https://nodejs.org/dist/$NODE_V/SHASUMS256.txt | grep " node-$NODE_V-linux-arm64.tar.xz\$" | sha256sum -c -
tar -xJf node-$NODE_V-linux-arm64.tar.xz -C /usr/local --strip-components=1
curl -fsSLO --retry 6 --retry-all-errors --retry-delay 5 https://github.com/caddyserver/caddy/releases/download/v$CADDY_V/caddy_${CADDY_V}_linux_arm64.tar.gz
curl -fsSL --retry 6 --retry-all-errors --retry-delay 5 https://github.com/caddyserver/caddy/releases/download/v$CADDY_V/caddy_${CADDY_V}_checksums.txt | grep " caddy_${CADDY_V}_linux_arm64.tar.gz\$" | sha512sum -c -
tar -xzf caddy_${CADDY_V}_linux_arm64.tar.gz -C /usr/local/bin caddy
dnf install -y git || (sleep 15 && dnf install -y git)
useradd --system --create-home --home-dir /opt/squad squad
useradd --system --create-home --home-dir /var/lib/caddy caddy
git clone https://github.com/fexx301/squad.git /opt/squad/app
mkdir -p /opt/squad/app/data /etc/caddy
aws ssm get-parameter --region $REGION --name /squad/env --with-decryption --query Parameter.Value --output text > /opt/squad/app/.env
aws ssm get-parameter --region $REGION --name /squad/db --with-decryption --query Parameter.Value --output text > /opt/squad/app/data/db.json
chown -R squad:squad /opt/squad && chmod 600 /opt/squad/app/.env /opt/squad/app/data/db.json
cat > /etc/systemd/system/squad.service <<'UNIT'
[Unit]
Description=Squad: Telegram bot, wallet connect page, testnet Maker
After=network-online.target
Wants=network-online.target
[Service]
User=squad
UMask=0077
WorkingDirectory=/opt/squad/app
ExecStart=/usr/local/bin/node src/main.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy (HTTPS for the connect page)
After=network-online.target
Wants=network-online.target
[Service]
User=caddy
Environment=HOME=/var/lib/caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
touch /opt/squad/READY
