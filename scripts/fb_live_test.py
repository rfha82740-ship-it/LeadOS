#!/usr/bin/env python3
"""اختبار حي لكوكيز فيسبوك — بدون طباعة أي قيمة كوكيز"""
import re
import psycopg2
import urllib.request

# الكوكيز من .env.local
cookie = [l.split("=", 1)[1].strip() for l in open("/home/z/my-project/.env.local")
          if l.startswith("FACEBOOK_SESSION_COOKIE=")][0]

UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"

def probe(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Cookie": cookie,
        "Accept-Language": "ar,en;q=0.8",
    })
    try:
        res = urllib.request.urlopen(req, timeout=25)
        html = res.read().decode("utf-8", "ignore")
        return res.status, html
    except Exception as e:
        return -1, str(e)

# 1) الصفحة الرئيسية — الجلسة عايشة؟
st, html = probe("https://mbasic.facebook.com/")
logged_in = "c_user" in html or "Log Out" in html or "تسجيل الخروج" in html or "mbasic_logout" in html
checkpoint = "checkpoint" in html.lower()
print(f"الرئيسية: HTTP {st} | جلسة مسجلة={logged_in} | checkpoint={checkpoint}")

# 2) جروب حقيقي من قاعدة البيانات
url = [l.split("=", 1)[1] for l in open("/home/z/my-project/scripts/deploy/.tokens")
       if l.startswith("DATABASE_URL=")][0].strip().strip('"')
c = psycopg2.connect(url); cur = c.cursor()
cur.execute('SELECT url, name FROM "MonitoredGroup" WHERE platform=%s AND status=%s ORDER BY "lastScannedAt" ASC NULLS FIRST LIMIT 1', ("FACEBOOK", "ACTIVE"))
row = cur.fetchone(); c.close()
gurl = row[0] if row else None
gname = (row[1] or "?")[:40] if row else "?"
print(f"جروب الاختبار: {gname}")

if gurl:
    m = re.search(r"/groups/([^/?]+)", gurl)
    gid = m.group(1) if m else None
    if gid:
        # نفس طلب الإنتاج حرفيًا: www.facebook.com/groups/{id}/posts/ + كوكي
        req = urllib.request.Request(
            f"https://www.facebook.com/groups/{urllib.parse.quote(gid)}/posts/",
            headers={
                "User-Agent": UA,
                "Cookie": cookie,
                "Accept-Language": "ar,eg;q=0.9,en;q=0.8",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Sec-Fetch-Mode": "navigate",
            })
        try:
            res = urllib.request.urlopen(req, timeout=25, )
            html2 = res.read().decode("utf-8", "ignore")
            st2 = res.status
        except Exception as e:
            html2, st2 = str(e), -1
        has_stories = ('"__typename":"Story"' in html2 or '"post_id"' in html2)
        login_wall = bool(re.search(r"login_form|checkpoint|you\s+must\s+log\s+in|يجب.*تسجيل الدخول", html2, re.I))
        blocked = bool(re.search(r"محتوى غير متوفر|content isn't available", html2, re.I))
        n_posts = html2.count('"__typename":"Story"')
        print(f"الجروب: HTTP {st2} | Stories={n_posts} | login-wall={login_wall} | blocked={blocked} | حجم={len(html2)//1024}KB")
        if n_posts:
            txts = re.findall(r'"message":\{"text":"((?:\\.|[^"\\])*)"', html2)
            if txts:
                sample = txts[0].replace("\\n", " ").replace("\\u0640", "")[:100]
                print(f"عينة أول بوست: {sample}")
        elif login_wall:
            print("❌ جدار تسجيل دخول — الكوكيز مش شغالة على www")
elif gurl is None:
    print("مفيش جروب متاح")
