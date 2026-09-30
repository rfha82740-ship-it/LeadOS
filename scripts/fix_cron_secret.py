#!/usr/bin/env python3
"""إصلاح CRON_SECRET في GitHub Actions secrets — من قيمة الإنتاج الفعلية فقط."""
import base64
import sys
from pathlib import Path
from nacl import encoding, public

ROOT = Path(__file__).resolve().parent.parent
REPO = "rfha82740-ship-it/LeadOS"


def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def read_token() -> str:
    creds = Path.home() / ".git-credentials"
    txt = creds.read_text().strip()
    return txt.split("://", 1)[1].split("@", 1)[0].split(":", 1)[1]


def api(token: str, method: str, url: str, payload=None):
    import json
    import urllib.request
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
            return r.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def main() -> int:
    prod = load_env(ROOT / ".env.vercel-prod")
    value = prod.get("CRON_SECRET")
    if not value:
        print("FATAL: no CRON_SECRET in .env.vercel-prod")
        return 1
    token = read_token()

    # 1) public key
    st, pk = api(token, "GET", f"https://api.github.com/repos/{REPO}/actions/secrets/public-key")
    assert st == 200, f"public-key failed: {st}"
    pk_obj = public.PublicKey(pk["key"].encode(), encoding.Base64Encoder())
    sealed = public.SealedBox(pk_obj).encrypt(value.encode())

    # 2) put secret
    st, out = api(token, "PUT", f"https://api.github.com/repos/{REPO}/actions/secrets/CRON_SECRET",
                  {"encrypted_value": base64.b64encode(sealed).decode(), "key_id": pk["key_id"]})
    print(f"PUT CRON_SECRET -> HTTP {st} (204 = OK) value_len={len(value)}")
    return 0 if st in (201, 204) else 1


if __name__ == "__main__":
    sys.exit(main())
