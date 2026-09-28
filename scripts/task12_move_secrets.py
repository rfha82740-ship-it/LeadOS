#!/usr/bin/env python3
# LeadOS — نقل أسرار GitHub Actions للحساب الجديد (bdalhlymzaldyn7-ui/LeadOS)
# يقرا القيم من scripts/deploy/.tokens + .vercel/project.json — ولا يطبع أي قيمة سرية.
import base64
import json
import sys
import urllib.request
from pathlib import Path

NEW_TOKEN = __import__("os").environ.get("GH_NEW_TOKEN", "")  # التوكن من البيئة — عمره ما في الكود
OWNER = "bdalhlymzaldyn7-ui"
REPO = "LeadOS"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"

tok = {}
for line in Path("/home/z/my-project/scripts/deploy/.tokens").read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        tok[k.strip()] = v.strip().strip('"')
proj = json.loads(Path("/home/z/my-project/.vercel/project.json").read_text())

SECRETS = {
    "VERCEL_TOKEN": tok["VERCEL_TOKEN"],
    "CRON_SECRET": tok["CRON_SECRET_ALT"],
    "LEADOS_BASE_URL": "https://leados-v2.vercel.app",
    "LEADOS_API_KEY": tok["INGEST_API_KEY"],
    "VERCEL_PROJECT_ID": proj["projectId"],
    "VERCEL_ORG_ID": proj["orgId"],
}


def gh(path, data=None):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(data).encode() if data else None,
        headers={
            "Authorization": f"token {NEW_TOKEN}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
        method="PUT" if data else "GET",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


try:
    import nacl.public
except ImportError:
    sys.exit("NEED_PYNACL")

pk = gh("/actions/secrets/public-key")
key = nacl.public.PublicKey(base64.b64decode(pk["key"]))
sealed = nacl.public.SealedBox(key)
ok, fail = [], []
for name, value in SECRETS.items():
    enc = sealed.encrypt(value.encode())
    gh(f"/actions/secrets/{name}", {"encrypted_value": base64.b64encode(enc).decode(), "key_id": pk["key_id"]})
    ok.append(name)
print("SECRETS SET:", ok)
