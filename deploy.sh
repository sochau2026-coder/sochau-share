#!/bin/bash
# ─────────────────────────────────────────────
# Sochau Share — Auto Deploy Script
# For aapanel (Nginx) + PM2 setup (NO Docker)
# Triggered by GitHub webhook on every push to main
# ─────────────────────────────────────────────
set -e

REPO_DIR="/opt/sochau-share"
WEB_DIR="/www/wwwroot/share.sochau.cloud"
LOG_FILE="/var/log/sochau-deploy.log"
BACKEND_DIR="$REPO_DIR/backend"

echo "" >> $LOG_FILE
echo "=== Deploy started: $(date) ===" >> $LOG_FILE

# Pull latest code from GitHub
cd $REPO_DIR
git pull origin main >> $LOG_FILE 2>&1

# Copy ALL frontend files to web root (including ice-config.js!)
cp $REPO_DIR/frontend/index.html    $WEB_DIR/
cp $REPO_DIR/frontend/style.css     $WEB_DIR/
cp $REPO_DIR/frontend/app.js        $WEB_DIR/
cp $REPO_DIR/frontend/whiteboard.js $WEB_DIR/
cp $REPO_DIR/frontend/ice-config.js $WEB_DIR/
echo "Frontend files updated" >> $LOG_FILE

# Restart backend only if server.js or package.json changed
CHANGED=$(git diff HEAD~1 --name-only 2>/dev/null || echo "")
if echo "$CHANGED" | grep -qE "backend/server\.js|backend/package\.json"; then
  echo "Backend changed — installing deps and restarting PM2..." >> $LOG_FILE
  cd $BACKEND_DIR
  npm install --omit=dev >> $LOG_FILE 2>&1
  pm2 restart sochau-backend >> $LOG_FILE 2>&1 || pm2 start server.js --name sochau-backend >> $LOG_FILE 2>&1
  pm2 save >> $LOG_FILE 2>&1
  echo "Backend restarted" >> $LOG_FILE
else
  echo "Backend unchanged — skipping restart" >> $LOG_FILE
fi

echo "=== Deploy finished: $(date) ===" >> $LOG_FILE
