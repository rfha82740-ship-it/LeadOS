#!/bin/bash
# Task 11 — Phase 2: untrack secrets + clean .env.example + .gitignore + commit + push
set -euo pipefail
REPO=/home/z/my-project
cd "$REPO"

echo "[1/5] untrack secret paths (files stay on disk) ..."
git rm -r --cached -q \
  .env.local .env.example .secrets-local \
  scripts/deploy/.tokens scripts/deploy/.tokens.template \
  config/fb-session-cookies.json config/whatsapp-web-cookies.json \
  scripts/new-fb-cookies.json \
  db/backups logs \
  .zscripts/dev.pid \
  scripts/tick-loop.sh scripts/set-vercel-env.sh \
  scripts/zenrows-google-ok.html

echo "[2/5] regenerate clean .env.example (placeholders only) ..."
python3 - <<'PY'
import re
from pathlib import Path
src = Path("/home/z/my-project/.env.example")
out_lines = []
for line in src.read_text(encoding="utf-8", errors="replace").splitlines():
    # active KEY=VALUE -> strip value
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
    if m and m.group(2).strip():
        out_lines.append(f"{m.group(1)}=")
        continue
    # commented KEY=value with long values -> strip value (keep comment marker)
    m2 = re.match(r"^(\s*#\s*[A-Za-z_][A-Za-z0-9_]*=)(.+)$", line)
    if m2 and len(m2.group(2).strip()) >= 6 and not m2.group(2).strip().startswith(("http", "«")):
        val = m2.group(2)
        # keep URLs (docs), strip credential-looking values
        if re.search(r"[A-Za-z0-9+/=_\-]{20,}", val) and "http" not in val:
            out_lines.append(m2.group(1))
            continue
    out_lines.append(line)
src.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
print("  .env.example sanitized: active values emptied")
PY

echo "[3/5] harden .gitignore ..."
cat >> .gitignore <<'EOF'

# ── Task 11: private data — never track again (repo is public) ──
backup/
upload/
logs/
db/backups/
.secrets-local/
config/*cookies*.json
scripts/*cookies*.json
scripts/deploy/.tokens*
scripts/tick-loop.sh
scripts/set-vercel-env.sh
scripts/zenrows-*.html
*.pid
*.bundle
*.tar.gz
EOF

echo "[4/5] commit ..."
git add .gitignore .env.example
git commit -q -m "chore(security): untrack secrets & private data — repo going public

- .env.local, .env.example (regenerated clean), .secrets-local/
- scripts/deploy/.tokens*, deploy/tick scripts, cached HTML
- session cookies (config/ + scripts/), db/backups, logs, pid files
- .gitignore hardened so none of these can ever be tracked again
Files remain on disk locally. History rewrite follows in next commit."

echo "[5/5] push ..."
git push origin main
git log --oneline -2
echo "OK phase2"
