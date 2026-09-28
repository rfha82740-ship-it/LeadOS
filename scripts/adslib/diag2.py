#!/usr/bin/env python3
"""Deep diag: watch XHRs, visible text, screenshot state of Ads Library page."""
import time
from playwright.sync_api import sync_playwright

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
URL = ("https://www.facebook.com/ads/library/?active_status=active&ad_type=all"
       "&country=EG&q=apartments&media_type=all")

reqs = []

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
    ctx = b.new_context(user_agent=UA, locale="en-US", viewport={"width": 1366, "height": 900})
    page = ctx.new_page()

    def on_resp(r):
        u = r.url
        if "ads/archive" in u or "ads_library" in u or "AdLibrary" in u or "ads/library" in u:
            reqs.append((r.status, u[:130]))
    page.on("response", on_resp)

    page.goto(URL, wait_until="domcontentloaded", timeout=45_000)
    time.sleep(6)
    # scroll to trigger lazy loads
    page.mouse.wheel(0, 2500)
    time.sleep(8)
    try:
        txt = page.inner_text("body")[:700].replace("\n", " | ")
    except Exception as e:
        txt = f"<inner_text failed: {e}>"
    print("VISIBLE TEXT:", txt[:700])
    print("--- relevant XHRs ---")
    for s, u in reqs[:15]:
        print(f"  {s} {u}")
    print(f"(total relevant: {len(reqs)})")
    page.screenshot(path="scripts/adslib/diag.png", full_page=False)
    print("screenshot: scripts/adslib/diag.png")
    b.close()
