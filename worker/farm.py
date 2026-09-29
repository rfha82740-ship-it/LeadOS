"""
LeadOS Browser Farm — 15 shards متوازية على GitHub Actions (DrissionPage + FlareSolverr)
كل shard = منصة كاملة. الأنماط:
  http    → طلبات مباشرة بدون متصفح (TELEGRAM t.me/s، REDDIT JSON)
  serp    → بحث DuckDuckGo HTML (يعمل من DC IPs بدون مفاتيح) + فلترة دومينات المنصة
  browser → DrissionPage يفتح بحث الموقع نفسه (wuzzuf/olx/mostaql/yellowpages)
  flare   → FlareSolverr للمواقع المحمية بكلاودفلير (fallback تلقائي لأي وضع)
الإرسال: /api/ingest/webhook بدفعات صغيرة + retry — نفس عقد المزرعة القديم.
Run: python3 farm.py --shard 0 --shards 15 [--part 0/1]
--part 0/1 = نص المهام — عمليتين متوازيين جوه نفس الـjob = ضعف المتصفحات الحقيقية (30 بدل 15)
بدون تكرار شغل: كل part بياخد مصادر متبادلة (i % 2) والسيرفر بيمسح المكرر برضه
"""
from __future__ import annotations

import argparse
import hashlib
import html as htmllib
import json
import os
import random
import re
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from leados_client import LeadOSClient  # noqa: E402

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# ---------------------------------------------------------------- الكلمات المفتاحية
INTENT_KW = [
    "محتاج", "عايز", "مطلوب", "نبحث عن", "عاوز", "محتاجين", "المطلوب",
    "need", "looking for", "hiring", "recommend", "توصية", "بديل", "أفضل",
]
QUERIES = {
    "QUORA": ["افضل برنامج كاشير للمطاعم مصر site:quora.com", "محتاج شركة برمجة مصر site:quora.com",
              "best crm small business egypt site:quora.com", "افضل شركة تسويق الكتروني مصر site:quora.com"],
    "DISCORD": ["discord.gg مصر بيزنس", "discord.gg مصر ستارت اب فريلانسرز",
                "egypt business discord server", "مجتمع مبرمجي مصر discord"],
    "EVENTS": ["معرض القاهرة للتكنولوجيا exhibitors", "Cairo ICT 2026 companies",
               "معرض egyfood expo المشاركين", "facebook.com/events معرض مصر بيزنس",
               "egyta exhibition cairo"],
    "YOUTUBE": ["مطعم القاهرة الجديدة review site:youtube.com", "افتح بيزنس مصر site:youtube.com",
                "صالون تجميل مدينة نصر site:youtube.com", "شركة سياحة الغردقة site:youtube.com"],
    "TIKTOK": ["مطعم مصر tiktok", "براند ملابس مصري tiktok", "كافيه مصر tiktok",
               "متجر الكتروني مصر tiktok"],
    "LINKEDIN": ["site:linkedin.com/jobs مبرمج مصر", "site:linkedin.com/jobs مدير تسويق القاهرة",
                 "we are hiring egypt site:linkedin.com", "شركة مصرية توسع site:linkedin.com"],
    "INSTAGRAM": ["براند ملابس مصري انستجرام", "كافيه مصر انستجرام", "متجر مصري انستقرام",
                  "مطعم جديد مصر انستجرام", "عيادة أسنان التجمع انستجرام"],
    "X": ["محتاج مبرمج مصر (x.com OR twitter.com)", "عايز مصمم مصر (x.com OR twitter.com)",
          "مطلوب شركة تسويق مصر (x.com OR twitter.com)"],
    "FACEBOOK": ["محتاج مبرمج مصر facebook.com", "عايز متجر الكتروني facebook.com",
                 "مطلوب نظام كاشير facebook.com", "شركة تسويق مصر facebook.com"],
    "JOBS": ["مبرمج", "تسويق", "مبيعات", "accountant"],
    "MARKETPLACE": ["مطعم للبيع", "محل للبيع", "مصنع للبيع", "شركة للبيع"],
    "FREELANCE": ["موقع", "تطبيق موبايل", "هوية بصرية", "نظام محاسبة", "متجر الكتروني"],
    "DIRECTORY": ["مطاعم", "عيادات", "صالونات", "شركات برمجة"],
}
TELEGRAM_CHANNELS = ["egyptbusiness", "AlBorsaNews", "AlmalNews", "AkhbarEconomy",
                     "BusinessEgypt", "marketing_egypt", "sadany", "wamda"]
REDDIT_SUBS = ["egypt", "EgyptBusiness", "startups"]

