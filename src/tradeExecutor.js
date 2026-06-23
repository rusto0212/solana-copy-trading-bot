// src/tradeExecutor.js
const fetch = require('node-fetch').default;

let bs58;
try {
  const imported = require('bs58');
  bs58 = imported.default ? imported.default : imported;
} catch {
  bs58 = require('bs58');
}

const { Keypair, VersionedTransaction } = require('@solana/web3.js');
const config = require('./config');
const { info, warn, error } = require('./logger');

const LAMPORTS_PER_SOL = 1_000_000_000;
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

// Known safe Solana program IDs (DEXes, token programs, utilities)
const SAFE_PROGRAMS = new Set([
  '11111111111111111111111111111111',              // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ComputeBudget111111111111111111111111111111',   // Compute Budget
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1brs',// Associated Token Account
  'So11111111111111111111111111111111111111112',   // Wrapped SOL
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter Aggregator v6
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // Pump.fun AMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vA',  // Meteora Pools
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qffwaryk',  // Moonshot
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJejK',  // OpenBook (Serum v3)
]);

// Official Jito block-engine tip accounts — SOL sent here is valid
const JITO_TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13yfRqi8',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

/**
 * Inspect a deserialized VersionedTransaction BEFORE signing.
 *
 * Checks:
 *  1. Fee payer must be our wallet.
 *  2. Any System Program SOL transfer to an unknown (non-Jito) address must not
 *     exceed what we expect to spend — catches drain transactions.
 *  3. Warns if unknown program IDs are involved.
 *
 * @param {VersionedTransaction} tx
 * @param {{ action: string, amountSol: number, tip: number }} tradeParams
 * @throws {Error} if the transaction looks malicious
 */
function verifyTransaction(tx, { action, amountSol, tip }) {
  const message = tx.message;

  // Works for both MessageV0 (staticAccountKeys) and legacy Message (accountKeys)
  const accountKeys = (message.staticAccountKeys || message.accountKeys).map(k => k.toBase58());

  // ── 1. Fee payer ──────────────────────────────────────────────────────────
  if (accountKeys[0] !== config.PUBLIC_KEY) {
    throw new Error(
      `SECURITY ALERT: Fee payer is ${accountKeys[0]}, expected our wallet ${config.PUBLIC_KEY}. ` +
      `Transaction REJECTED.`
    );
  }

  // ── 2. Scan instructions ──────────────────────────────────────────────────
  // For a buy: expect up to (amountSol + tip + 0.05 SOL buffer) out via system program
  // For a sell: only the Jito tip should leave via system program
  const maxExpectedLamports = BigInt(
    Math.ceil((action === 'buy' ? amountSol + tip + 0.05 : tip + 0.01) * LAMPORTS_PER_SOL)
  );

  const instructions = message.compiledInstructions || message.instructions;
  const involvedPrograms = new Set();

  for (const ix of instructions) {
    const programId = accountKeys[ix.programIdIndex];
    involvedPrograms.add(programId);

    if (programId !== SYSTEM_PROGRAM_ID) continue;

    // Decode instruction data — Uint8Array for v0, base58 string for legacy
    const rawData = ix.data;
    const data = Buffer.from(
      rawData instanceof Uint8Array ? rawData : bs58.decode(rawData)
    );

    // System Program Transfer: u32 LE type=2, then u64 LE lamports
    if (data.length < 12 || data.readUInt32LE(0) !== 2) continue;

    const accounts = ix.accountKeyIndexes || ix.accounts;
    const destination = accountKeys[accounts[1]];
    const lamports = data.readBigUInt64LE(4);

    if (destination && !JITO_TIP_ACCOUNTS.has(destination) && destination !== config.PUBLIC_KEY) {
      if (lamports > maxExpectedLamports) {
        const solAmt = (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
        const maxSol  = (Number(maxExpectedLamports) / LAMPORTS_PER_SOL).toFixed(6);
        throw new Error(
          `SECURITY ALERT: Suspicious SOL transfer of ${solAmt} SOL to ${destination} ` +
          `(max expected: ${maxSol} SOL). Transaction REJECTED.`
        );
      }
    }
  }

  // ── 3. Warn about unrecognized programs ───────────────────────────────────
  const unknown = [...involvedPrograms].filter(p => !SAFE_PROGRAMS.has(p));
  if (unknown.length > 0) {
    warn(`[Security] Transaction uses unrecognized programs: ${unknown.join(', ')}`);
  }

  info(`[Security] ✓ Transaction verified. Programs: ${[...involvedPrograms].join(', ')}`);
}

/**
 * HTTP fetch with exponential-backoff retry on transient failures.
 */
async function fetchWithRetry(url, options, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      const text = await res.text();
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) {
      const delay = 1000 * attempt;
      warn(`[tradeExecutor] Request failed (attempt ${attempt}/${retries}), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Deserialize, verify, sign, and broadcast a transaction via Jito.
 * @param {string} base64Txn    - base64-encoded VersionedTransaction from SolanaPortal
 * @param {object} tradeParams  - passed to verifyTransaction
 * @returns {string} signature
 */
async function signAndSendViaJito(base64Txn, tradeParams) {
  const secretKey = bs58.decode(config.PRIVATE_KEY);
  const walletKeypair = Keypair.fromSecretKey(secretKey);

  const tx = VersionedTransaction.deserialize(Buffer.from(base64Txn, 'base64'));

  // Verify BEFORE signing — throws if anything looks suspicious
  verifyTransaction(tx, tradeParams);

  tx.sign([walletKeypair]);
  const signedTx = bs58.encode(tx.serialize());

  const res = await fetchWithRetry(config.JITO_ENGINE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [signedTx] })
  });

  const jitoData = await res.json();
  if (!jitoData.result) {
    throw new Error(`Jito did not return a result: ${JSON.stringify(jitoData)}`);
  }
  return jitoData.result;
}

/**
 * Call SolanaPortal to get a base64-encoded VersionedTransaction.
 */
async function getPortalTxn(params) {
  const res = await fetchWithRetry('https://api.solanaportal.io/api/trading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return await res.json();
}

/**
 * Buy a token. Returns the on-chain signature string.
 */
async function buyToken({ mint, amountSol, slippage, tip, dex }) {
  info(`[tradeExecutor] BUY: mint=${mint}, SOL=${amountSol}, dex=${dex}, slippage=${slippage}%, tip=${tip} SOL`);
  const portalBase64 = await getPortalTxn({
    wallet_address: config.PUBLIC_KEY,
    action: 'buy', dex, mint, amount: amountSol, slippage, tip, type: 'jito'
  });
  const signature = await signAndSendViaJito(portalBase64, { action: 'buy', amountSol, tip });
  info(`[tradeExecutor] BUY sent: https://solscan.io/tx/${signature}`);
  return signature;
}

/**
 * Sell a token. Returns the on-chain signature string.
 */
async function sellToken({ mint, amountTokens, slippage, tip, dex }) {
  info(`[tradeExecutor] SELL: mint=${mint}, tokens=${amountTokens}, dex=${dex}, slippage=${slippage}%, tip=${tip} SOL`);
  const portalBase64 = await getPortalTxn({
    wallet_address: config.PUBLIC_KEY,
    action: 'sell', dex, mint, amount: amountTokens, slippage, tip, type: 'jito'
  });
  const signature = await signAndSendViaJito(portalBase64, { action: 'sell', amountSol: 0, tip });
  info(`[tradeExecutor] SELL sent: https://solscan.io/tx/${signature}`);
  return signature;
}

module.exports = { buyToken, sellToken };
