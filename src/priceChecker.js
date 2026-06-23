// src/priceChecker.js
const fetch = require('node-fetch').default;
const config = require('./config');
const { error } = require('./logger');

const FETCH_TIMEOUT_MS = 10_000; // abort if the price API hangs

/**
 * Fetch the USD and SOL price for a mint via Coinvera.
 * Returns { priceInSol, priceInUsd } or null on failure.
 */
async function getPriceOnChain(mint) {
  const url = `https://api.coinvera.io/api/v1/price?ca=${mint}`;
  try {
    const res = await fetch(url, {
      method:  'GET',
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.COINVERA_API },
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    return { priceInSol: data.priceInSol, priceInUsd: data.priceInUsd };
  } catch (err) {
    error(`[priceChecker] Failed to fetch price for ${mint}: ${err.message}`);
    return null;
  }
}

/** Pause execution for `ms` milliseconds. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { getPriceOnChain, sleep };
