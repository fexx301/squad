#!/bin/bash
# Ship a change (run on the server, e.g. via SSM): fast-forward to origin/main, test, restart, show status.
# If the tests fail the pull is rolled back, so untested code never sits on disk for the next restart to load.
set -euo pipefail
cd /opt/squad/app
sudo -u squad git pull --ff-only
if ! sudo -u squad /usr/local/bin/node --test > /tmp/squad-test.log 2>&1; then
  sudo -u squad git reset --hard ORIG_HEAD
  echo "tests failed; rolled back to $(sudo -u squad git log --oneline -1)"; tail -20 /tmp/squad-test.log; exit 1
fi
grep -E '^ℹ (pass|fail)' /tmp/squad-test.log
systemctl restart squad
sleep 6
systemctl is-active squad
sudo -u squad git log --oneline -1
journalctl -u squad --no-pager -n 4
