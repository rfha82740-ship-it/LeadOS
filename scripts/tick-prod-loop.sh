#!/bin/bash
# LeadOS — production heartbeat: pings the Vercel orchestrator every 10 minutes
# + يفرّغ workflows الحساب الجديد بمناوبة (لأن GitHub schedules مش بتنزل عليه):
#   worker كل ساعة | ads-library كل ساعتين | browser-farm (15 وركر) كل 4 ساعات
cd /home/z/my-project || exit 1
mkdir -p db/backups
SECRET=$(grep '^CRON_SECRET_ALT=' scripts/deploy/.tokens | cut -d= -f2- | tr -d '"')
BASE="https://leados-v2.vercel.app"
GHTOKEN=$(git config --get remote.origin.url | sed -n 's|https://[^:]*:\([^@]*\)@.*|\1|p')
TICKS=0
dispatch() {
  [ -n "$GHTOKEN" ] || return 0
  code=$(curl -s -o /tmp/gh-dispatch.json -w "%{http_code}" --max-time 30 \
    -X POST -H "Authorization: Bearer $GHTOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/rfha82740-ship-it/LeadOS/actions/workflows/$1/dispatches" \
    -d '{"ref":"main"}')
  echo "$(date '+%m-%d %H:%M') dispatch $1 -> $code" >> db/backups/dispatch.log
}
while true; do
  code=$(curl -s -o /tmp/tick-prod.json -w "%{http_code}" --max-time 110 \
    -X POST "${BASE}/api/cron/tick?max=4&secret=${SECRET}")
  echo "$(date '+%m-%d %H:%M') tick -> $code $(head -c 120 /tmp/tick-prod.json 2>/dev/null)" >> db/backups/tick-prod.log
  TICKS=$((TICKS + 1))
  if [ $((TICKS % 6)) -eq 0 ];  then dispatch "worker.yml"; fi
  if [ $((TICKS % 12)) -eq 0 ]; then dispatch "ads-library.yml"; fi
  if [ $((TICKS % 24)) -eq 0 ]; then dispatch "browser-farm.yml"; fi
  sleep 600
done
