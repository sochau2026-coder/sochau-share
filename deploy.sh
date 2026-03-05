#!/bin/bash
# ─────────────────────────────────────────────
# Sochau Share — Auto Deploy Script
# Triggered by GitHub webhook on every push to main
# ─────────────────────────────────────────────
set -e

REPO_DIR="/opt/sochau-share"
WEB_DIR="/www/wwwroot/share.sochau.cloud"
COMPOSE_FILE="$REPO_DIR/docker-compose.prod.yml"
LOG_FILE="/var/log/sochau-deploy.log"

echo "" >> $LOG_FILE
echo "=== Deploy started: $(date) ===" >> $LOG_FILE

# Pull latest code from GitHub
cd $REPO_DIR
git pull origin main >> $LOG_FILE 2>&1

# Copy updated frontend files to web root
cp $REPO_DIR/frontend/index.html $WEB_DIR/
cp $REPO_DIR/frontend/style.css  $WEB_DIR/
cp $REPO_DIR/frontend/app.js     $WEB_DIR/
cp $REPO_DIR/frontend/whiteboard.js $WEB_DIR/
echo "Frontend files updated" >> $LOG_FILE

# Rebuild and restart backend only if server.js or package.json changed
CHANGED=$(git diff HEAD~1 --name-only 2>/dev/null || echo "")
if echo "$CHANGED" | grep -qE "backend/server\.js|backend/package\.json|backend/Dockerfile"; then
  echo "Backend changed — rebuilding Docker container..." >> $LOG_FILE
  docker compose -f $COMPOSE_FILE up -d --build >> $LOG_FILE 2>&1
  echo "Backend restarted" >> $LOG_FILE
else
  echo "Backend unchanged — skipping Docker rebuild" >> $LOG_FILE
fi

echo "=== Deploy finished: $(date) ===" >> $LOG_FILE