PLATFORM_DOMAINS = {
    "QUORA": ["quora.com"], "DISCORD": ["discord.com", "discord.gg"],
    "EVENTS": ["facebook.com/events", "egyta.com", "cairoict.com", "egyfoodexpo.com"],
    "YOUTUBE": ["youtube.com", "youtu.be"], "TIKTOK": ["tiktok.com"],
    "LINKEDIN": ["linkedin.com"], "INSTAGRAM": ["instagram.com"],
    "X": ["x.com", "twitter.com"], "FACEBOOK": ["facebook.com"],
}
SHARDS = ["telegram", "reddit", "quora", "discord", "events", "youtube", "tiktok",
          "linkedin", "instagram", "x", "facebook", "jobs", "marketplace",
          "freelance", "directory"]
SHARD_TO_PLATFORM = {
    "telegram": "TELEGRAM", "reddit": "REDDIT", "quora": "QUORA", "discord": "DISCORD",
    "events": "EVENTS", "youtube": "YOUTUBE", "tiktok": "TIKTOK", "linkedin": "LINKEDIN",
    "instagram": "INSTAGRAM", "x": "X", "facebook": "FACEBOOK", "jobs": "JOBS",
    "marketplace": "MARKETPLACE", "freelance": "FREELANCE", "directory": "DIRECTORY",
}


def ext_id(prefix: str, *parts: str) -> str:
    base = "|".join(p.strip().lower() for p in parts if p)
    return f"{prefix}:{hashlib.md5(base.encode()).hexdigest()[:12]}"


def has_intent(text: str) -> bool:
    t = (text or "").lower()
    return any(k.lower() in t for k in INTENT_KW)


# ---------------------------------------------------------------- FlareSolverr
def flare_get(url: str) -> str:
    base = os.environ.get("FLARESOLVERR_URL", "").rstrip("/")
    if not base:
        return ""
    try:
        r = requests.post(f"{base}/v1", json={"cmd": "request.get", "url": url,
                                              "maxTimeout": 55000}, timeout=70)
        d = r.json()
        if d.get("status") == "ok":
            return d.get("solution", {}).get("response", "")
    except Exception as e:
        print(f"  [flare] {url[:50]} -> {e}")
    return ""


# ---------------------------------------------------------------- serp: DuckDuckGo HTML
def ddg_search(query: str, limit: int = 12) -> list:
    """DuckDuckGo HTML endpoint — يشتغل من DC IPs بدون مفاتيح. يرجع [{title,url,snippet}]"""
    results = []
    for endpoint in ("https://html.duckduckgo.com/html/?q=", "https://lite.duckduckgo.com/lite/?q="):
        try:
            r = requests.post(endpoint.rstrip("/?q=") if "lite" in endpoint else endpoint,
                              data={"q": query} if "html" in endpoint else None,
                              params=None if "html" in endpoint else {"q": query},
                              headers={"User-Agent": UA, "Accept-Language": "ar,en"},
                              timeout=25)
            if r.status_code != 200 or not r.text:
                continue
            for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', r.text, re.S):
                href, title = m.group(1), re.sub(r"<[^>]+>", "", m.group(2)).strip()
                if "uddg=" in href:
                    u = re.search(r"uddg=([^&]+)", href)
                    if u:
                        href = requests.utils.unquote(u.group(1))
                if title and href.startswith("http"):
                    results.append({"title": htmllib.unescape(title), "url": href})
            if not results:  # lite layout: links table
                for m in re.finditer(r'<a[^>]+href="(https?://[^"]+)"[^>]*>([^<]{8,120})</a>', r.text):
                    u, t = m.group(1), m.group(2).strip()
                    if "duckduckgo.com" not in u and "duck.co" not in u:
                        results.append({"title": htmllib.unescape(t), "url": u})
            if results:
                break
        except Exception:
            continue
    return results[:limit]


def _half(seq, part: int) -> list:
    """تقسيم مصادر الشغل نصين للـparts المتوازية — part<0 = الكل (سلوك قديم)"""
    seq = list(seq)
    if part < 0:
        return seq
    return [x for i, x in enumerate(seq) if i % 2 == part]


def serp_shard(platform: str, part: int = -1) -> list:
    domains = PLATFORM_DOMAINS.get(platform, [])
    items = []
    flare_first = bool(os.environ.get("FLARESOLVERR_URL"))
    for q in _half(QUERIES.get(platform, [])[:4], part):
        if flare_first:
            raw = flare_get(f"https://html.duckduckgo.com/html/?q={requests.utils.quote(q)}")
            hits = []
            for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', raw, re.S):
                href, title = m.group(1), re.sub(r"<[^>]+>", "", m.group(2)).strip()
                if "uddg=" in href:
                    u = re.search(r"uddg=([^&]+)", href)
                    if u:
                        href = requests.utils.unquote(u.group(1))
                if title and href.startswith("http"):
                    hits.append({"title": htmllib.unescape(title), "url": href})
            print(f"  [flare-serp] {q[:44]!r} -> {len(hits)} نتايج")
        else:
            hits = ddg_search(q, 12)
        print(f"  [serp] {q[:44]!r} -> {len(hits)} نتايج")
        for h in hits:
            if domains and not any(d in h["url"] for d in domains):
                continue
            items.append({"name": h["title"][:180], "url": h["url"],
                          "externalId": ext_id(platform, h["url"])})
        time.sleep(random.uniform(2, 4))
    return items


