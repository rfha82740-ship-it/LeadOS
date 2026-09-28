#!/usr/bin/env python3
"""Diag: is the 'blocked' verdict a false positive? Count ads + show checkpoint context."""
import re, time
from playwright.sync_api import sync_playwright

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
URL = ("https://www.facebook.com/ads/library/?active_status=active&ad_type=all"
       "&country=EG&q=%D8%B9%D9%82%D8%A7%D8%B1%D8%A7%D8%AA&media_type=all")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
    ctx = b.new_context(user_agent=UA, locale="en-US", viewport={"width": 1366, "height": 900})
    page = ctx.new_page()
    page.goto(URL, wait_until="domcontentloaded", timeout=45_000)
    time.sleep(9)
    html = page.content()
    print(f"html size: {len(html)}")
    print(f"ad_archive_id count: {html.count('ad_archive_id')}")
    print(f"page_id count: {len(re.findall(r'page_id', html))}")
    for marker in ["checkpoint", "captcha", "Captcha", "recaptcha"]:
        idx = html.find(marker)
        ctx_str = html[max(0, idx-60):idx+80].replace("\n", " ") if idx != -1 else ""
        print(f"{marker!r}: found@{idx} context=...{ctx_str[:130]}...")
    b.close()
