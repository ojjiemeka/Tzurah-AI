#!/usr/bin/env bash
set -euo pipefail

# ================================================================
#  git-update.sh - Push only deploy-safe Tzurah server files/docs
#
#  Windows PowerShell:
#    & "C:\Program Files\Git\bin\bash.exe" .\git-update.sh "commit message"
#
#  Dry run:
#    & "C:\Program Files\Git\bin\bash.exe" .\git-update.sh --dry-run
#
#  File boundary:
#    ONLY these files may be copied, staged, committed, or pushed:
#      - gcp-server.js
#      - admin.html
#      - admin-login.html
#      - git-update.sh
#      - AGENT.md
#      - BRAIN.md
#      - COMPONENTS.md
#      - PHASE7A_SOAK_TEST.md
# ================================================================

DEPLOY_DIR="../tzurah-server-deploy"
DEPLOY_SAFE_FILES=(
  "gcp-server.js"
  "admin.html"
  "admin-login.html"
  "git-update.sh"
  "AGENT.md"
  "BRAIN.md"
  "COMPONENTS.md"
  "PHASE7A_SOAK_TEST.md"
)

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

MSG=${1:-"auto: update deploy-safe server files $(date '+%H:%M')"}

echo "Tzurah deploy sync"
echo "Deploy directory: $DEPLOY_DIR"
echo "Mode: $([[ "$DRY_RUN" == "1" ]] && echo "dry run" || echo "commit + push")"
echo

# Guard: run from the project root.
if [[ ! -f "gcp-server.js" || ! -f "admin.html" || ! -f "admin-login.html" ]]; then
  echo "ERROR: Run from the RTDF-Decart project folder."
  exit 1
fi

if [[ ! -d "$DEPLOY_DIR/.git" ]]; then
  echo "ERROR: Deploy folder missing. Expected: $DEPLOY_DIR/.git"
  echo "Run update-github.sh first if the deploy checkout has not been created."
  exit 1
fi

SOURCE_ROOT=$(pwd -P)
TARGET_ROOT=$(cd "$DEPLOY_DIR" && pwd -P)
IN_PLACE=0
if [[ "$SOURCE_ROOT" == "$TARGET_ROOT" ]]; then
  IN_PLACE=1
  echo "In-place deploy repo detected; using the current checkout as source and target."
  echo
fi

echo "Whitelisted files:"
for file in "${DEPLOY_SAFE_FILES[@]}"; do
  echo "  - $file"
done
echo

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: skipping git pull."
else
  echo "Pulling latest deploy repo..."
  git -C "$DEPLOY_DIR" pull origin main --rebase --quiet
fi

echo "Copying deploy-safe files:"
for file in "${DEPLOY_SAFE_FILES[@]}"; do
  if [[ "$IN_PLACE" == "1" ]]; then
    echo "  in-place $file -> $file"
    continue
  fi
  echo "  copy $file -> $DEPLOY_DIR/$file"
  cp "$file" "$DEPLOY_DIR/$file"
done
echo

cd "$DEPLOY_DIR"

# Clear only staged changes so this script owns the index state it validates.
git reset --quiet

echo "Staging deploy-safe files:"
for file in "${DEPLOY_SAFE_FILES[@]}"; do
  echo "  stage $file"
  git add -- "$file"
done
echo

STAGED_FILES=$(git diff --cached --name-only)

if [[ -z "$STAGED_FILES" ]]; then
  echo "No deploy-safe changes to commit."
  exit 0
fi

echo "Staged files:"
echo "$STAGED_FILES" | sed 's/^/  - /'
echo

WHITELIST_PATTERN="^(gcp-server\.js|admin\.html|admin-login\.html|git-update\.sh|AGENT\.md|BRAIN\.md|COMPONENTS\.md|PHASE7A_SOAK_TEST\.md)$"
BAD_FILES=$(echo "$STAGED_FILES" | grep -Ev "$WHITELIST_PATTERN" || true)
if [[ -n "$BAD_FILES" ]]; then
  echo "ERROR: Refusing to commit files outside the deploy-safe whitelist:"
  echo "$BAD_FILES" | sed 's/^/  - /'
  git reset --quiet
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run passed. Nothing committed or pushed."
  git reset --quiet
  exit 0
fi

git commit -m "$MSG" --quiet

if git push origin main --quiet; then
  echo "Pushed: $MSG"
  echo "VM: cd ~/tzurah-server && git pull && pm2 restart tzurah-server"
else
  echo "ERROR: Push failed. Check git credentials/network."
  exit 1
fi
