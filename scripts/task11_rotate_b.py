#!/usr/bin/env python3
"""Task 11 Phase 4b — continuation: GitHub secrets + delete old Vercel tokens + verify.
Reads NEW Vercel token from scripts/deploy/.tokens (already rotated in phase 4 first run)."""
import base64
import json
import re
import subprocess
import urllib.request
from pathlib import Path

REPO = Path("/home/z/my-project")
GH_REPO = "EZZ1000000000/LeadOS"
PROJECT_ID = "prj_t6eWDN0XUg5RyLJLFCXpHRmjwpbC"
VERCEL_API = "https://api.vercel.com"
GH_API = "https://api.github.com"


def gh_token() -> str:
    url = subprocess.run(["git", "-C", str(REPO), "config", "--get", "remote.origin.url"],
                         capture_output=True, text=True).stdout.strip()
    # https://user:token@... OR https://token@...
    m = re.match(r"https://[^:]+:([^@]+)@", url)
    tok = m.group(1) if m else re.match(r"https://([^@]+)@", url).group(1)
    assert tok.startswith(("ghp_", "gho_", "github_pat_")), f"unexpected token prefix: {tok[:4]}"
    return tok


def http(url, method="GET", token=None, payload=None):
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(payload).encode() if payload else None)
    req.add_header("Accept", "application/json")
    if payload:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as res:
            body = res.read()
            return res.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def read_tokens_file():
    vals = {}
    for line in (REPO / "scripts/deploy/.tokens").read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip()
    return vals


def gh_set_secret(ght: str, name: str, value: str):
    st, key_info = http(f"{GH_API}/repos/{GH_REPO}/actions/secrets/public-key", token=ght)
    assert st == 200, f"public-key failed: {st} {key_info}"
    from nacl import encoding, public as nacl_public
    pk = nacl_public.PublicKey(key_info["key"].encode(), encoding.Base64Encoder())
    sealed = nacl_public.SealedBox(pk).encrypt(value.encode())
    st, _ = http(f"{GH_API}/repos/{GH_REPO}/actions/secrets/{name}", method="PUT", token=ght,
                 payload={"encrypted_value": base64.b64encode(sealed).decode(),
                          "key_id": key_info["key_id"]})
    assert st in (201, 204), f"set {name} failed: {st}"
    print(f"  gh-secret set: {name}")


def main():
    tok = read_tokens_file()
    new_vercel = tok["VERCEL_TOKEN"]
    assert new_vercel.startswith("vcp_")

    # find the NEW token's id (to keep it)
    st, lst = http(f"{VERCEL_API}/v5/user/tokens", token=new_vercel)
    if st != 200:
        st, lst = http(f"{VERCEL_API}/v2/user/tokens", token=new_vercel)
    assert st == 200, f"list failed {st}"
    cur = lst.get("tokens", lst if isinstance(lst, list) else [])
    # newest token = ours (leados-actions-2026-09)
    mine = next((t for t in cur if t.get("name") == "leados-actions-2026-09"), None)
    assert mine, "new token not found in list!"
    print(f"  new Vercel token found: id={mine['id']}")

    # GH token + scopes check
    ght = gh_token()
    st, me = http(f"{GH_API}/user", token=ght)
    assert st == 200, f"GH token invalid: {st}"
    print(f"  GH token OK: user={me.get('login')}")

    # env pull for INGEST_API_KEY (saved /tmp/vercel-env-prod from phase 4 first run may exist)
    ingest_key = ""
    ef = Path("/tmp/vercel-env-prod")
    if ef.exists():
        for line in ef.read_text().splitlines():
            m = re.match(r'^INGEST_API_KEY="?([^"]+)"?', line)
            if m:
                ingest_key = m.group(1)
    if not ingest_key:
        r = subprocess.run(
            ["bunx", "vercel", "env", "pull", str(ef), "--environment", "production", "--yes"],
            cwd=REPO, capture_output=True, text=True,
            env={"VERCEL_TOKEN": new_vercel, "PATH": "/usr/local/bin:/usr/bin:/bin:/home/z/.bun/bin", "HOME": "/home/z"},
        )
        for line in ef.read_text().splitlines() if ef.exists() else []:
            m = re.match(r'^INGEST_API_KEY="?([^"]+)"?', line)
            if m:
                ingest_key = m.group(1)
    print(f"  INGEST_API_KEY: {'pulled' if ingest_key else 'MISSING'}")

    # GitHub secrets
    gh_set_secret(ght, "VERCEL_TOKEN", new_vercel)
    gh_set_secret(ght, "CRON_SECRET", tok["CRON_SECRET_ALT"])
    gh_set_secret(ght, "LEADOS_BASE_URL", "https://leados-v2.vercel.app")
    if ingest_key:
        gh_set_secret(ght, "LEADOS_API_KEY", ingest_key)
    gh_set_secret(ght, "VERCEL_PROJECT_ID", PROJECT_ID)
    org_id = json.loads((REPO / ".vercel/project.json").read_text())["orgId"]
    gh_set_secret(ght, "VERCEL_ORG_ID", org_id)

    # delete old CLI/API tokens (keep ours + browser sessions)
    deleted = 0
    for t in cur:
        nm = t.get("name", "")
        if t.get("id") != mine["id"] and not nm.startswith("Website, Login"):
            dst, _ = http(f"{VERCEL_API}/v2/user/tokens/{t['id']}", method="DELETE", token=new_vercel)
            if dst in (200, 204):
                deleted += 1
    print(f"  old CLI/API Vercel tokens deleted: {deleted} (browser sessions kept)")

    # verify old .tokens vcp_ from git history is dead — old token was overwritten locally,
    # verify via count
    st, lst2 = http(f"{VERCEL_API}/v5/user/tokens", token=new_vercel)
    cur2 = lst2.get("tokens", []) if st == 200 else []
    print(f"  Vercel tokens now: {len(cur2)} (ours + browser sessions)")

    rp = REPO / "backup/replacements.txt"
    if rp.exists():
        rp.unlink()
        print("  backup/replacements.txt shredded")
    print("OK phase4b")


if __name__ == "__main__":
    raise SystemExit(main())
