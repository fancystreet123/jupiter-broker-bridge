# Jupiter ⇄ Interactive Brokers Bridge

This is the "small always-on computer" that keeps you logged into Interactive
Brokers so Jupiter can place and read **paper** trades. It is **paper-first and
locked down**: it will not touch a live (real-money) account unless you
deliberately flip a switch, and even then every order is capped and
password-protected.

You do **not** need to understand the code. Follow the steps.

---

## What you're setting up

Two small programs that run together on one rented cloud machine:

- **ibgateway** — Interactive Brokers' own program, kept logged in for you.
- **bridge** — the Jupiter piece that receives "buy X / sell Y" and forwards it
  to IBKR. It's protected by a password only you and Jupiter know.

Your IBKR username and password live **only on this machine** — never inside
Jupiter, never in the code, never sent to anyone.

---

## Step 1 — Rent the always-on machine (~$6/month)

Any small cloud server that runs Docker works. Easiest options:

- **Hetzner Cloud** (~$5/mo) or **DigitalOcean** (~$6/mo) — pick the smallest
  Ubuntu server, "with Docker" if offered.
- Give it 1 GB+ RAM.

You'll get a login (SSH). If that part is unfamiliar, tell me and I'll walk you
through it click-by-click for whichever host you pick.

## Step 2 — Put these files on the machine

Copy this whole folder to the server (or `git clone` it). Then:

```bash
cp .env.example .env
nano .env          # fill in the blanks, then Ctrl-O, Enter, Ctrl-X to save
```

In `.env` you set:
- your IBKR username + password,
- `TRADING_MODE=paper` (leave it),
- `BRIDGE_TOKEN` = a long random password (make one: `openssl rand -hex 24`).

## Step 3 — Turn it on

```bash
docker compose up -d
```

That's it — it's now running 24/7 and will restart itself if the server reboots.

## Step 4 — Check it's alive

```bash
curl localhost:8080/health
```

You want to see `"connected": true` and `"mode": "PAPER_ONLY"` with your paper
account (starts with **DU**) listed. If `connected` is false, the gateway is
still logging in — wait a minute and try again.

## Step 5 — Give Jupiter two things

Send me (or paste into Jupiter's settings when we wire it up):
1. the machine's address (e.g. `https://your-server-ip:8080`),
2. the `BRIDGE_TOKEN` you chose.

Then I connect the "Live Paper" toggle to it and we start the 2-week test.

---

## The safety rails (already on)

| Guard | What it does |
|------|---------------|
| `PAPER_ONLY=true` | Bridge refuses to trade anything that isn't a paper (DU) account. |
| `MAX_ORDER_USD=50000` | Rejects only runaway/bug orders. Your engine trades ~$20k/position, so normal trades pass; a sizing bug that tries a giant order gets stopped. `0` disables it. |
| `BRIDGE_TOKEN` | Nothing can place an order without this password. |
| `ALLOW_SYMBOLS` | Optional — restrict to a named list of tickers. |
| `/flatten` | One call closes every open position (kill switch). |

## What the bridge can do (its API)

- `GET /health` — is it alive and connected (no password needed).
- `GET /account` — cash + buying power.
- `GET /positions` — what's currently held.
- `POST /order` — place a paper order (password required, capped).
- `POST /flatten` — close everything now (password required).

## Going live later (only after the 2-week paper test)

1. In `.env`: `TRADING_MODE=live`, `IB_PORT=4001`, `PAPER_ONLY=false`.
2. `docker compose up -d` again.
3. IBKR will require a **daily login approval** (a tap in the IBKR mobile app)
   on the live account. We'll set up a reminder for that.

**Do not do this until the paper results are good and you've had the
real-money go-ahead.** Real orders move real money.

---

## Notes / honest caveats

- Put HTTPS in front of port 8080 before going live (a free Caddy reverse proxy
  does this in ~3 lines — I'll provide it when we deploy). Until then, keep the
  bridge reachable only from Jupiter.
- This service was built and boot-tested, but it can only be fully verified once
  it's running against your real IBKR paper login on the server. Step 4 is that
  verification — if `/health` doesn't show `connected: true`, send me the output
  and I'll fix it.
- The community `ib-gateway` image handles the keep-alive and daily restart. If
  you'd rather not run your own server at all, tell me and I'll price out a
  managed alternative — it costs more but is more hands-off.
