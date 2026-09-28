#!/bin/bash
# LeadOS — production heartbeat: pings the Vercel orchestrator every 10 minutes
# (the GitHub cron-tick is blocked at the account level — startup_failure since day 1;
#  this local loop is the real 15-min cadence until the GitHub account is unblocked)
cd /home/z/my-project || exit 1
mkdir -p db/backups
SECRET=$(grep '^CRON_SECRET_ALT=' scripts/deploy/.tokens | cut -d= -f2- | tr -d '"')
BASE="https://leados-v2.vercel.app"
while true; do
  code=$(curl -s -o /tmp/tick-prod.json -w "%{http_code}" --max-time 110 \
    -X POST "${BASE}/api/cron/tick?max=3&secret=${SECRET}")
  echo "$(date '+%m-%d %H:%M') tick -> $code $(head -c 120 /tmp/tick-prod.json 2>/dev/null)" >> db/backups/tick-prod.log
  sleep 600
done
