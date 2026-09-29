#!/usr/bin/env python3
"""LeadOS — تركيب كوكيز فيسبوك الجديدة بأمان:
1. JSON → هيدر Cookie
2. تحديث FACEBOOK_SESSION_COOKIE في .env.local (gitignored)
3. إنشاء/تحديث GitHub Secret FACEBOOK_SESSION_COOKIE (تشفير libsodium)
لا تطبع أي قيمة كاملة أبدًا.
"""
import json
import re
import sys
import urllib.request

BASE = "/home/z/my-project"
GH_REPO = "bdalhlymzaldyn7-ui/LeadOS"

# توكن جيت هاب من remote URL (بدون طباعته)
remote = urllib.parse.unquote(
    __import__("subprocess").run(
        ["git", "config", "--get", "remote.origin.url"],
        cwd=BASE, capture_output=True, text=True,
    ).stdout.strip()
)
m = re.search(r"https://[^:]+:([^@]+)@", remote)
GH_TOKEN = m.group(1) if m else None
if not GH_TOKEN:
    sys.exit("❌ مفيش توكن في remote.origin.url")

# ══ 1) JSON → Cookie header ══
cookies = json.load(open(f"{BASE}/.fb-cookies.json"))
pairs = [f"{c['name']}={c['value']}" for c in cookies]
header = "; ".join(pairs)

# أسماء موجودة + صلاحية xs
names = [c["name"] for c in cookies]
xs_exp = next((c["expirationDate"] for c in cookies if c["name"] == "xs"), 0)
import datetime
print(f"✅ {len(pairs)} كوكيز: {sorted(set(names))}")
print(f"   انتهاء xs: {datetime.datetime.fromtimestamp(xs_exp).strftime('%Y-%m-%d')}")

# ══ 2) تحديث .env.local ══
env_path = f"{BASE}/.env.local"
lines = open(env_path).read().splitlines()
new_lines = [l for l in lines if not l.startswith("FACEBOOK_SESSION_COOKIE=")]
new_lines.append(f"FACEBOOK_SESSION_COOKIE={header}")
open(env_path, "w").write("\n".join(new_lines) + "\n")
print(f"✅ .env.local اتحدث ({len(new_lines)} سطر)")

# ══ 3) GitHub Secret (sealed box) ══
from nacl import encoding, public

req = urllib.request.Request(
    f"https://api.github.com/repos/{GH_REPO}/actions/secrets/public-key",
    headers={"Authorization": f"Bearer {GH_TOKEN}", "Accept": "application/vnd.github+json"},
)
key_data = json.load(urllib.request.urlopen(req))
pk = public.PublicKey(key_data["key"].encode(), encoding.Base64Encoder())
sealed = public.SealedBox(pk).encrypt(header.encode())
import base64
body = json.dumps({
    "encrypted_value": base64.b64encode(sealed).decode(),
    "key_id": key_data["key_id"],
}).encode()
req = urllib.request.Request(
    f"https://api.github.com/repos/{GH_REPO}/actions/secrets/FACEBOOK_SESSION_COOKIE",
    data=body, method="PUT",
    headers={"Authorization": f"Bearer {GH_TOKEN}", "Accept": "application/vnd.github+json"},
)
resp = urllib.request.urlopen(req)
print(f"✅ GitHub Secret FACEBOOK_SESSION_COOKIE -> HTTP {resp.status}")
print("   بصمة القيمة (بدون كشف):", header[:12], "...", header[-8:], f"| طول={len(header)}")
