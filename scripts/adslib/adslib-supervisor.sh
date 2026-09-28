#!/bin/bash
# LeadOS — Ads Library supervisor: respawns the hunter loop if it ever dies.
# Runs: python scraper every 2h (rotating query batches), guarded by flock.
cd /home/z/my-project || exit 1
mkdir -p db/backups
LOG=db/backups/adslib.log
BATCHES=(
  "عقارات,apartments for sale,سيارات"
  "مطعم,عيادة,تنظيف"
  "كورس,متجر اونلاين,تخسيس"
  "furniture,clinic,restaurant cairo"
)
i=0
exec 9>/tmp/leados-adslib.lock
while true; do
  if flock -n 9; then
    Q="${BATCHES[$((i % ${#BATCHES[@]}))]}"
    i=$((i + 1))
    echo "$(date '+%m-%d %H:%M') adslib run#$i (queries: $Q)" >> "$LOG"
    LEADOS_BASE_URL="https://leados-v2.vercel.app" \
    LEADOS_API_KEY="$(grep '^INGEST_API_KEY=' scripts/deploy/.tokens | cut -d= -f2- | tr -d '\"')" \
    QUERIES="$Q" MAX_QUERIES=3 COUNTRY=EG \
      timeout 1500 python3 -u scripts/adslib/scraper.py >> "$LOG" 2>&1
    echo "$(date '+%m-%d %H:%M') adslib run#$i exit=$?" >> "$LOG"
    sleep 7200
  else
    echo "$(date '+%m-%d %H:%M') another run holds the lock — waiting" >> "$LOG"
    sleep 300
  fi
done
