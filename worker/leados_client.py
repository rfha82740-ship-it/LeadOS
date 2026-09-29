"""
LeadOS Worker — leados_client.py
إرسال نتايج الـscraping إلى LeadOS عبر /api/ingest/webhook مع retry/backoff.
"""
from __future__ import annotations

import time
from typing import Dict, List, Optional

import requests


class LeadOSClient:
    def __init__(self, base_url: str, api_key: str, timeout: int = 240, batch_size: int = 8):
        self.endpoint = base_url.rstrip("/") + "/api/ingest/webhook"
        self.api_key = api_key
        self.timeout = timeout
        self.batch_size = max(1, int(batch_size))
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json", "x-api-key": api_key})

    # ------------------------------------------------------------------
    def send(self, platform: str, items: List[Dict], source: str = "Botasaurus Worker") -> Optional[Dict]:
        """إرسال على دفعات مع retry/backoff (0s/3s/8s). ارجع إجمالي (created, duplicates) أو None لو فشل كله."""
        if not items:
            return {"created": 0, "duplicates": 0}
        totals = {"created": 0, "duplicates": 0}
        for i in range(0, len(items), self.batch_size):
            batch = items[i : i + self.batch_size]
            payload = {"source": source, "platform": platform, "items": batch}
            res = self._post_with_retry(payload)
            if res is None:
                print(f"[leados] ⚠️ دفعة {i // self.batch_size + 1} فشلت نهائيًا ({len(batch)} عنصر) — هتتراحع في دورة لاحقة")
                continue
            totals["created"] += res.get("leadsCreated", 0)
            totals["duplicates"] += res.get("duplicates", 0)
        return totals

    def _post_with_retry(self, payload: Dict) -> Optional[Dict]:
        backoff = [0, 3, 8]
        last_err = ""
        for attempt, wait in enumerate(backoff, 1):
            if wait:
                time.sleep(wait)
            try:
                r = self.session.post(self.endpoint, json=payload, timeout=self.timeout)
                if r.status_code == 200:
                    return r.json()
                if r.status_code in (401, 403):
                    print(f"[leados] ❌ مفتاح API مرفوض ({r.status_code}) — راجع INGEST_API_KEY")
                    return None
                if r.status_code == 429:
                    last_err = "rate limited"
                    continue
                last_err = f"HTTP {r.status_code}: {r.text[:120]}"
            except requests.RequestException as e:
                last_err = str(e)[:150]
        print(f"[leados] ❌ فشل الإرسال بعد {len(backoff)} محاولات — {last_err}")
        return None

    # ------------------------------------------------------------------
    def healthcheck(self) -> bool:
        """GET على الـwebhook للتأكد من المفتاح قبل ما نهدر وقت في scraping."""
        try:
            r = self.session.get(self.endpoint, timeout=15)
            if r.status_code == 200:
                print("[leados] ✅ الاتصال بـ LeadOS شغال والمفتاح مقبول")
                return True
            print(f"[leados] ❌ الاتصال رفض: HTTP {r.status_code} — راجع LEADOS_BASE_URL / INGEST_API_KEY")
        except requests.RequestException as e:
            print(f"[leados] ❌ مش قادر أوصل لـ LeadOS: {str(e)[:150]}")
        return False
