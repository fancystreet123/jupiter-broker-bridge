// lib/ib.js — thin, defensive wrapper around the Interactive Brokers socket API.
// Talks to a running IB Gateway (or TWS) over its API port. Paper-first: the
// caller (server.js) enforces the paper-only + notional guards; this file just
// speaks IB. Event-driven API is wrapped into small promises with timeouts so a
// silent gateway can never hang a request forever.

import {
  IBApi, EventName, SecType, OrderAction, OrderType,
  MarketOrder, LimitOrder,
} from '@stoqey/ib';

const T = (ms, label) =>
  new Promise((_, rej) => setTimeout(() => rej(new Error('IB timeout: ' + label)), ms));

export class Broker {
  constructor({ host, port, clientId, timeoutMs = 15000 }) {
    this.host = host; this.port = port; this.clientId = clientId;
    this.timeoutMs = timeoutMs;
    this.api = new IBApi({ host, port, clientId });
    this.connected = false;
    this.accounts = [];      // managed accounts, e.g. ['DU1234567']
    this._nextId = null;     // next valid order id from IB
    this._reqSeq = 9000;     // our own reqId counter for summaries/positions
    this.api.on(EventName.error, (err, code, reqId) => {
      // Codes < 2100 are real errors; 2104/2106/2158 are benign "market data farm OK".
      if (code && code < 2100) console.error(`[IB] error ${code} req ${reqId}: ${err?.message || err}`);
    });
    this.api.on(EventName.managedAccounts, (list) => {
      this.accounts = String(list || '').split(',').map(s => s.trim()).filter(Boolean);
    });
    this.api.on(EventName.nextValidId, (id) => { this._nextId = id; });
    this.api.on(EventName.disconnected, () => { this.connected = false; });
  }

  connect() {
    return Promise.race([
      new Promise((resolve, reject) => {
        this.api.once(EventName.connected, () => { this.connected = true; });
        // nextValidId is the first thing IB sends after a good handshake —
        // wait for it so we know we can actually place orders.
        this.api.once(EventName.nextValidId, () => { this.connected = true; resolve(); });
        this.api.once(EventName.error, (e, code) => { if (code === 502 || code === 504) reject(new Error(String(e?.message || e))); });
        try { this.api.connect(); } catch (e) { reject(e); }
      }),
      T(this.timeoutMs, 'connect'),
    ]);
  }

  disconnect() { try { this.api.disconnect(); } catch {} this.connected = false; }

  nextOrderId() { const id = this._nextId; this._nextId += 1; return id; }

  // Account cash/value summary for the primary account.
  accountSummary() {
    const reqId = this._reqSeq++;
    const rows = {};
    return Promise.race([
      new Promise((resolve) => {
        const onRow = (id, account, tag, value, currency) => {
          if (id === reqId) rows[tag] = { value, currency, account };
        };
        const onEnd = (id) => {
          if (id !== reqId) return;
          this.api.off(EventName.accountSummary, onRow);
          this.api.off(EventName.accountSummaryEnd, onEnd);
          try { this.api.cancelAccountSummary(reqId); } catch {}
          resolve(rows);
        };
        this.api.on(EventName.accountSummary, onRow);
        this.api.on(EventName.accountSummaryEnd, onEnd);
        this.api.reqAccountSummary(reqId, 'All',
          'NetLiquidation,TotalCashValue,AvailableFunds,BuyingPower,GrossPositionValue');
      }),
      T(this.timeoutMs, 'accountSummary'),
    ]);
  }

  // Open positions across the account.
  positions() {
    const out = [];
    return Promise.race([
      new Promise((resolve) => {
        const onPos = (account, contract, pos, avgCost) => {
          if (pos !== 0) out.push({
            account, symbol: contract?.symbol, secType: contract?.secType,
            currency: contract?.currency, quantity: pos, avgCost,
          });
        };
        const onEnd = () => {
          this.api.off(EventName.position, onPos);
          this.api.off(EventName.positionEnd, onEnd);
          try { this.api.cancelPositions(); } catch {}
          resolve(out);
        };
        this.api.on(EventName.position, onPos);
        this.api.on(EventName.positionEnd, onEnd);
        this.api.reqPositions();
      }),
      T(this.timeoutMs, 'positions'),
    ]);
  }

