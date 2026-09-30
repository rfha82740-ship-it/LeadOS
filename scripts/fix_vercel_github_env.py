#!/usr/bin/env python3
"""إصلاح GITHUB_TOKEN/GITHUB_REPO على Vercel production — كي الحساب الجديد."""
import json
import sys
import urllib.request
from pathlib import Path

VT = (Path.home() / ".vercel_token").read_text().strip()
TEAM = "team_Mj6Wa8s6k12NshbngshHQJqP"
PROJ = "leados-v2"
REPO = "rfha82740-ship-it/LeadOS"
GH_TOKEN = (Path.home() / ".git-credentials").read_text().strip().split("://", 1)[1].split("@", 1)[0].split(":", 1)[1]


def api(method: str, url: str, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {VT}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
            return r.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def main() -> int:
    ok = True
    # GITHUB_REPO — مش سر، نص صريح
    st, out = api("POST",
                  f"https://api.vercel.com/v9/projects/{PROJ}/env?teamId={TEAM}",
                  {"key": "GITHUB_REPO", "value": REPO, "type": "plain", "target": ["production"]})
    print(f"POST GITHUB_REPO -> {st}")
    ok &= st in (200, 201)

    # GITHUB_TOKEN — sensitive
    st, out = api("POST",
                  f"https://api.vercel.com/v9/projects/{PROJ}/env?teamId={TEAM}",
                  {"key": "GITHUB_TOKEN", "value": GH_TOKEN, "type": "sensitive", "target": ["production"]})
    print(f"POST GITHUB_TOKEN -> {st}")
    ok &= st in (200, 201)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
