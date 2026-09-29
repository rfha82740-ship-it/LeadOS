#!/usr/bin/env python3
"""فحص حي لأرقام إنتاج LeadOS مباشرة من Neon — بدون طباعة أي أسرار"""
import psycopg2

url = [l.split('=', 1)[1].strip().strip('"').strip("'")
       for l in open('/home/z/my-project/scripts/deploy/.tokens')
       if l.startswith('DATABASE_URL=')][0]

c = psycopg2.connect(url)
cur = c.cursor()

cur.execute("""
SELECT 'leads_total', COUNT(*) FROM "Lead"
UNION ALL SELECT 'leads_24h', COUNT(*) FROM "Lead" WHERE "createdAt" > NOW() - INTERVAL '24 hours'
UNION ALL SELECT 'leads_6h', COUNT(*) FROM "Lead" WHERE "createdAt" > NOW() - INTERVAL '6 hours'
UNION ALL SELECT 'groups', COUNT(*) FROM "MonitoredGroup"
UNION ALL SELECT 'group_posts', COUNT(*) FROM "GroupPost"
UNION ALL SELECT 'sources_total', COUNT(*) FROM "Source"
UNION ALL SELECT 'sources_active', COUNT(*) FROM "Source" WHERE status = 'ACTIVE'
""")
print("== عدّادات عامة ==")
for k, v in cur.fetchall():
    print(f"  {k}: {v}")

print("== ليدز حسب المصدر ==")
cur.execute('SELECT "leadSourceType", COUNT(*) FROM "Lead" GROUP BY 1 ORDER BY 2 DESC')
for k, v in cur.fetchall():
    print(f"  {k}: {v}")

print("== آخر ليد ==")
cur.execute('SELECT MAX("createdAt")::text FROM "Lead"')
print("  ", cur.fetchone()[0])

print("== الجروبات ==")
cur.execute('SELECT status, COUNT(*) FROM "MonitoredGroup" GROUP BY 1')
for k, v in cur.fetchall():
    print(f"  {k}: {v}")

c.close()
