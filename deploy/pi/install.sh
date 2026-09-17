#!/usr/bin/env bash
# Install/update the router as a systemd service on RP5#2. Run from the repo root as the login user:
#   scripts/... (build first)  →  sudo deploy/pi/install.sh [--no-build]
# Copies the release binary + web console build to /opt/biomonitor-router, the env file to /etc (kept if it
# exists), the sysctl drop-in, and (re)starts the service. Data lives in /var/lib/biomonitor-router.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
USER_NAME=${SUDO_USER:-master}
if [ "${1:-}" != "--no-build" ]; then
  echo "== build (as $USER_NAME)"
  sudo -u "$USER_NAME" bash -c "export PATH=\$HOME/.cargo/bin:\$PATH; cd '$ROOT/router-server' && cargo build --release"
  sudo -u "$USER_NAME" bash -c "cd '$ROOT/web/console' && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null"
fi
echo "== install"
install -d -o "$USER_NAME" -g "$USER_NAME" /opt/biomonitor-router /var/lib/biomonitor-router/store
install -m 755 "$ROOT/router-server/target/release/router-server" /opt/biomonitor-router/router-server
rm -rf /opt/biomonitor-router/web && cp -r "$ROOT/web/console/dist" /opt/biomonitor-router/web
for f in groups.json displays.json; do [ -e /var/lib/biomonitor-router/$f ] || install -o "$USER_NAME" -m 644 "$ROOT/router-server/$f" /var/lib/biomonitor-router/$f; done
[ -e /etc/biomonitor-router.env ] || install -m 644 "$ROOT/deploy/pi/biomonitor-router.env" /etc/biomonitor-router.env
sed -i "s/^User=.*/User=$USER_NAME/" "$ROOT/deploy/pi/biomonitor-router.service"
install -m 644 "$ROOT/deploy/pi/biomonitor-router.service" /etc/systemd/system/biomonitor-router.service
install -m 644 "$ROOT/deploy/pi/99-biomonitor-router.conf" /etc/sysctl.d/99-biomonitor-router.conf
sysctl --system >/dev/null
systemctl daemon-reload
systemctl enable biomonitor-router >/dev/null
systemctl restart biomonitor-router
sleep 2
systemctl --no-pager --lines=5 status biomonitor-router || true
echo "console: http://$(hostname -I | awk '{print $1}'):7300/"
