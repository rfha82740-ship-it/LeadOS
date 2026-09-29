#!/bin/bash
# مراقب السلاسل الدائمة — يسجل آخر تشغيلة لكل workflow كل 10 دقايق
# لما event يبقى repository_dispatch = السلسلة بتحرك نفسها بنجاح (مش محتاجة حد من بره)
cd /home/z/my-project || exit 1
mkdir -p db/backups
GHTOKEN=$(git config --get remote.origin.url | sed -n 's|https://[^:]*:\([^@]*\)@.*|\1|p')
while true; do
  for w in cron-tick browser-farm worker ads-library; do
    last=$(curl -s -m 20 -H "Authorization: Bearer $GHTOKEN" \
      "https://api.github.com/repos/bdalhlymzaldyn7-ui/LeadOS/actions/workflows/$w.yml/runs?per_page=1" \
      | python3 -c "import json,sys
try:
    r=json.load(sys.stdin).get('workflow_runs',[{}])[0]
    print(f\"{r.get('event','?')} {r.get('status','?')} {str(r.get('created_at','?'))[:16]}\")
except Exception as e:
    print('parse-err')" 2>/dev/null)
    echo "$(date '+%m-%d %H:%M') $w -> $last" >> db/backups/chain-watch.log
  done
  sleep 600
done
