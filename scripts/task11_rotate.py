#!/usr/bin/env python3
"""Task 11 Phase 4 — rotations & GitHub secrets fill (values NEVER printed).
1. Create NEW Vercel token -> update local .tokens + GitHub secret VERCEL_TOKEN
2. Delete all OLD Vercel tokens (they were in git history)
3. Rotate cron secret -> Vercel env CRON_SECRET_ALT + GitHub CRON_SECRET + .env.local
4. Fill missing GitHub secrets: LEADOS_BASE_URL, LEADOS_API_KEY (INGEST_API_KEY),
   VERCEL_ORG_ID, VERCEL_PROJECT_ID
"""
import base64
import json
import re
import secrets as pysecrets
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path("/home/z/my-project")
GH_REPO = "EZZ1000000000/LeadOS"
PROJECT_ID = "prj_t6eWDN0XUg5RyLJLFCXpHRmjwpbC"

VERCEL_API = "https://api.vercel.com"
GH_API = "https://api.github.com"


def http(url, method="GET", token=None, payload=None, headers=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(payload).encode() if payload else None)
    req.add_header("Accept", "application/json")
    if payload:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
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


def write_tokens_file(vals: dict):
    p = REPO / "scripts/deploy/.tokens"
    lines = p.read_text().splitlines()
    out = []
    for line in lines:
        m = re.match(r"^([A-Z_]+)=", line)
        if m and m.group(1) in vals:
            out.append(f"{m.group(1)}={vals[m.group(1)]}")
        else:
            out.append(line)
    p.write_text("\n".join(out) + "\n")


def gh_set_secret(name: str, value: str):
    ght = Path("/tmp/gh_token").read_text().strip()
    st, key_info = http(f"{GH_API}/repos/{GH_REPO}/actions/secrets/public-key", token=ght)
    assert st == 200, f"public-key failed: {st}"
    from nacl import encoding, public as nacl_public
    pk = nacl_public.PublicKey(key_info["key"].encode(), encoding.Base64Encoder())
    sealed = nacl_public.SealedBox(pk).encrypt(value.encode())
    st, _ = http(
        f"{GH_API}/repos/{GH_REPO}/actions/secrets/{name}", method="PUT", token=ght,
        payload={"encrypted_value": base64.b64encode(sealed).decode(), "key_id": key_info["key_id"]},
    )
    assert st in (201, 204), f"set {name} failed: {st}"
    print(f"  gh-secret set: {name}")


