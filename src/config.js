// src/config.js
require('dotenv').config();
const { exit }      = require('process');
const { PublicKey } = require('@solana/web3.js');

function requiredEnv(key) {
  const val = process.env[key];
  if (!val) {
    console.error(`[config] ERROR: Missing required environment variable: ${key}`);
    exit(1);
  }
  return val;
}

function requiredPositiveFloat(key) {
  const val = parseFloat(requiredEnv(key));
  if (isNaN(val) || val <= 0) {
    console.error(`[config] ERROR: ${key} must be a positive number, got: "${process.env[key]}"`);
    exit(1);
  }
  return val;
}

function requiredPositiveInt(key) {
  const val = parseInt(requiredEnv(key), 10);
  if (isNaN(val) || val <= 0) {
    console.error(`[config] ERROR: ${key} must be a positive integer, got: "${process.env[key]}"`);
    exit(1);
  }
  return val;
}

const config = {
  SOLANA_RPC:        requiredEnv('SOLANA_RPC'),
  PRIVATE_KEY:       requiredEnv('PRIVATE_KEY'),
  PUBLIC_KEY:        requiredEnv('PUBLIC_KEY'),
  BOT_MODE:          requiredEnv('BOT_MODE').toUpperCase(),
  COPY_WALLET:       requiredEnv('COPY_WALLET'),
  TRADE_TYPE:        requiredEnv('TRADE_TYPE').toUpperCase(),
  BUY_AMOUNT:        requiredPositiveFloat('BUY_AMOUNT'),
  TAKE_PROFIT:       requiredPositiveFloat('TAKE_PROFIT'),
  STOP_LOSS:         requiredPositiveFloat('STOP_LOSS'),
  SLIPPAGE:          requiredPositiveFloat('SLIPPAGE'),
  JITO_TIP:          requiredPositiveFloat('JITO_TIP'),
  JITO_ENGINE:       requiredEnv('JITO_ENGINE'),
  COINVERA_API:      requiredEnv('COINVERA_API'),
  PRICE_CHECK_DELAY: requiredPositiveInt('PRICE_CHECK_DELAY'),
  PREFERRED_DEX:     (process.env.PREFERRED_DEX || 'none').toLowerCase(),
  ENABLE_MULTI_BUY:  (process.env.ENABLE_MULTI_BUY === 'true'),
  MAX_POSITIONS:     parseInt(process.env.MAX_POSITIONS || '10', 10),

  // Trailing Stop Loss
  ENABLE_TRAILING_STOP:     (process.env.ENABLE_TRAILING_STOP === 'true'),
  TRAILING_STOP_DISTANCE:   parseFloat(process.env.TRAILING_STOP_DISTANCE || '0'),
  TRAILING_STOP_ACTIVATION: parseFloat(process.env.TRAILING_STOP_ACTIVATION || '0'),
};

// ── Enum validation ──────────────────────────────────────────────────────────
const validBotModes   = ['COPY', 'SELLING'];
const validTradeTypes = ['EXACT', 'SAFE'];
const validDexOptions = ['none', 'auto', 'pumpfun', 'meteora', 'raydium', 'moonshot', 'jupiter'];

if (!validBotModes.includes(config.BOT_MODE)) {
  console.error(`[config] ERROR: BOT_MODE must be one of: ${validBotModes.join(', ')}`);
  exit(1);
}
if (!validTradeTypes.includes(config.TRADE_TYPE)) {
  console.error(`[config] ERROR: TRADE_TYPE must be one of: ${validTradeTypes.join(', ')}`);
  exit(1);
}
if (!validDexOptions.includes(config.PREFERRED_DEX)) {
  console.error(`[config] ERROR: PREFERRED_DEX must be one of: ${validDexOptions.join(', ')}`);
  exit(1);
}

// ── Range validation ─────────────────────────────────────────────────────────
if (config.SLIPPAGE > 100) {
  console.error(`[config] ERROR: SLIPPAGE (${config.SLIPPAGE}) cannot exceed 100%`);
  exit(1);
}
if (config.MAX_POSITIONS < 1) {
  console.error('[config] ERROR: MAX_POSITIONS must be at least 1');
  exit(1);
}
if (config.ENABLE_TRAILING_STOP && config.TRAILING_STOP_DISTANCE <= 0) {
  console.error('[config] ERROR: TRAILING_STOP_DISTANCE must be > 0 when ENABLE_TRAILING_STOP=true');
  exit(1);
}

// ── Solana key validation ────────────────────────────────────────────────────
try {
  new PublicKey(config.PUBLIC_KEY);
} catch {
  console.error(`[config] ERROR: PUBLIC_KEY "${config.PUBLIC_KEY}" is not a valid Solana address`);
  exit(1);
}
try {
  new PublicKey(config.COPY_WALLET);
} catch {
  console.error(`[config] ERROR: COPY_WALLET "${config.COPY_WALLET}" is not a valid Solana address`);
  exit(1);
}

module.exports = config;
