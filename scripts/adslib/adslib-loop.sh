#!/bin/bash
# LeadOS — Ads Library competitor-ad hunter: runs the scraper every 2 hours.
# Facebook Ads Library (EG) — anonymous real Chromium — advertisers -> AD_SPENDER leads.
# (GitHub Actions copy lives in .github/workflows/ads-library.yml — activates when
#  the GitHub account blocker is lifted; this local loop runs meanwhile.)
cd /home/z/my-project || exit 1
mkdir -p db/backups
export LEADOS_BASE_URL="https://leados-v2.vercel.app"
export LEADOS_API_KEY=$(grep '^INGEST_API_KEY=' scripts/deploy/.tokens | cut -d= -f2- | tr -d '"')
# rotate query batches across runs so coverage stays wide
BATCHES=(
  "عقارات,apartments for sale,سيارات"
  "مطعم,عيادة,تنظيف"
  "كورس,متجر اونلاين,تخسيس"
  "furniture,clinic,restaurant cairo"
)
i=0
while true; do
  Q="${BATCHES[$((i % ${#BATCHES[@]}))]}"
  i=$((i + 1))
  echo "$(date '+%m-%d %H:%M') adslib run (queries: $Q)" >> db/backups/adslib.log
  LEADOS_BASE_URL="$LEADOS_BASE_URL" LEADOS_API_KEY="$LEADOS_API_KEY" \
    QUERIES="$Q" MAX_QUERIES=3 COUNTRY=EG \
    timeout 900 python3 -u scripts/adslib/scraper.py >> db/backups/adslib.log 2>&1
  sleep 7200
done