# ---------------------------------------------------------------- http shards
def telegram_shard(part: int = -1) -> list:
    items = []
    for ch in _half(TELEGRAM_CHANNELS, part):
        for attempt in (0, 1):
            try:
                r = requests.get(f"https://t.me/s/{ch}", headers={"User-Agent": UA}, timeout=20)
                if r.status_code != 200:
                    break
                msgs = re.findall(r'<div class="tgme_widget_message_text js-message_text"[^>]*>(.*?)</div>',
                                  r.text, re.S)
                ids = re.findall(r'data-post="[^/]+/(\d+)"', r.text)
                kept = 0
                for i, body in enumerate(msgs):
                    text = htmllib.unescape(re.sub(r"<[^>]+>", " ", body)).strip()
                    text = re.sub(r"\s+", " ", text)
                    if len(text) < 25 or not has_intent(text):
                        continue
                    pid = ids[i] if i < len(ids) else str(i)
                    items.append({
                        "name": f"[تليجرام/{ch}] {text[:120]}",
                        "body": text[:900],
                        "url": f"https://t.me/{ch}/{pid}",
                        "externalId": ext_id("TG", ch, pid),
                    })
                    kept += 1
                    if kept >= 8:
                        break
                print(f"  [tg] {ch} -> {kept} بوست نية")
                break
            except Exception as e:
                if attempt:
                    print(f"  [tg] {ch} فشل: {e}")
                time.sleep(2)
        time.sleep(random.uniform(1, 2))
    return items


def reddit_shard(part: int = -1) -> list:
    items = []
    for sub in _half(REDDIT_SUBS, part):
        try:
            r = requests.get(f"https://www.reddit.com/r/{sub}/new.json?limit=40",
                             headers={"User-Agent": "LeadOS-Farm/1.0 (Egypt lead discovery)"},
                             timeout=20)
            posts = (r.json().get("data", {}) or {}).get("children", []) if r.status_code == 200 else []
            kept = 0
            for c in posts:
                d = c.get("data", {}) or {}
                text = f"{d.get('title', '')} {d.get('selftext', '')}"
                if not has_intent(text) or d.get("over_18"):
                    continue
                items.append({
                    "name": d.get("title", "")[:180],
                    "body": (d.get("selftext") or d.get("title", ""))[:900],
                    "url": f"https://www.reddit.com{d.get('permalink', '')}",
                    "handle": d.get("author", ""),
                    "externalId": ext_id("RD", d.get("id", sub)),
                })
                kept += 1
                if kept >= 8:
                    break
            print(f"  [reddit] r/{sub} -> {kept} بوست نية")
        except Exception as e:
            print(f"  [reddit] {sub} فشل: {e}")
        time.sleep(2)
    return items


# ---------------------------------------------------------------- browser shards (DrissionPage)
BROWSER_URLS = {
    "JOBS": ["https://wuzzuf.net/search/jobs/?q={kw}&a=hpb"],
    "MARKETPLACE": ["https://www.olx.com.eg/items/q-{kw}"],
    "FREELANCE": ["https://mostaql.com/projects?keyword={kw}", "https://khamsat.com/{kw}"],
    "DIRECTORY": ["https://www.yellowpages.com.eg/en/search/{kw}"],
}


