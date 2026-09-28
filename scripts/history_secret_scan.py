#!/usr/bin/env python3
"""Task 11 v2 — Fast history scan: parse git cat-file --batch by exact byte counts."""
import re
import subprocess
import sys
from collections import defaultdict

REPO = sys.argv[1] if len(sys.argv) > 1 else "/home/z/my-project"

VALUE_PATTERNS = {
    "vercel_vcp": re.compile(rb"vcp_[A-Za-z0-9]{20,}"),
    "neon_napi": re.compile(rb"napi_[A-Za-z0-9_\-]{20,}"),
    "github_pat": re.compile(rb"ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"),
    "sk_style": re.compile(rb"sk-[A-Za-z0-9_\-]{20,}"),
    "nvidia": re.compile(rb"nvapi-[A-Za-z0-9_\-]{20,}"),
    "postgres_url": re.compile(rb"postgres(ql)?://[^\s\"'<>]+:[^\s\"'<>]+@[^\s\"'<>]+"),
    "cron_secret": re.compile(rb"leados-alt-[0-9a-f]{8,}"),
    "long_hex": re.compile(rb"\b[a-f0-9]{40,}\b"),
    "jwt": re.compile(rb"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
    "cookie_json": re.compile(rb'"(sessionid|xs|c_user|datr)"\s*:'),
}


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=REPO, capture_output=True, check=True, **kw).stdout


def main():
    out = run(["git", "rev-list", "--all", "--objects"])
    path_hits = {}
    blob_shas = []
    for line in out.decode("utf-8", "replace").splitlines():
        parts = line.split(" ", 1)
        if len(parts) != 2:
            continue
        sha, path = parts
        blob_shas.append(sha)
        if re.search(
            r"(^|/)\.env($|\.)|token|secret|cookie|credential|\.pem$|\.db$|\.sqlite|backups/|logs/|upload/|^\.secrets|\.zscripts/|dev\.pid$|session|\.vercel/|api\.txt",
            path, re.IGNORECASE,
        ):
            path_hits.setdefault(path, 0)
            path_hits[path] += 1

    print("=" * 70)
    print(f"PATHS EVER COMMITTED MATCHING SECRET PATTERNS ({len(path_hits)}):")
    for p in sorted(path_hits):
        print(f"  {p}")

    # Dedupe blobs
    uniq = sorted(set(blob_shas))
    print("=" * 70)
    print(f"SCANNING {len(uniq)} UNIQUE BLOBS ...")

    proc = subprocess.Popen(
        ["git", "cat-file", "--batch"], cwd=REPO,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    payload = "".join(sha + "\n" for sha in uniq).encode()
    outb, _ = proc.communicate(payload)

    hits = defaultdict(set)
    samples = defaultdict(list)
    scanned = 0
    pos = 0
    n = len(outb)
    while pos < n:
        nl = outb.find(b"\n", pos)
        if nl == -1:
            break
        header = outb[pos:nl]
        parts = header.split(b" ")
        if len(parts) != 3:
            pos = nl + 1
            continue
        sha, _typ, size = parts[0].decode(), parts[1].decode(), int(parts[2])
        start = nl + 1
        content = outb[start:start + size]
        for name, pat in VALUE_PATTERNS.items():
            m = pat.search(content)
            if m:
                hits[name].add(sha)
                if len(samples[name]) < 3:
                    samples[name].append(m.group(0)[:10].decode("utf-8", "replace") + "…")
        scanned += 1
        pos = start + size + 1  # skip trailing newline after blob content

    print(f"SCANNED {scanned} blobs")
    print("=" * 70)
    if not hits:
        print("CLEAN: no secret values in any historical blob")
    else:
        print("SECRET VALUE HITS:")
        for name, shas in sorted(hits.items()):
            print(f"  WARNING {name}: {len(shas)} blobs — sample: {samples[name]}")
        # map blobs -> paths
        wanted = {s for shas in hits.values() for s in shas}
        by_path = defaultdict(int)
        for line in out.decode("utf-8", "replace").splitlines():
            parts = line.split(" ", 1)
            if len(parts) == 2 and parts[0] in wanted:
                by_path[parts[1]] += 1
        print("=" * 70)
        print("SECRET BLOBS LIVE AT THESE PATHS:")
        for p, cnt in sorted(by_path.items(), key=lambda x: -x[1])[:60]:
            print(f"  {p} ({cnt})")


if __name__ == "__main__":
    sys.exit(main())
