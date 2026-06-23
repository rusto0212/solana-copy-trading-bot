// src/storage.js
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const getTimestamp = require('../utils/getTimestamp');

const filePath = path.join(__dirname, '../data/positions.json');

function readData() {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object' || !Array.isArray(json.positions)) {
      return { positions: [] };
    }
    return json;
  } catch {
    return { positions: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function initStorage() {
  if (!fs.existsSync(filePath)) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeData({ positions: [] });
  } else {
    const data = readData();
    if (!data || typeof data !== 'object' || !Array.isArray(data.positions)) {
      writeData({ positions: [] });
    }
  }
}

function addPosition(positionData) {
  const data = readData();
  const newPosition = {
    id:                      uuidv4(),
    time:                    getTimestamp(),
    mint:                    positionData.mint,
    buy_amount:              positionData.buy_amount,
    token_amount:            positionData.token_amount,
    entry_price:             positionData.entry_price,
    current_price:           positionData.entry_price,
    status:                  'active',
    trade_mode:              positionData.trade_mode,
    parent_signature:        positionData.parent_signature || null,
    stop_loss_pct:           positionData.stop_loss_pct || null,
    take_profit_pct:         positionData.take_profit_pct || null,
    dex:                     positionData.dex,
    // Trailing Stop Loss
    highest_price:           positionData.entry_price,
    trailing_stop_price:     null,
    trailing_stop_activated: false,
    trailing_stop_distance:  positionData.trailing_stop_distance || null,
    trailing_stop_activation:positionData.trailing_stop_activation || null,
    // P&L — filled when the position is closed
    close_price:  null,
    close_time:   null,
    close_reason: null,
    pnl_pct:      null,
    pnl_usd:      null,
  };
  data.positions.push(newPosition);
  writeData(data);
  return newPosition;
}

function getAllPositions() {
  return readData().positions;
}

function getActivePositions() {
  return readData().positions.filter(p => p.status === 'active');
}

function updatePosition(id, updates) {
  const data = readData();
  const idx = data.positions.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Position ${id} not found`);
  data.positions[idx] = { ...data.positions[idx], ...updates };
  writeData(data);
  return data.positions[idx];
}

/**
 * Mark a position as closed and record P&L.
 * @param {string} id
 * @param {{ closePrice: number, closeReason: string }} opts
 */
function closePosition(id, { closePrice, closeReason }) {
  const data = readData();
  const idx = data.positions.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Position ${id} not found`);

  const pos = data.positions[idx];
  const entryPrice = parseFloat(pos.entry_price);
  const tokenAmt   = parseFloat(pos.token_amount) || 0;
  const pnlPct = entryPrice > 0 ? ((closePrice - entryPrice) / entryPrice) * 100 : 0;
  const pnlUsd = (closePrice - entryPrice) * tokenAmt;

  data.positions[idx] = {
    ...pos,
    status:        'closed',
    current_price: closePrice,
    close_price:   closePrice,
    close_time:    getTimestamp(),
    close_reason:  closeReason,
    pnl_pct:       parseFloat(pnlPct.toFixed(4)),
    pnl_usd:       parseFloat(pnlUsd.toFixed(6)),
  };
  writeData(data);
  return data.positions[idx];
}

/**
 * Aggregate stats across all closed positions with recorded P&L.
 * Returns null if no closed positions exist yet.
 */
function getStats() {
  const closed = readData().positions.filter(p => p.status === 'closed' && p.pnl_pct !== null);
  if (closed.length === 0) return null;

  const wins        = closed.filter(p => p.pnl_pct > 0).length;
  const totalPnlUsd = closed.reduce((s, p) => s + (p.pnl_usd || 0), 0);
  const avgPnlPct   = closed.reduce((s, p) => s + (p.pnl_pct || 0), 0) / closed.length;

  return {
    totalTrades: closed.length,
    wins,
    losses:      closed.length - wins,
    winRate:     ((wins / closed.length) * 100).toFixed(1),
    totalPnlUsd: totalPnlUsd.toFixed(4),
    avgPnlPct:   avgPnlPct.toFixed(2),
  };
}

function findExactActiveByMint(mint) {
  return readData().positions.find(
    p => p.mint === mint && p.status === 'active' && p.trade_mode === 'EXACT'
  );
}

module.exports = {
  initStorage,
  addPosition,
  getAllPositions,
  getActivePositions,
  updatePosition,
  closePosition,
  getStats,
  findExactActiveByMint,
};
