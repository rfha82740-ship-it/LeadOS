#!/usr/bin/env python3
"""LeadOS — حقن DATABASE_URL في GitHub Secrets (تشفير libsodium sealed box).
المصدر: scripts/deploy/.tokens (gitignored). لا تطبع أي قيمة كاملة أبدًا.
"""
import base64
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request

BASE = "/home/z/my-project"
GH_REPO = "bdalhlymzaldyn7-ui/LeadOS"

# توكن من remote URL (بدون طباعته)
remote = urllib.parse.unquote(
    subprocess.run(["git", "config", "--get", "remote.origin.url"],
                   cwd=BASE, capture_output=True, text=True).stdout.strip()
)
m = re.search(r"https://[^:]+:([^@]+)@", remote)
GH_TOKEN = m.group(1) if m else None
if not GH_TOKEN:
    sys.exit("❌ مفيش توكن في remote.origin.url")

# DATABASE_URL من .tokens (بدون طباعته)
line = next(
    (l for l in open(f"{BASE}/scripts/deploy/.tokens").read().splitlines()
     if l.startswith("DATABASE_URL=")),
    None,
)
if not line:
    sys.exit("❌ مفيش DATABASE_URL في .tokens")
value = line.split("=", 1)[1].strip().strip('"')
masked = re.sub(r"://([^@]+)@", r"://***@", value)[:60]
print(f"🔑 القيمة المستهدفة (مقنعة): {masked}")

# مفتاح النموذج + الختم
req = urllib.request.Request(
    f"https://api.github.com/repos/{GH_REPO}/actions/secrets/public-key",
    headers={"Authorization": f"Bearer {GH_TOKEN}", "Accept": "application/vnd.github+json"},
)
key_data = json.load(urllib.request.urlopen(req))

from nacl import encoding, public
pk = public.PublicKey(key_data["key"].encode(), encoding.Base64Encoder())
sealed = public.SealedBox(pk).encrypt(value.encode())
body = json.dumps({
    "encrypted_value": base64.b64encode(sealed).decode(),
    "key_id": key_data["key_id"],
}).encode()

req = urllib.request.Request(
    f"https://api.github.com/repos/{GH_REPO}/actions/secrets/DATABASE_URL",
    data=body, method="PUT",
    headers={"Authorization": f"Bearer {GH_TOKEN}", "Accept": "application/vnd.github+json",
             "Content-Type": "application/json"},
)
with urllib.request.urlopen(req) as r:
    print(f"✅ DATABASE_URL secret -> HTTP {r.status} (201/204 = تم)")
