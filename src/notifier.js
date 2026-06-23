// src/notifier.js
// Optional Telegram notifications. Activate by setting TELEGRAM_BOT_TOKEN
// and TELEGRAM_CHAT_ID in your .env. All functions are no-ops when unset.
const fetch = require('node-fetch').default;
const { warn } = require('./logger');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ENABLED = !!(TOKEN && CHAT_ID);

async function send(text) {
  if (!ENABLED) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) warn(`[Notifier] Telegram API error: ${res.status}`);
  } catch (err) {
    warn(`[Notifier] Failed to send Telegram message: ${err.message}`);
  }
}

function botStarted({ copyWallet, mode, tradeType }) {
  return send(
    `🤖 <b>Bot Started</b>\n` +
    `Mode: <code>${mode} / ${tradeType}</code>\n` +
    `Copying: <code>${copyWallet}</code>`
  );
}

function positionOpened({ id, mint, entryPrice, buyAmountSol, dex }) {
  return send(
    `🟢 <b>Position Opened</b>\n` +
    `ID: <code>${id.slice(0, 8)}</code>\n` +
    `Mint: <code>${mint}</code>\n` +
    `Entry: <b>$${Number(entryPrice).toFixed(9)}</b>\n` +
    `Buy: ${buyAmountSol} SOL | DEX: ${dex}`
  );
}

function positionClosed({ id, mint, pnlPct, pnlUsd, closeReason }) {
  const emoji = pnlPct >= 0 ? '🟢' : '🔴';
  const sign  = pnlPct >= 0 ? '+' : '';
  return send(
    `${emoji} <b>Position Closed</b> [${closeReason}]\n` +
    `ID: <code>${id.slice(0, 8)}</code>\n` +
    `Mint: <code>${mint}</code>\n` +
    `P&amp;L: <b>${sign}${pnlPct.toFixed(2)}% ($${sign}${pnlUsd.toFixed(4)})</b>`
  );
}

function botError(message) {
  return send(`⚠️ <b>Bot Error</b>\n<code>${message}</code>`);
}

module.exports = { send, botStarted, positionOpened, positionClosed, botError, ENABLED };
