#!/usr/bin/env python3
"""إنشاء/تحديث GitHub Secret LEADOS_GH_PAT (من توكن remote.origin.url — بدون طباعته).
القيمة هتستخدم من workflow vercel-ops لضبط GITHUB_TOKEN/GITHUB_REPO على Vercel (زر الإيقاف من اللوحة)."""
import base64
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request

BASE = "/home/z/my-project"
GH_REPO = "bdalhlymzaldyn7-ui/LeadOS"
SECRET_NAME = "LEADOS_GH_PAT"

# توكن من remote URL (بدون طباعته) — نفس القيمة اللي هتتخزن
remote = urllib.parse.unquote(
    subprocess.run(["git", "config", "--get", "remote.origin.url"],
                   cwd=BASE, capture_output=True, text=True).stdout.strip()
)
m = re.search(r"https://[^:]+:([^@]+)@", remote)
TOKEN = m.group(1) if m else None
if not TOKEN:
    sys.exit("❌ مفيش توكن في remote.origin.url")
VALUE = TOKEN  # نفس التوكن — عنده صلاحية contents (يدفع للريبو أصلاً)

def api(url, data=None, method=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"token {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    body = None
    if data is not None:
        req.add_header("Content-Type", "application/json")
        body = json.dumps(data).encode()
    with urllib.request.urlopen(req, body) as r:
        return json.loads(r.read().decode()) if r.status != 204 else {}

# 1) مفتاح التشفير العام للريبو
pk = api(f"https://api.github.com/repos/{GH_REPO}/actions/secrets/public-key")
key, key_id = pk["key"], pk["key_id"]

# 2) تشفير sealed box (libsodium)
from nacl import encoding, public  # type: ignore
pk_obj = public.PublicKey(key.encode("utf-8"), encoding.Base64Encoder())
sealed = public.SealedBox(pk_obj).encrypt(VALUE.encode())
enc = base64.b64encode(sealed).decode()

# 3) رفع السر
api(f"https://api.github.com/repos/{GH_REPO}/actions/secrets/{SECRET_NAME}",
    data={"encrypted_value": enc, "key_id": key_id}, method="PUT")
print(f"✅ Secret {SECRET_NAME} اتحط على {GH_REPO} (القيمة مش مطبوعة)")