def main():
    tok = read_tokens_file()
    old_vercel = tok["VERCEL_TOKEN"]
    assert old_vercel.startswith("vcp_")

    # --- 1) list + create Vercel token
    st, lst = http(f"{VERCEL_API}/v5/user/tokens", token=old_vercel)
    if st != 200:
        st, lst = http(f"{VERCEL_API}/v2/user/tokens", token=old_vercel)
    assert st == 200, f"list tokens failed: {st} {lst}"
    old_list = lst.get("tokens", lst if isinstance(lst, list) else [])
    print(f"  existing Vercel tokens: {len(old_list)} -> {[t.get('name','?') for t in old_list]}")

    st, created = http(f"{VERCEL_API}/v2/user/tokens", method="POST", token=old_vercel,
                       payload={"name": "leados-actions-2026-09"})
    assert st in (200, 201), f"create token failed: {st} {created}"
    new_tok_obj = created.get("token", created)
    new_vercel = new_tok_obj.get("token") or new_tok_obj.get("value")
    assert new_vercel and new_vercel.startswith("vcp_"), f"unexpected create response keys: {list(created)}"
    print(f"  NEW Vercel token created (id={new_tok_obj.get('id')}, name={new_tok_obj.get('name')})")

    # --- 2) rotate cron secret
    new_cron = "leados-alt-" + pysecrets.token_hex(16)

    # Vercel env: find CRON_SECRET_ALT
    st, envs = http(f"{VERCEL_API}/v9/projects/{PROJECT_ID}/env", token=old_vercel)
    assert st == 200, f"env list failed: {st}"
    env_list = envs.get("envs", [])
    names = [e["key"] for e in env_list]
    print(f"  Vercel env keys: {len(names)} (has CRON_SECRET_ALT={'CRON_SECRET_ALT' in names}, "
          f"has INGEST_API_KEY={'INGEST_API_KEY' in names})")

    cron_env = next((e for e in env_list if e["key"] == "CRON_SECRET_ALT"), None)
    if cron_env:
        st, _ = http(f"{VERCEL_API}/v9/projects/{PROJECT_ID}/env/{cron_env['id']}?upsert=true",
                     method="PATCH", token=old_vercel,
                     payload={"key": "CRON_SECRET_ALT", "value": new_cron,
                              "type": "encrypted", "target": ["production", "preview"]})
        assert st in (200, 201), f"patch CRON_SECRET_ALT failed: {st}"
    else:
        st, _ = http(f"{VERCEL_API}/v10/projects/{PROJECT_ID}/env", method="POST", token=old_vercel,
                     payload={"key": "CRON_SECRET_ALT", "value": new_cron,
                              "type": "encrypted", "target": ["production", "preview"]})
        assert st in (200, 201), f"create CRON_SECRET_ALT failed: {st}"
    print("  Vercel env CRON_SECRET_ALT rotated")

    # --- 3) pull INGEST_API_KEY value via vercel env pull (values not readable via API list)
    envfile = Path("/tmp/vercel-env-prod")
    r = subprocess.run(
        ["bunx", "vercel", "env", "pull", str(envfile), "--environment", "production", "--yes"],
        cwd=REPO, capture_output=True, text=True,
        env={"VERCEL_TOKEN": new_vercel, "PATH": "/usr/local/bin:/usr/bin:/bin:/home/z/.bun/bin", "HOME": "/home/z"},
    )
    ingest_key = ""
    if envfile.exists():
        for line in envfile.read_text().splitlines():
            m = re.match(r"^INGEST_API_KEY=\"?([^\"]+)\"?", line)
            if m:
                ingest_key = m.group(1)
    print(f"  INGEST_API_KEY pulled: {'yes' if ingest_key else 'NOT SET in production!'}")

    # --- 4) local files update (.tokens + .env.local) — in place, never printed
    write_tokens_file({"VERCEL_TOKEN": new_vercel, "CRON_SECRET_ALT": new_cron})
    env_local = REPO / ".env.local"
    txt = env_local.read_text()
    if re.search(r"^CRON_SECRET_ALT=.*$", txt, re.M):
        txt = re.sub(r"^CRON_SECRET_ALT=.*$", f"CRON_SECRET_ALT={new_cron}", txt, flags=re.M)
    else:
        txt += f"\nCRON_SECRET_ALT={new_cron}\n"
    env_local.write_text(txt)
    print("  local .tokens + .env.local updated")

    # --- 5) GitHub secrets
    import importlib.util
    if importlib.util.find_spec("nacl") is None:
        subprocess.run(["pip", "install", "--break-system-packages", "-q", "pynacl"], check=True)
    gh_set_secret("VERCEL_TOKEN", new_vercel)
    gh_set_secret("CRON_SECRET", new_cron)
    gh_set_secret("LEADOS_BASE_URL", "https://leados-v2.vercel.app")
    if ingest_key:
        gh_set_secret("LEADOS_API_KEY", ingest_key)
    gh_set_secret("VERCEL_PROJECT_ID", PROJECT_ID)
    org_id = json.loads((REPO / ".vercel/project.json").read_text())["orgId"]
    gh_set_secret("VERCEL_ORG_ID", org_id)

    # --- 6) delete ALL old Vercel tokens (auth with NEW token)
    st, lst2 = http(f"{VERCEL_API}/v5/user/tokens", token=new_vercel)
    if st != 200:
        st, lst2 = http(f"{VERCEL_API}/v2/user/tokens", token=new_vercel)
    assert st == 200
    cur = lst2.get("tokens", lst2 if isinstance(lst2, list) else [])
    deleted = 0
    for t in cur:
        nm = t.get("name", "")
        if t.get("id") != new_tok_obj.get("id") and not nm.startswith("Website, Login"):
            dst, _ = http(f"{VERCEL_API}/v2/user/tokens/{t['id']}", method="DELETE", token=new_vercel)
            if dst in (200, 204):
                deleted += 1
    print(f"  old CLI/API Vercel tokens deleted: {deleted} (browser sessions kept)")

    # --- 7) verify: new token works, old is dead
    st_new, _ = http(f"{VERCEL_API}/v2/user", token=new_vercel)
    st_old, _ = http(f"{VERCEL_API}/v2/user", token=old_vercel)
    print(f"  verify: NEW token {st_new==200 and 'WORKS' or 'FAIL'} / OLD token {st_old==403 and 'DEAD(correct)' or st_old}")

    # cleanup plaintext replacement file (secrets inside)
    rp = REPO / "backup/replacements.txt"
    if rp.exists():
        rp.unlink()
        print("  backup/replacements.txt shredded")

    print("OK phase4")


if __name__ == "__main__":
    sys.exit(main())
