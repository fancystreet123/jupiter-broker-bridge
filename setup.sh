#!/usr/bin/env bash
# Fills .env (asks for your IBKR login — typed by YOU, never stored anywhere else),
# then starts the bridge and checks it's healthy.
set -e
cd "$(dirname "$0")"
COMPOSE="docker compose"; docker compose version >/dev/null 2>&1 || COMPOSE="docker-compose"
if [ -f .env ]; then echo ".env already exists — leaving it as is."; else
  TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p | tr -d '\n')
  echo; echo "Enter your Interactive Brokers PAPER login (this stays only on this server):"
  read -r -p "  IBKR username: " IBU
  read -r -s -p "  IBKR password: " IBP; echo
  cat > .env <<ENV
IB_USERNAME=$IBU
IB_PASSWORD=$IBP
TRADING_MODE=paper
IB_PORT=4002
BRIDGE_TOKEN=$TOKEN
PAPER_ONLY=true
MAX_ORDER_USD=50000
ALLOW_SYMBOLS=
ENV
  chmod 600 .env
  echo; echo "Your BRIDGE_TOKEN (send this to Jupiter, keep it secret):"; echo "  $TOKEN"
fi
echo; echo "Starting the bridge (first run downloads IB Gateway — can take a few minutes)..."
$COMPOSE up -d --build
echo; echo "Waiting 90s for IB Gateway to log in..."; sleep 90
echo "Health check:"; curl -s localhost:8080/health || echo "(no response yet — give it another minute, then: curl localhost:8080/health)"
echo
