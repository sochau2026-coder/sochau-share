#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# test-local.sh — Smoke-test the Sochau Share local stack
#
# Usage:
#   chmod +x test-local.sh
#   ./test-local.sh
#
# What it checks:
#   1. Backend health endpoint responds
#   2. Backend /health returns JSON {status:"ok"}
#   3. Frontend (Nginx) serves index.html with correct content-type
#   4. Socket.IO endpoint is reachable (HTTP 200 or 101)
#   5. A room URL (/testroom123) returns index.html (SPA routing)
#   6. Room probe API returns valid JSON
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
BACKEND="http://localhost:3000"
FRONTEND="http://localhost:5173"
ROOM="testroom123"
PASS=0
FAIL=0
BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"
RESET="\033[0m"

# ── Helpers ───────────────────────────────────────────────────────────────────
ok()   { echo -e "  ${GREEN}✔${RESET} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✗${RESET} $1"; ((FAIL++)); }
info() { echo -e "  ${YELLOW}→${RESET} $1"; }

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo -e "${RED}ERROR:${RESET} '$1' not found. Install it and re-run."
    exit 1
  fi
}

# ── Pre-flight ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Sochau Share — Local Stack Test${RESET}"
echo "──────────────────────────────────────"

check_cmd curl
check_cmd jq

# ── 1. Backend health (direct :3000) ─────────────────────────────────────────
echo ""
echo -e "${BOLD}[1] Backend direct (port 3000)${RESET}"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BACKEND/health" --max-time 5 || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  ok "Health endpoint returns HTTP 200"
else
  fail "Health endpoint returned HTTP $HTTP_CODE (is the backend running?)"
fi

HEALTH_BODY=$(curl -s "$BACKEND/health" --max-time 5 2>/dev/null || echo "{}")
STATUS=$(echo "$HEALTH_BODY" | jq -r '.status' 2>/dev/null || echo "")
if [ "$STATUS" = "ok" ]; then
  ROOMS=$(echo "$HEALTH_BODY" | jq -r '.rooms' 2>/dev/null || echo "?")
  ok "Health JSON: status=ok, rooms=$ROOMS"
else
  fail "Health JSON missing status:ok (got: $HEALTH_BODY)"
fi

# ── 2. Room probe (direct :3000) ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}[2] Room probe (port 3000)${RESET}"

ROOM_BODY=$(curl -s "$BACKEND/$ROOM" --max-time 5 2>/dev/null || echo "{}")
PEERS=$(echo "$ROOM_BODY" | jq -r '.peers' 2>/dev/null || echo "")
FULL=$(echo "$ROOM_BODY" | jq -r '.full' 2>/dev/null || echo "")
if [ "$PEERS" != "" ]; then
  ok "Room probe: peers=$PEERS, full=$FULL"
else
  fail "Room probe invalid response: $ROOM_BODY"
fi

# Room ID validation (too short)
INVALID=$(curl -s "$BACKEND/ab" --max-time 5 2>/dev/null || echo "{}")
ERR=$(echo "$INVALID" | jq -r '.error' 2>/dev/null || echo "")
if [ "$ERR" != "" ]; then
  ok "Short room ID correctly rejected: $ERR"
else
  fail "Short room ID was not rejected (got: $INVALID)"
fi

# ── 3. Socket.IO endpoint ─────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[3] Socket.IO endpoint${RESET}"

SIOCODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "$BACKEND/socket.io/?EIO=4&transport=polling" --max-time 5 || echo "000")
if [ "$SIOCODE" = "200" ] || [ "$SIOCODE" = "101" ]; then
  ok "Socket.IO polling endpoint: HTTP $SIOCODE"
else
  fail "Socket.IO endpoint returned HTTP $SIOCODE"
fi

# ── 4. Frontend via Nginx (:5173) ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}[4] Frontend via Nginx (port 5173)${RESET}"

FE_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$FRONTEND/" --max-time 5 || echo "000")
if [ "$FE_CODE" = "200" ]; then
  ok "Nginx serves / with HTTP 200"
else
  fail "Nginx returned HTTP $FE_CODE for / (is docker-compose running?)"
fi

FE_CT=$(curl -s -o /dev/null -w "%{content_type}" "$FRONTEND/" --max-time 5 || echo "")
if echo "$FE_CT" | grep -q "text/html"; then
  ok "Content-Type is text/html"
else
  fail "Unexpected Content-Type: $FE_CT"
fi

# SPA routing — room URL should return index.html
ROOM_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$FRONTEND/$ROOM" --max-time 5 || echo "000")
if [ "$ROOM_CODE" = "200" ]; then
  ok "SPA route /$ROOM returns HTTP 200 (Nginx try_files working)"
else
  fail "SPA route /$ROOM returned HTTP $ROOM_CODE"
fi

# ── 5. Nginx → backend proxy ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[5] Nginx → backend proxy${RESET}"

FE_HEALTH=$(curl -s "$FRONTEND/health" --max-time 5 2>/dev/null || echo "{}")
FE_STATUS=$(echo "$FE_HEALTH" | jq -r '.status' 2>/dev/null || echo "")
if [ "$FE_STATUS" = "ok" ]; then
  ok "Nginx /health proxy → backend works"
else
  fail "Nginx /health proxy failed (got: $FE_HEALTH)"
fi

FE_SIO=$(curl -s -o /dev/null -w "%{http_code}" \
  "$FRONTEND/socket.io/?EIO=4&transport=polling" --max-time 5 || echo "000")
if [ "$FE_SIO" = "200" ] || [ "$FE_SIO" = "101" ]; then
  ok "Nginx /socket.io/ proxy → backend works (HTTP $FE_SIO)"
else
  fail "Nginx /socket.io/ proxy failed (HTTP $FE_SIO)"
fi

# ── 6. Security headers ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[6] Security headers${RESET}"

HEADERS=$(curl -s -I "$BACKEND/health" --max-time 5 2>/dev/null || echo "")
if echo "$HEADERS" | grep -qi "x-content-type-options"; then
  ok "X-Content-Type-Options present (Helmet active)"
else
  fail "X-Content-Type-Options missing"
fi

POWERED=$(echo "$HEADERS" | grep -i "x-powered-by" || echo "")
if [ "$POWERED" = "" ]; then
  ok "X-Powered-By hidden"
else
  fail "X-Powered-By is exposed: $POWERED"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────────"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All $TOTAL checks passed. Stack is healthy.${RESET}"
  echo ""
  echo -e "  Open two browser tabs at:"
  echo -e "  ${BOLD}http://localhost:5173/$ROOM${RESET}"
  echo -e "  Drop a file in one tab and watch it transfer to the other."
else
  echo -e "${RED}${BOLD}$FAIL/$TOTAL checks failed.${RESET} See errors above."
  echo ""
  info "Make sure the stack is running first:"
  echo "    docker compose -f docker-compose.yml -f docker-compose.local.yml up --build"
fi
echo ""