  // Cancel a resting order by IB orderId.
  // IB confirms either via orderStatus 'Cancelled'/'ApiCancelled' or via error 202
  // ("Order Cancelled"). 202 is a SUCCESS here, not a failure — treat it as such.
  // Error 10147/10148 mean the order is already gone; report that plainly rather
  // than pretending we cancelled something.
  cancelOrder(orderId) {
    const id = Number(orderId);
    return Promise.race([
      new Promise((resolve) => {
        const done = (result) => {
          this.api.off(EventName.orderStatus, onStatus);
          this.api.off(EventName.error, onErr);
          resolve(result);
        };
        const onStatus = (oid, status) => {
          if (oid !== id) return;
          if (/cancel/i.test(String(status))) done({ orderId: id, cancelled: true, status });
        };
        const onErr = (err, code, reqId) => {
          if (reqId !== id) return;
          if (code === 202) return done({ orderId: id, cancelled: true, status: 'Cancelled' });
          if (code === 10147 || code === 10148) {
            return done({ orderId: id, cancelled: false, status: 'NotFound',
                          note: 'order is not open — already filled, cancelled, or never existed' });
          }
          if (code && code < 2100) done({ orderId: id, cancelled: false, status: 'Error', error: String(err?.message || err) });
        };
        this.api.on(EventName.orderStatus, onStatus);
        this.api.on(EventName.error, onErr);
        try { this.api.cancelOrder(id); }
        catch (e) { done({ orderId: id, cancelled: false, status: 'Error', error: String(e.message || e) }); }
        // No confirmation inside the grace window: report unknown rather than
        // claiming success. The caller must re-read /orders to find the truth.
        setTimeout(() => done({ orderId: id, cancelled: false, status: 'Unknown',
                                note: 'no confirmation within grace window — re-read /orders' }), 4000);
      }),
      T(this.timeoutMs, 'cancelOrder'),
    ]);
  }

  // Every open order with its live fill state. This is what makes fill polling
  // possible: openOrder gives the contract, orderStatus gives filled/remaining.
  // Both are merged by orderId so a partial fill is visible, not just done/not-done.
  openOrders() {
    const byId = new Map();
    const put = (id, patch) => byId.set(id, { orderId: id, ...(byId.get(id) || {}), ...patch });
    return Promise.race([
      new Promise((resolve) => {
        const onOpen = (orderId, contract, order) => {
          put(orderId, {
            symbol: contract?.symbol,
            secType: contract?.secType,
            action: order?.action,
            quantity: order?.totalQuantity,
            orderType: order?.orderType,
            limitPrice: order?.lmtPrice != null && order.lmtPrice !== Number.MAX_VALUE ? order.lmtPrice : null,
          });
        };
        const onStatus = (orderId, status, filled, remaining, avgFillPrice) => {
          put(orderId, { status, filled, remaining, avgFillPrice });
        };
        const onEnd = () => {
          this.api.off(EventName.openOrder, onOpen);
          this.api.off(EventName.orderStatus, onStatus);
          this.api.off(EventName.openOrderEnd, onEnd);
          resolve(Array.from(byId.values()));
        };
        this.api.on(EventName.openOrder, onOpen);
        this.api.on(EventName.orderStatus, onStatus);
        this.api.on(EventName.openOrderEnd, onEnd);
        this.api.reqAllOpenOrders();
        setTimeout(onEnd, 3000);   // openOrderEnd can be silent when nothing is open
      }),
      T(this.timeoutMs, 'openOrders'),
    ]);
  }

  // Place a US stock order (SMART routed). action: 'BUY'|'SELL'. type: 'MKT'|'LMT'.
  placeStockOrder({ symbol, action, quantity, type = 'MKT', limitPrice }) {
    const contract = { symbol, secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
    const act = action === 'SELL' ? OrderAction.SELL : OrderAction.BUY;
    const order = type === 'LMT'
      ? new LimitOrder(act, Number(limitPrice), Number(quantity))
      : new MarketOrder(act, Number(quantity));
    const orderId = this.nextOrderId();
    return Promise.race([
      new Promise((resolve) => {
        const onStatus = (id, status, filled, remaining, avgFillPrice) => {
          if (id !== orderId) return;
          this.api.off(EventName.orderStatus, onStatus);
          resolve({ orderId, status, filled, remaining, avgFillPrice });
        };
        this.api.on(EventName.orderStatus, onStatus);
        this.api.placeOrder(orderId, contract, order);
        // IB may not emit a status instantly for resting orders — resolve as
        // "Submitted" after a short grace so the caller gets the orderId back.
        setTimeout(() => {
          this.api.off(EventName.orderStatus, onStatus);
          resolve({ orderId, status: 'Submitted', filled: 0, remaining: Number(quantity), avgFillPrice: null });
        }, 2500);
      }),
      T(this.timeoutMs, 'placeOrder'),
    ]);
  }
}
