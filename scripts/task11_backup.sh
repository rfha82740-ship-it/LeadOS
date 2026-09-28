#!/bin/bash
# Task 11 — Phase 1: Full backup before history rewrite
# bundle = whole git history (with secrets, stays LOCAL forever)
# tar    = all secret files currently on disk (safety net)
set -euo pipefail
REPO=/home/z/my-project
BK=$REPO/backup
mkdir -p "$BK"
cd "$REPO"

echo "[1/3] git bundle (all refs) ..."
git bundle create "$BK/leados-pre-public.bundle" --all
git bundle verify "$BK/leados-pre-public.bundle" 2>&1 | tail -2

echo "[2/3] tar of secret files on disk ..."
tar czf "$BK/secrets-files-backup.tar.gz" \
  .env.local .env.example \
  scripts/deploy/.tokens scripts/deploy/.tokens.template \
  .secrets-local \
  config/fb-session-cookies.json config/whatsapp-web-cookies.json \
  scripts/new-fb-cookies.json \
  db/backups logs 2>/dev/null || true
ls -la "$BK"

echo "[3/3] done."
