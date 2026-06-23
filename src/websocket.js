// src/websocket.js
const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('./config');
const { info, error, warn } = require('./logger');

const BASE_RECONNECT_MS = 5_000;
const MAX_RECONNECT_MS  = 60_000;

class CopyEmitter extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.pingInterval = null;
    this._reconnectDelay = BASE_RECONNECT_MS;
    this._reconnectAttempts = 0;
    this._stopped = false;
  }

  connect() {
    if (this._stopped) return;

    const WS_URL = 'wss://api.coinvera.io';
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      info(`[WebSocket] Connected. Subscribing to ${config.COPY_WALLET}...`);

      // Reset backoff on successful connection
      this._reconnectDelay = BASE_RECONNECT_MS;
      this._reconnectAttempts = 0;

      this.ws.send(JSON.stringify({
        apiKey: config.COINVERA_API,
        method: 'subscribeTrade',
        tokens: [config.COPY_WALLET]
      }));

      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
      }, 10_000);
    });

    this.ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'subscribeTrade' && msg.status === 'success') {
          info('[WebSocket] Subscription confirmed — watching for trades');
        }

        if (msg.signer && msg.signer === config.COPY_WALLET) {
          this.emit('copyTrade', msg);
        }
      } catch (err) {
        error('[WebSocket] Failed to parse message:', err.message);
      }
    });

    this.ws.on('error', err => {
      error('[WebSocket] Error:', err.message);
    });

    this.ws.on('close', (code) => {
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this._stopped) return;

      this._reconnectAttempts++;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, MAX_RECONNECT_MS);

      warn(
        `[WebSocket] Disconnected (${code}). ` +
        `Reconnecting in ${this._reconnectDelay / 1000}s (attempt #${this._reconnectAttempts})...`
      );
      setTimeout(() => this.connect(), this._reconnectDelay);
    });
  }

  disconnect() {
    this._stopped = true;
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) this.ws.close();
  }
}

module.exports = CopyEmitter;
