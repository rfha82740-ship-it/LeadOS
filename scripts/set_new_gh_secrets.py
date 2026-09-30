#!/usr/bin/env python3
"""Set GitHub Actions secrets on the new repo (rfha82740-ship-it/LeadOS).

Values are sourced locally from env files / credential store.
NEVER prints secret values - only secret names + HTTP status.
"""
import base64
import json
import re
import sys
import urllib.request
from pathlib import Path
from nacl import encoding, public

REPO = "rfha82740-ship-it/LeadOS"
ROOT = Path("/home/z/my-project")
CREDS = Path.home() / ".git-credentials"


def read_token() -> str:
    txt = CREDS.read_text().strip()
    m = re.search(r":([^:@]+)@github\.com", txt)
    if not m:
        sys.exit("no token in credential store")
    return m.group(1)


def load_env(path: Path) -> dict:
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip().strip('"').strip("'")
        if k and v:
            out[k.strip()] = v
    return out


def api(token: str, method: str, url: str, payload: dict | None = None):
    req = urllib.request.Request(
        f"https://api.github.com{url}",
        method=method,
        data=json.dumps(payload).encode() if payload else None,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    token = read_token()
    env = load_env(ROOT / ".env")
    local = load_env(ROOT / ".env.local")
    prod = load_env(ROOT / ".env.vercel-prod")

    wanted = {
        "DATABASE_URL": env.get("DATABASE_URL") or prod.get("DATABASE_URL"),
        "CRON_SECRET": local.get("CRON_SECRET") or prod.get("CRON_SECRET"),
        "FACEBOOK_SESSION_COOKIE": local.get("FACEBOOK_SESSION_COOKIE"),
        "JINA_API_KEY": prod.get("JINA_API_KEY"),
        "LEADOS_API_KEY": prod.get("INGEST_API_KEY"),
        "LEADOS_GH_PAT": token,
    }

    st, body = api(token, "GET", f"/repos/{REPO}/actions/secrets/public-key")
    if st != 200:
        sys.exit(f"public-key fetch failed: {st} {body[:200]}")
    pk_data = json.loads(body)
    key_id = pk_data["key_id"]
    pk = public.PublicKey(pk_data["key"].encode(), encoding.Base64Encoder())
    sealed = public.SealedBox(pk)

    results = {}
    for name, value in wanted.items():
        if not value:
            results[name] = "SKIP (no local value)"
            continue
        enc = base64.b64encode(sealed.encrypt(value.encode())).decode()
        st, body = api(
            token,
            "PUT",
            f"/repos/{REPO}/actions/secrets/{name}",
            {"encrypted_value": enc, "key_id": key_id},
        )
        results[name] = f"HTTP {st} {'OK' if st in (201, 204) else body[:120]}"

    for name, status in results.items():
        print(f"{name}: {status}")


if __name__ == "__main__":
    main()
