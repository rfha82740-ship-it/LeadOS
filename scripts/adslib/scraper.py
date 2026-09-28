#!/usr/bin/env python3
"""LeadOS — Facebook Ads Library scraper (anonymous, real Chromium).

Runs on GitHub Actions (public repo = free minutes) every cycle:
  1. Opens facebook.com/ads/library for N search queries (Egypt by default)
  2. Extracts advertisers from the embedded React props (page_id / page_name /
     ad_archive_id / ad body text)
  3. Groups ads by advertiser -> ONE lead per advertiser (deterministic externalId
     so re-runs dedupe at ContentItem level in LeadOS)
  4. POSTs to /api/ingest/webhook (x-api-key: INGEST_API_KEY) with platform=ADS_LIBRARY

Env:
  LEADOS_BASE_URL   (required)  e.g. https://leados-v2.vercel.app
  LEADOS_API_KEY    (required)  value of INGEST_API_KEY
  QUERIES           (optional)  comma-separated; overrides defaults
  MAX_QUERIES       (optional)  cap (default 5)
  COUNTRY           (optional)  default EG
"""
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

DEFAULT_QUERIES = [
    "عقارات", "apartments for sale", "سيارات", "مطعم", "عيادة",
    "كورس", "متجر اونلاين", "تخسيس",
]

RE_PAGE_ID = re.compile(r'page_id\\?":\\?"(\d{8,})')
RE_PAGE_NAME = re.compile(r'page_name\\?":\\?"([^"\\]{2,120})')

# DOM extraction: FB no longer embeds ad props in raw HTML — the cards are rendered.
# Each ad card shows "Library ID: <digits>". We walk text nodes, climb to the card
# container, and take the first anchor (the advertiser's page link) as the name.
JS_EXTRACT = r"""
() => {
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  const UI = /^(see|open|active|inactive|library|started|platforms|filters|sort|remove|drop|summary|ad |advertiser|results|about|faq|login|log in|privacy|terms|cookies|report|get |download|learn)/i;
  while ((node = walker.nextNode())) {
    const m = node.textContent && node.textContent.match(/Library ID:\s*(\d{8,})/);
    if (!m) continue;
    let el = node.parentElement, card = null;
    for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
      const t = el.innerText || "";
      if (t.length > 350 && t.includes("Library ID") && (t.includes("Started running") || t.includes("Platforms") || t.includes("use this creative"))) { card = el; break; }
    }
    if (!card || seen.has(card)) continue;
    seen.add(card);
    let name = "", href = "";
    const links = card.querySelectorAll('a[href]');
    for (const a of links) {
      const t = (a.innerText || "").trim().replace(/\s+/g, " ");
      if (t && t.length >= 2 && t.length <= 90 && !UI.test(t)) { name = t; href = a.href || ""; break; }
    }
    const text = (card.innerText || "").replace(/\s+/g, " ").slice(0, 420);
    out.push({ libId: m[1], name, href, text });
  }
  return out;
}
"""


def lib_url(q: str, country: str) -> str:
    return ("https://www.facebook.com/ads/library/?active_status=active&ad_type=all"
            f"&country={country}&q={urllib.request.quote(q)}&media_type=all")


def clean_name(n: str) -> str:
    return re.sub(r"\s+", " ", n).strip()


def parse_advertisers(cards: list, query: str) -> dict:
    """Group DOM ad-cards by advertiser name.
    Returns name -> {href, text, ads, lib_id}."""
    advertisers = {}
    for c in cards:
        nm = clean_name(c.get("name", ""))
        if not nm:
            continue
        a = advertisers.setdefault(nm, {"href": "", "text": "", "ads": 0, "lib_id": ""})
        a["ads"] += 1
        if not a["href"]:
            a["href"] = c.get("href", "")
        if not a["lib_id"]:
            a["lib_id"] = c.get("libId", "")
        if not a["text"]:
            a["text"] = c.get("text", "")
    return advertisers


