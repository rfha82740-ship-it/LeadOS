#!/bin/bash
# LeadOS — لوب مسح جروبات فيسبوك المحلي (IP سكني = آمن للحساب)
# كل 20 دقيقة: 5 جروبات مستحقة + تحويل تلقائي للمؤهل → عملاء
# الكولداون الداخلي 15 دقيقة/جروب محترم في scanDueGroups
cd /home/z/my-project || exit 1
mkdir -p db/backups
while true; do
  echo "════ $(date '+%m-%d %H:%M') دورة جروبات ════" >> db/backups/fb-groups.log
  timeout 500 npx tsx scripts/fb-scan-local.ts 5 >> db/backups/fb-groups.log 2>&1
  echo "$(date '+%m-%d %H:%M') انتهت الدورة" >> db/backups/fb-groups.log
  sleep 1200
done
