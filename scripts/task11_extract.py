#!/usr/bin/env python3
"""Task 11 — extract REAL secret values from git history -> replacements.txt
Writes /home/z/my-project/backup/replacements.txt (local only, deleted after rewrite).
Values are NEVER printed."""
import re
import subprocess
import sys
from pathlib import Path

REPO = "/home/z/my-project"
OUT = Path("/home/z/my-project/backup/replacements.txt")

PATTERNS = [
    re.compile(rb"vcp_[A-Za-z0-9]{20,}"),
    re.compile(rb"napi_[A-Za-z0-9_\-]{20,}"),
    re.compile(rb"ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}"),
    re.compile(rb"nvapi-[A-Za-z0-9_\-]{20,}"),
    re.compile(rb"postgres(ql)?://[^\s\"'<>]+:[^\s\"'<>]+@[^\s\"'<>]+"),
    re.compile(rb"leados-alt-[0-9a-f]{8,}|leados-tick-[0-9a-f]{8,}"),
    re.compile(rb"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
    re.compile(rb"\b[a-f0-9]{40,}\b"),  # filtered below (lockfile hashes / object shas)
]

BENIGN_KNOWN = {
    b"c2990dca591cba766e3b7ef5d9e8a84796e47ab7",  # bun.lock / package-lock.json hash
    b"0816c9201ecc2e31cc43c4014d5f7c3d76047317642f62cad4df3e0402389794",  # zenrows html (purged anyway)
    b"4cc8b56eccec67e70a611a84351b148e821147c31bfad693ffbe1f2221e6c062",
    b"64150370145c18f563fbc652c8d8bf273c4943d2a9f2039ddd51af9fd08d96f3",  # skills-lock hashes
    b"cd40530aa01dce7af2b9b77afb5d9452b13c3d6d1b6690af8b38605f17d1eeaf",
}


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=REPO, capture_output=True, check=True, **kw).stdout


def main():
    out = run(["git", "rev-list", "--all", "--objects"])
    blob_shas = sorted({line.split(" ", 1)[0] for line in out.decode().splitlines() if " " in line})

    proc = subprocess.Popen(
        ["git", "cat-file", "--batch"], cwd=REPO,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    payload = "".join(s + "\n" for s in blob_shas).encode()
    outb, _ = proc.communicate(payload)

    values = set()
    pos, n = 0, len(outb)
    while pos < n:
        nl = outb.find(b"\n", pos)
        if nl == -1:
            break
        parts = outb[pos:nl].split(b" ")
        if len(parts) != 3:
            pos = nl + 1
            continue
        size = int(parts[2])
        start = nl + 1
        content = outb[start:start + size]
        for pat in PATTERNS:
            for m in pat.finditer(content):
                values.add(m.group(0))
        pos = start + size + 1

    # filter benign hexes: known set + anything that resolves to a real git object (commit-ish refs in text)
    filtered = set()
    for v in values:
        if len(v) >= 40 and re.fullmatch(rb"[a-f0-9]+", v):
            if v in BENIGN_KNOWN:
                continue
            t = subprocess.run(["git", "cat-file", "-t", v.decode()], cwd=REPO,
                               capture_output=True)
            if t.returncode == 0:
                continue  # it's a real git object sha referenced in text — not a secret
        filtered.add(v)

    OUT.write_text(b"".join(v + b"==>" + b"***REMOVED***\n" for v in sorted(filtered)).decode())
    print(f"extracted {len(filtered)} secret values -> {OUT} (contents hidden)")


if __name__ == "__main__":
    sys.exit(main())
