#!/usr/bin/env python3
"""تحديث جست الدليل الموجود بنسخة الإصدار 2 (PATCH) — يسيب اللينك القديم شغال.
Fallback: لو الجست القديم مش موجود → إنشاء جست جديد."""
import json
import sys
import urllib.request
from pathlib import Path

DOC = Path("/home/z/my-project/download/LeadOS-الدليل-الشامل-المفصل.md")
GIST_NAME = "LeadOS-Complete-System-Guide-AR.md"
EXISTING_ID = "15a1056aa3f535ce0d3b51895fc723a7"
TOKEN_FILE = Path("/home/z/my-project/upload/api من جيت هاب.txt")

token = TOKEN_FILE.read_text(encoding="utf-8").strip().splitlines()[0].strip()
content = DOC.read_text(encoding="utf-8")

headers = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
}


def main() -> int:
    # 1) محاولة تحديث الجست القديم
    payload = {
        "description": "LeadOS / زيزو — الدليل الشامل المفصل v2.0 (30 سبتمبر 2026): 66 جدول، محرك اكتشاف 19+ منصة، عقل مهارات 4 طبقات، DSI خرايط تفكير ديناميكية، زيزو كيان البيع، 6 سلاسل ذاتية 24/7، صفر محلي",
        "files": {GIST_NAME: {"content": content}},
    }
    req = urllib.request.Request(
        f"https://api.github.com/gists/{EXISTING_ID}",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        raw = data["files"][GIST_NAME]["raw_url"]
        size = data["files"][GIST_NAME].get("size", 0)
        print(f"UPDATED existing gist {EXISTING_ID}")
        print(f"raw_url: {raw}")
        print(f"size: {size} bytes")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"PATCH failed: {e} — falling back to creating a new gist")

    # 2) fallback: إنشاء جست جديد
    payload["description"] = "LeadOS — الدليل الشامل المفصل v2.0 لكل مكونات المشروع"
    req = urllib.request.Request(
        "https://api.github.com/gists",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    raw = data["files"][GIST_NAME]["raw_url"]
    print(f"CREATED new gist {data['id']}")
    print(f"raw_url: {raw}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
