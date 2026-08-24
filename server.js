// server.js — Jupiter ⇄ Interactive Brokers bridge (paper-first).
//
// A tiny always-on REST service that holds the IB Gateway connection and lets
// Jupiter place/read paper orders through a token-protected API. Every unsafe
// path is guarded: bearer token required, paper-only by default, hard notional
// cap per order, optional symbol allowlist. Live trading stays OFF until you
// deliberately set PAPER_ONLY=false — and even then the cap + token still apply.

import express from 'express';
import { Broker } from './ib.js';

const {
  PORT = '8080',
  BRIDGE_TOKEN,                       // shared secret Jupiter sends as Bearer
  IB_HOST = 'ibgateway',              // service name of the gateway container
  IB_PORT = '4002',                   // 4002 = gateway paper, 4001 = gateway live
  IB_CLIENT_ID = '11',
  PAPER_ONLY = 'true',                // refuse orders on any non-paper (DU…) account
  MAX_ORDER_USD = '50000',            // reject any single order above this notional (0 = off)
  ALLOW_SYMBOLS = '',                 // optional CSV allowlist, e.g. "SPY,QQQ"
} = process.env;

if (!BRIDGE_TOKEN || BRIDGE_TOKEN.length < 16) {
  console.error('FATAL: set BRIDGE_TOKEN to a long random string (>=16 chars).');
  process.exit(1);
}

const paperOnly = String(PAPER_ONLY).toLowerCase() !== 'false';
const maxUsd = Number(MAX_ORDER_USD) || 0;
const allow = ALLOW_SYMBOLS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const broker = new Broker({ host: IB_HOST, port: Number(IB_PORT), clientId: Number(IB_CLIENT_ID) });
let connecting = null;
async function ensureConnected() {
  if (broker.connected) return;
  if (!connecting) connecting = broker.connect().finally(() => { connecting = null; });
  await connecting;
}

const app = express();
app.use(express.json({ limit: '32kb' }));

// --- auth: every route except /health needs the bearer token ---
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (tok !== BRIDGE_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

const isPaperAccount = (acct) => /^DU/i.test(String(acct || ''));

app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    connected: broker.connected,
    mode: paperOnly ? 'PAPER_ONLY' : 'LIVE_ENABLED',
    accounts: broker.accounts,
    ibPort: Number(IB_PORT),
    maxOrderUsd: maxUsd,
  });
});

app.get('/account', async (_req, res) => {
  try { await ensureConnected(); res.json({ ok: true, accounts: broker.accounts, summary: await broker.accountSummary() }); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/positions', async (_req, res) => {
  try { await ensureConnected(); res.json({ ok: true, positions: await broker.positions() }); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// --- short-sale availability -------------------------------------------------
// POST /shortable { symbols: ["AAA","BBB"] }
// Answers the question that decides whether a short book is real: can this
// actually be borrowed? Sequential on purpose — IB throttles market-data
// requests and a burst returns garbage.
app.post('/shortable', async (req, res) => {
  try {
    const list = Array.isArray((req.body || {}).symbols) ? req.body.symbols : [];
    if (!list.length) return res.status(400).json({ error: 'symbols[] required' });
    if (list.length > 30) return res.status(400).json({ error: 'max 30 symbols per call' });
    await ensureConnected();
    const out = [];
    for (const s of list) {
      const sym = String(s || '').trim().toUpperCase();
      if (!sym) continue;
      try { out.push(await broker.shortability(sym)); }
      catch (e) { out.push({ symbol: sym, status: 'error', canShort: false, error: String(e.message || e) }); }
    }
    res.json({ ok: true, results: out });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// --- read every open order with its live fill state -------------------------
// This is what lets Jupiter reconcile: an order it sent is only "done" when IBKR
// says so, not when the POST returned 200.
app.get('/orders', async (_req, res) => {
  try { await ensureConnected(); res.json({ ok: true, orders: await broker.openOrders() }); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// --- cancel a resting order --------------------------------------------------
// Deliberately NOT part of /flatten: flatten closes positions, cancel withdraws
// an unfilled order. Conflating them is how you accidentally liquidate a book.
app.post('/cancel', async (req, res) => {
  try {
    const { orderId } = req.body || {};
    const id = Number(orderId);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'orderId required' });

    await ensureConnected();

    // Paper-only guard applies to cancels too: if a live account is somehow
    // attached, refuse to touch its orders at all.
    if (paperOnly && !broker.accounts.every(isPaperAccount)) {
      return res.status(403).json({ error: 'PAPER_ONLY is on but a non-paper account is connected — refusing to cancel' });
    }

    const result = await broker.cancelOrder(id);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.post('/order', async (req, res) => {
  try {
    const { symbol, action, quantity, type = 'MKT', limitPrice, refPrice } = req.body || {};
    // ---- validation + guards (fail closed) ----
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return res.status(400).json({ error: 'symbol required' });
    if (action !== 'BUY' && action !== 'SELL') return res.status(400).json({ error: 'action must be BUY or SELL' });
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be > 0' });
    if (type !== 'MKT' && type !== 'LMT') return res.status(400).json({ error: 'type must be MKT or LMT' });
    if (type === 'LMT' && !(Number(limitPrice) > 0)) return res.status(400).json({ error: 'limitPrice required for LMT' });
    if (allow.length && !allow.includes(sym)) return res.status(403).json({ error: `symbol ${sym} not in allowlist` });

    // notional cap — need a price to size it; require limitPrice (LMT) or refPrice (MKT)
    const px = type === 'LMT' ? Number(limitPrice) : Number(refPrice);
    if (!(px > 0)) return res.status(400).json({ error: 'refPrice required for MKT so the notional cap can be enforced' });
    const notional = px * qty;
    if (maxUsd && notional > maxUsd) return res.status(403).json({ error: `order notional $${Math.round(notional)} exceeds cap $${maxUsd}` });

    await ensureConnected();

    // paper-only guard: refuse if the connected account isn't a paper (DU…) account
    if (paperOnly && !broker.accounts.every(isPaperAccount)) {
      return res.status(403).json({ error: 'PAPER_ONLY is on but a non-paper account is connected — refusing to trade' });
    }

    const result = await broker.placeStockOrder({ symbol: sym, action, quantity: qty, type, limitPrice });
    res.json({ ok: true, notionalUsd: Math.round(notional), ...result });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// kill switch — flatten every open position with market orders
app.post('/flatten', async (_req, res) => {
  try {
    await ensureConnected();
    if (paperOnly && !broker.accounts.every(isPaperAccount)) {
      return res.status(403).json({ error: 'PAPER_ONLY is on but a non-paper account is connected' });
    }
    const pos = await broker.positions();
    const closed = [];
    for (const p of pos) {
      const action = p.quantity > 0 ? 'SELL' : 'BUY';
      const r = await broker.placeStockOrder({ symbol: p.symbol, action, quantity: Math.abs(p.quantity), type: 'MKT' });
      closed.push({ symbol: p.symbol, ...r });
    }
    res.json({ ok: true, closed });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.listen(Number(PORT), () => {
  console.log(`Jupiter broker bridge on :${PORT} — mode ${paperOnly ? 'PAPER_ONLY' : 'LIVE_ENABLED'}, cap $${maxUsd}, gateway ${IB_HOST}:${IB_PORT}`);
});
