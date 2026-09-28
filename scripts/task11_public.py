#!/usr/bin/env python3
"""Task 11 Phase 5 — flip LeadOS to PUBLIC + anonymous verification."""
import json
import re
import subprocess
import urllib.request
from pathlib import Path

REPO = Path("/home/z/my-project")
GH_REPO = "EZZ1000000000/LeadOS"
GH_API = "https://api.github.com"


def gh_token() -> str:
    url = subprocess.run(["git", "-C", str(REPO), "config", "--get", "remote.origin.url"],
                         capture_output=True, text=True).stdout.strip()
    m = re.match(r"https://[^:]+:([^@]+)@", url)
    return m.group(1) if m else re.match(r"https://([^@]+)@", url).group(1)


def http(url, method="GET", token=None, payload=None, anon=False):
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(payload).encode() if payload else None)
    req.add_header("Accept", "application/vnd.github+json")
    if payload:
        req.add_header("Content-Type", "application/json")
    if token and not anon:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as res:
            body = res.read()
            return res.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main():
    tok = gh_token()

    st, repo = http(f"{GH_API}/repos/{GH_REPO}", token=tok)
    print(f"before: private={repo.get('private')}")
    assert repo.get("private") is True

    st, _ = http(f"{GH_API}/repos/{GH_REPO}", method="PATCH", token=tok, payload={"private": False})
    print(f"PATCH status: {st}")
    st, repo2 = http(f"{GH_API}/repos/{GH_REPO}", token=tok)
    print(f"after:  private={repo2.get('private')} visibility={repo2.get('visibility')}")
    assert repo2.get("private") is False

    # anonymous web page check
    st, _ = http(f"https://github.com/{GH_REPO}", anon=True)
    print(f"anonymous web page: {st}")

    # anonymous clone + deep scan
    vc = REPO / "backup/verify-clone"
    subprocess.run(["rm", "-rf", str(vc)], check=True)
    r = subprocess.run(["git", "clone", "-q", f"https://github.com/{GH_REPO}.git", str(vc)],
                       capture_output=True, text=True)
    print(f"anonymous git clone: {'OK' if r.returncode == 0 else 'FAIL ' + r.stderr[:200]}")

    if r.returncode == 0:
        scan = subprocess.run(["python3", str(REPO / "scripts/history_secret_scan.py"), str(vc)],
                              capture_output=True, text=True).stdout
        val = scan.split("SECRET VALUE HITS:")[1].split("====")[0].strip() if "SECRET VALUE HITS" in scan else "?"
        print("--- anonymous clone scan (value hits) ---")
        print(val if val else "CLEAN")

    print("OK phase5")


if __name__ == "__main__":
    raise SystemExit(main())
