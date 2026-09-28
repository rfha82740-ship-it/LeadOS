#!/bin/bash
# Task 11 — Phase 3: rewrite history (purge secret paths + replace secret values) + force push
set -euo pipefail
REPO=/home/z/my-project
CLONE=$REPO/backup/clean-clone
cd "$REPO"

echo "[1/7] ensure git-filter-repo ..."
python3 -m pip install -q git-filter-repo 2>/dev/null || pip install -q git-filter-repo
command -v git-filter-repo >/dev/null || python3 -m pip show git-filter-repo >/dev/null

echo "[2/7] fresh clone for surgery ..."
rm -rf "$CLONE"
git clone --no-local -q "$REPO" "$CLONE"
cd "$CLONE"
echo "  commits before: $(git rev-list --all --count)"

echo "[3/7] run git-filter-repo (invert-paths + replace-text) ..."
git filter-repo --force \
  --invert-paths \
  --path .env.local \
  --path .env.example \
  --path .secrets-local/ \
  --path scripts/deploy/.tokens \
  --path scripts/deploy/.tokens.template \
  --path config/fb-session-cookies.json \
  --path config/whatsapp-web-cookies.json \
  --path scripts/new-fb-cookies.json \
  --path db/backups/ \
  --path logs/ \
  --path .zscripts/dev.pid \
  --path scripts/tick-loop.sh \
  --path scripts/set-vercel-env.sh \
  --path scripts/zenrows-google-ok.html \
  --replace-text "$REPO/backup/replacements.txt"

echo "  commits after:  $(git rev-list --all --count)"
echo "[4/7] sanity: secret paths left in history? ..."
LEFT=$(git log --all --diff-filter=A --name-only --format= | sort -u | rg -c '^\.env\.local$|tokens$|cookies|backups/' || true)
echo "  remaining secret-path blobs: ${LEFT:-0}"

echo "[5/7] re-add origin (token from main repo config) and force push ..."
URL=$(git config --file "$REPO/.git/config" --get remote.origin.url)
git remote add origin "$URL"
git push --force -q origin main
echo "  pushed rewritten main"

echo "[6/7] main repo: align to rewritten history (secret files on disk are untracked → safe) ..."
cd "$REPO"
git fetch origin
git reset --hard -q origin/main
git reflog expire --expire=now --all && git gc --prune=now --aggressive -q

echo "[7/7] verify: secret files still on disk + git clean ..."
for f in .env.local scripts/deploy/.tokens config/fb-session-cookies.json config/whatsapp-web-cookies.json .secrets-local/deploy-tokens; do
  [ -e "$f" ] && echo "  on disk ✓ $f" || echo "  MISSING ✗ $f"
done
echo "  commits now: $(git rev-list --all --count)"
git log --oneline -3
echo "OK phase3"
