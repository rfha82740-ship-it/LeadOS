#!/usr/bin/env python3
"""اكتشاف دوري لجروبات فيسبوك مصرية جديدة — نسخة رينر جيت هاب (env-first + FlareSolverr)
- DATABASE_URL من env (GitHub Secret) أو scripts/deploy/.tokens محليًا
- DDG: فلير أولًا لو متاح (runner IPs محجوبة من DDG) — مباشر كاحتياط
- تدوير استعلامات يومي: كل يوم نية مختلفة — حقن بحد أقصى 8 جروب/تشغيلة بحالة ACTIVE
"""
import datetime
import os
import re
import sys
import time

import psycopg
import requests

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
    "site:facebook.com/groups صاحب مشروع مصر",
    "site:facebook.com/groups متاجر اونلاين مصر",
]
CAP = 8
BIZ_KW = re.compile(
    r"اعلانات|إعلانات|بيزنس|بزنس|فرص عمل|وظائف|رواد|اعمال|أعمال|تسويق|تجاره|تجارة|استيراد|مبرمجين|شغل|كليينج|مطاعم|كافيهات|عقارات|اونلاين|أونلاين",
    re.I,
)


def db_url() -> str:
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    p = os.path.join(os.getcwd(), "scripts", "deploy", ".tokens")
    for line in open(p, encoding="utf8"):
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("❌ لا DATABASE_URL في env ولا .tokens")


def flare_get(url: str) -> str:
    base = os.environ.get("FLARESOLVERR_URL", "").rstrip("/")
    if not base:
        return ""
    try:
        r = requests.post(f"{base}/v1",
                          json={"cmd": "request.get", "url": url, "maxTimeout": 60000},
                          timeout=90)
        return ((r.json() or {}).get("solution", {}) or {}).get("response", "") or ""
    except Exception as e:
        print(f"  flare err: {e}")
        return ""


def ddg_groups(query: str) -> list:
    ddg_url = f"https://html.duckduckgo.com/html/?q={requests.utils.quote(query)}"
    raw = ""
    if os.environ.get("FLARESOLVERR_URL"):
        raw = flare_get(ddg_url)  # runner IPs: فلير أولًا — DDG بيحجبهم
    if not raw:
        try:
            r = requests.post("https://html.duckduckgo.com/html/", data={"q": query},
                              headers={"User-Agent": UA}, timeout=25)
            raw = r.text if r.status_code == 200 else ""
        except Exception as e:
            print(f"  ddg err: {e}")
    found = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', raw or "", re.S):
        href, title = m.group(1), re.sub(r"<[^>]+>", "", m.group(2)).strip()
        if "uddg=" in href:
            u = re.search(r"uddg=([^&]+)", href)
            if u:
                from urllib.parse import unquote
                href = unquote(u.group(1))
        g = re.search(r"facebook\.com/groups/([A-Za-z0-9._\-]+)/?", href)
        if g and title:
            found.append((g.group(1), title))
    print(f"  [{len(found)}] {query[:58]}")
    return found


def main() -> None:
    day = datetime.datetime.utcnow().timetuple().tm_yday
    qs = [QUERIES[(day * 3 + i) % len(QUERIES)] for i in range(4)]
    print(f"🔎 اكتشاف اليوم: {len(qs)} استعلام (تدوير يومي)")
    all_groups: dict = {}
    for q in qs:
        for gid, title in ddg_groups(q):
            all_groups.setdefault(gid, title)
        time.sleep(2)
    print(f"فريد: {len(all_groups)} جروب")
    if not all_groups:
        print("⚠️ مفيش نتايج — DDG محجوب والفلير واقف؟")
        return
    with psycopg.connect(db_url()) as conn:
        ws = conn.execute('SELECT id FROM "Workspace" ORDER BY "createdAt" ASC LIMIT 1').fetchone()
        if not ws:
            sys.exit("لا ورشة")
        ws_id = ws[0]
        added = 0
        for gid, title in all_groups.items():
            if added >= CAP:
                break
            u = f"https://www.facebook.com/groups/{gid}"
            if conn.execute('SELECT 1 FROM "MonitoredGroup" WHERE url = %s', (u,)).fetchone():
                continue
            score = 75 if BIZ_KW.search(title) else 55
            conn.execute(
                '''INSERT INTO "MonitoredGroup"
                   ("id","workspaceId","platform","name","url","externalId","segment","status",
                    "intentScore","activityScore","postCount","notes","createdAt","updatedAt")
                   VALUES (gen_random_uuid()::text, %s, 'FACEBOOK', %s, %s, %s, 'BOTH', 'ACTIVE',
                           %s, 50, 0, %s, now(), now())''',
                (ws_id, title[:180], u, gid, score, "اكتشاف تلقائي دوري (سلسلة fb-groups)"),
            )
            added += 1
        conn.commit()
        total = conn.execute('SELECT count(*) FROM "MonitoredGroup"').fetchone()[0]
    print(f"✅ أضيف {added} جروب جديد ACTIVE — إجمالي المراقبة: {total}")


if __name__ == "__main__":
    main()