def post_lead(base: str, key: str, items: list) -> list:
    """POST in chunks of 10 (classification pipeline takes ~2-4s/item)."""
    results = []
    for i in range(0, len(items), 10):
        chunk = items[i:i + 10]
        payload = {"source": "Ads Library Scraper (GitHub Actions)",
                   "platform": "ADS_LIBRARY", "items": chunk}
        req = urllib.request.Request(
            f"{base.rstrip('/')}/api/ingest/webhook",
            data=json.dumps(payload, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json", "x-api-key": key},
            method="POST")
        with urllib.request.urlopen(req, timeout=240) as res:
            body = json.loads(res.read())
            results.append(body)
            print(f"  chunk {i // 10 + 1}: HTTP {res.status} :: received={body.get('received')} "
                  f"leads={body.get('leadsCreated')} dup={body.get('duplicates')}")
    return results


def main() -> int:
    base = os.environ.get("LEADOS_BASE_URL", "").rstrip("/")
    key = os.environ.get("LEADOS_API_KEY", "")
    country = os.environ.get("COUNTRY", "EG")
    q_env = os.environ.get("QUERIES", "").strip()
    queries = [q.strip() for q in q_env.split(",") if q.strip()] if q_env else DEFAULT_QUERIES
    max_q = int(os.environ.get("MAX_QUERIES", "5"))
    queries = queries[:max_q]

    if not base or not key:
        print("::error::LEADOS_BASE_URL / LEADOS_API_KEY missing")
        return 2

    all_items = []
    blocked = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--no-sandbox", "--disable-blink-features=AutomationControlled"])
        ctx = browser.new_context(user_agent=UA, locale="en-US",
                                  viewport={"width": 1366, "height": 900})
        page = ctx.new_page()
        for i, q in enumerate(queries, 1):
            url = lib_url(q, country)
            print(f"[{i}/{len(queries)}] {q!r} -> loading ...")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45_000)
                time.sleep(7)
                page.mouse.wheel(0, 2000)  # trigger lazy render
                time.sleep(5)
                cards = page.evaluate(JS_EXTRACT)
            except Exception as e:
                print(f"  ::warning::load failed: {str(e)[:160]}")
                continue
            low = (page.inner_text("body") if cards == [] else "").lower()
            if cards == [] and ("must log in" in low or "content isn't available" in low):
                print("  ::warning::blocked (login wall) — skipping query")
                blocked += 1
                continue
            advs = parse_advertisers(cards, q)
            print(f"  ad cards: {len(cards)} | advertisers: {len(advs)}")
            if i == 1:
                Path("adslib-sample.html").write_text(page.content()[:2_000_000], encoding="utf-8")
            for nm, a in advs.items():
                slug = re.sub(r"[^a-z0-9\u0600-\u06ff]+", "-", nm.lower()).strip("-")[:80]
                # deep link to an actual ad — required by the ADS_LIBRARY realAd gate in queue.ts
                link = (f"https://www.facebook.com/ads/library/?id={a['lib_id']}"
                        if a["lib_id"] else url)
                page_link = a["href"] or ""
                all_items.append({
                    "externalId": f"fbadlib:{slug}",
                    "name": nm[:120],
                    "url": link,
                    "body": f"إعلان ممول نشط على فيسبوك (استعلام: {q}) — "
                            f"{a['ads']} إعلان مرصود. عينة: {a['text'][:200]}"
                            + (f" | صفحة المعلن: {page_link[:120]}" if page_link else ""),
                })
            time.sleep(3)
        browser.close()

    # dedupe across queries by externalId
    items = list({it["externalId"]: it for it in all_items}.values())
    print(f"total advertisers to push: {len(items)} (blocked queries: {blocked})")
    if not items:
        print("::warning::no advertisers found this run")
        return 0

    results = post_lead(base, key, items)
    total_leads = sum(r.get("leadsCreated", 0) for r in results)
    total_dup = sum(r.get("duplicates", 0) for r in results)
    print(f"SUMMARY: advertisers={len(items)} leadsCreated={total_leads} duplicates={total_dup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
