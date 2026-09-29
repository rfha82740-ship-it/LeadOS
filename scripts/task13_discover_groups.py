#!/usr/bin/env python3
"""Task 13 — اكتشاف جروبات فيسبوك مصرية جديدة للأعمال + حقنها في MonitoredGroup
من غير لوجن: بحث DDG على facebook.com/groups — تُحفظ بحالة NEW (تتفحص أول ما الكوكيز تتجدد)."""
import re
import sys
import time

import requests

sys.path.insert(0, "/home/z/my-project")
from dbq import resolve  # noqa: E402

import psycopg  # noqa: E402

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

QUERIES = [
    "site:facebook.com/groups جروب اعلانات بيزنس مصر",
    "site:facebook.com/groups فرص عمل مصر",
    "site:facebook.com/groups رواد اعمال مصر",
    "site:facebook.com/groups كليينج مصر",
    "site:facebook.com/groups مطاعم وكافيهات مصر",
    "site:facebook.com/groups التجاره والاستيراد مصر",
    "site:facebook.com/groups مبرمجين مصر",
    "site:facebook.com/groups تسويق الكتروني مصر",
    "site:facebook.com/groups شقق للتأثيث مصر",
    "site:facebook.com/groups عقارات القاهرة الجديدة",
]


def ddg_groups(query: str) -> list:
    try:
        r = requests.post("https://html.duckduckgo.com/html/", data={"q": query},
                          headers={"User-Agent": UA}, timeout=25)
        found = []
        for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', r.text, re.S):
            href, title = m.group(1), re.sub(r"<[^>]+>", "", m.group(2)).strip()
            if "uddg=" in href:
                u = re.search(r"uddg=([^&]+)", href)
                if u:
                    from urllib.parse import unquote
                    href = unquote(u.group(1))
            g = re.search(r"facebook\.com/(?:groups)/([A-Za-z0-9._\-]+)/?", href)
            if g and title:
                found.append((g.group(1), title))
        return found
    except Exception as e:
        print(f"  ddg err: {e}")
        return []


def main() -> None:
    all_groups: dict = {}
    for q in QUERIES:
        for gid, title in ddg_groups(q):
            all_groups.setdefault(gid, title)
        time.sleep(2)
    print(f"مجموع جروبات مكتشفة: {len(all_groups)}")

    url_db = resolve("NEON_LEADOS")
    ws = None
    with psycopg.connect(url_db) as conn:
        ws = conn.execute('SELECT id FROM "Workspace" ORDER BY "createdAt" ASC LIMIT 1').fetchone()
        if not ws:
            print("لا ورشة!")
            return
        ws_id = ws[0]
        added = 0
        for gid, title in all_groups.items():
            url = f"https://www.facebook.com/groups/{gid}"
            exists = conn.execute('SELECT 1 FROM "MonitoredGroup" WHERE url = %s', (url,)).fetchone()
            if exists:
                continue
            conn.execute(
                '''INSERT INTO "MonitoredGroup"
                   ("id","workspaceId","platform","name","url","externalId","segment","status",
                    "intentScore","activityScore","postCount","notes","createdAt","updatedAt")
                   VALUES (gen_random_uuid()::text, %s, 'FACEBOOK', %s, %s, %s, 'BOTH', 'NEW',
                           55, 50, 0, %s, now(), now())''',
                (ws_id, title[:180], url, gid, "مكتشف آليًا (Task 13 farm) — بانتظار كوكيز حية للمسح"),
            )
            added += 1
        conn.commit()
        total = conn.execute('SELECT count(*) FROM "MonitoredGroup"').fetchone()[0]
    print(f"أضيف {added} جروب جديد — الإجمالي في المراقبة: {total}")


if __name__ == "__main__":
    main()