def browser_shard(platform: str, part: int = -1) -> list:
    from DrissionPage import ChromiumPage, ChromiumOptions

    chrome = None
    for cand in (os.environ.get("CHROME_PATH", ""), "/usr/bin/chromium-browser",
                 "/usr/bin/chromium", "/usr/bin/google-chrome"):
        if os.path.exists(cand):
            chrome = cand
            break
    co = ChromiumOptions()
    co.headless(True)
    co.set_argument("--no-sandbox")
    co.set_argument("--disable-dev-shm-usage")
    co.set_argument("--disable-blink-features=AutomationControlled")
    co.set_user_agent(UA)
    if chrome:
        co.set_browser_path(chrome)
    items = []
    try:
        page = ChromiumPage(co)
    except Exception as e:
        print(f"  [browser] فشل تشغيل المتصفح: {e} — أرجع لـ FlareSolverr")
        return flare_shard(platform)

    pats_all = BROWSER_URLS.get(platform, [])
    if part >= 0 and len(pats_all) <= 1:
        # منصة بنمط واحد: النمط يتكرر للـparts كلها والتقسيم على الكلمات — الاتنين يفتحوا متصفح فعلًا
        patterns = pats_all
        kws_part = part
    else:
        patterns = _half(pats_all, part)
        kws_part = -1  # كل part بياخد أنماطه بكلماتها كاملة — صفر ضياع تغطية
    for pattern in patterns:
        for kw in _half(QUERIES.get(platform, [])[:4], kws_part):
            url = pattern.format(kw=kw.replace(" ", "-") if "olx" in pattern else kw.replace(" ", "%20"))
            try:
                page.get(url, timeout=35)
                time.sleep(3)
                links = []
                for a in page.eles("tag:a")[:400]:
                    href = a.attr("href") or ""
                    txt = (a.attr("title") or a.text or "").strip()
                    if len(txt) < 12:
                        continue
                    if href.startswith("/"):
                        href = __import__("urllib.parse", fromlist=["urljoin"]).urljoin(url, href)
                    if not href.startswith("http"):
                        continue
                    keep = False
                    if platform == "JOBS" and ("wuzzuf.net/jobs/" in href):
                        keep = True
                    elif platform == "MARKETPLACE" and ("olx.com.eg/item/" in href):
                        keep = True
                    elif platform == "FREELANCE" and any(k in href for k in ("mostaql.com/project/", "khamsat.com/")):
                        keep = True
                    elif platform == "DIRECTORY" and any(k in href for k in ("company/", "business/", "/en/company")):
                        keep = True
                    if keep:
                        links.append({"name": txt[:180], "url": href,
                                      "externalId": ext_id(platform, href)})
                links = list({l["url"]: l for l in links}.values())[:10]
                print(f"  [browser] {platform} {kw!r} -> {len(links)} عنصر")
                items.extend(links)
            except Exception as e:
                print(f"  [browser] {url[:60]} فشل: {str(e)[:80]}")
            time.sleep(random.uniform(2, 4))
    try:
        page.quit()
    except Exception:
        pass
    return items


def flare_shard(platform: str, part: int = -1) -> list:
    items = []
    for q in _half(QUERIES.get(platform, [])[:3], part):
        raw = flare_get(f"https://html.duckduckgo.com/html/?q={requests.utils.quote(q)}")
        if not raw:
            continue
        for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', raw, re.S):
            href, title = m.group(1), re.sub(r"<[^>]+>", "", m.group(2)).strip()
            if "uddg=" in href:
                u = re.search(r"uddg=([^&]+)", href)
                if u:
                    href = requests.utils.unquote(u.group(1))
            if title and href.startswith("http"):
                items.append({"name": htmllib.unescape(title)[:180], "url": href,
                              "externalId": ext_id(platform, href)})
        print(f"  [flare] {q[:40]!r} -> {len(items)} تراكمي")
        time.sleep(2)
    return items


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", type=int, default=0)
    ap.add_argument("--shards", type=int, default=15)
    ap.add_argument("--part", type=int, default=-1,
                    help="0/1 = نص المهام — عمليتين متوازيين جوه نفس الـjob")
    args = ap.parse_args()

    base = os.environ.get("LEADOS_BASE_URL", "").rstrip("/")
    key = os.environ.get("LEADOS_API_KEY", "")
    if not base or not key:
        print("::error::LEADOS_BASE_URL / LEADOS_API_KEY missing")
        return 2

    sid = args.shard % args.shards
    if sid >= len(SHARDS):
        print(f"shard {sid} خارج النطاق — لا شغل")
        return 0
    shard_id = SHARDS[sid]
    platform = SHARD_TO_PLATFORM[shard_id]
    client = LeadOSClient(base, key, timeout=240, batch_size=8)

    print(f"🚜 Browser Farm — shard {sid + 1}/{args.shards} ({shard_id} → {platform})")
    if not client.healthcheck():
        return 2

    if shard_id == "telegram":
        items = telegram_shard(args.part)
    elif shard_id == "reddit":
        items = reddit_shard(args.part)
    elif platform in BROWSER_URLS:
        items = browser_shard(platform, args.part)
        if not items:
            print("  المتصفح رجّع صفر — جرب FlareSolverr")
            items = flare_shard(platform, args.part)
    else:
        items = serp_shard(platform, args.part)
        if not items:
            print("  serp رجّع صفر — جرب FlareSolverr")
            items = flare_shard(platform, args.part)

    items = list({i["externalId"]: i for i in items}.values())
    print(f"📦 {platform}: {len(items)} عنصر جاهز للإرسال")
    res = client.send(platform, items, source="LeadOS Browser Farm (DrissionPage)")
    if res:
        print(f"✅ {platform} — leads جديدة: {res.get('created')} | مكرر: {res.get('duplicates')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
