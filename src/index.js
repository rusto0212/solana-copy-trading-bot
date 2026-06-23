// src/index.js
const config   = require('./config');
const { info, warn, error, success, debug } = require('./logger');
const notifier = require('./notifier');
const CopyEmitter = require('./websocket');
const storage  = require('./storage');
const { mapDex } = require('./dexMapper');
const { getPriceOnChain, sleep } = require('./priceChecker');
const { buyToken, sellToken } = require('./tradeExecutor');
const { Connection, PublicKey } = require('@solana/web3.js');

const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';

/** Convert a raw BigInt token amount to a decimal string. */
function rawToDecimalString(rawBigInt, decimals) {
  const s = rawBigInt.toString();
  if (decimals === 0) return s;
  if (s.length <= decimals) return '0.' + '0'.repeat(decimals - s.length) + s;
  return s.slice(0, s.length - decimals) + '.' + s.slice(s.length - decimals);
}

/** Format a P&L percentage with a coloured +/- prefix. */
function formatPnl(pct, usd) {
  const sign   = pct >= 0 ? '+' : '';
  const colour = pct >= 0 ? GREEN : RED;
  return `${colour}${BOLD}${sign}${pct.toFixed(2)}% ($${sign}${usd.toFixed(4)})${RESET}`;
}

/** Print startup banner with config summary and historical stats. */
function printBanner(activeCount) {
  const stats = storage.getStats();
  const line  = '─'.repeat(52);
  console.log(`\n${BOLD}${line}${RESET}`);
  console.log(`${BOLD}  Solana Copy Trading Bot${RESET}`);
  console.log(`${line}`);
  console.log(`  Mode      : ${config.BOT_MODE} / ${config.TRADE_TYPE}`);
  console.log(`  Copying   : ${config.COPY_WALLET}`);
  console.log(`  Wallet    : ${config.PUBLIC_KEY}`);
  console.log(`  Buy amt   : ${config.BUY_AMOUNT} SOL  |  Slippage: ${config.SLIPPAGE}%  |  Tip: ${config.JITO_TIP} SOL`);
  console.log(`  DEX       : ${config.PREFERRED_DEX}  |  Max positions: ${config.MAX_POSITIONS}`);
  if (config.TRADE_TYPE === 'SAFE') {
    console.log(`  TP/SL     : +${config.TAKE_PROFIT}% / -${config.STOP_LOSS}%`);
    if (config.ENABLE_TRAILING_STOP) {
      console.log(`  Trail TSL : distance=${config.TRAILING_STOP_DISTANCE}%, activation=+${config.TRAILING_STOP_ACTIVATION}%`);
    }
  }
  console.log(`  Active pos: ${activeCount}`);
  if (stats) {
    const colour = parseFloat(stats.totalPnlUsd) >= 0 ? GREEN : RED;
    console.log(
      `  All-time  : ${stats.totalTrades} trades | ` +
      `Win rate ${stats.winRate}% | ` +
      `P&L ${colour}${BOLD}$${stats.totalPnlUsd}${RESET}`
    );
  }
  console.log(`${BOLD}${line}${RESET}\n`);
}

(async () => {
  try {
    storage.initStorage();

    const activeMap    = new Map();
    const inSellingSet = new Set();

    for (const pos of storage.getActivePositions()) {
      activeMap.set(pos.id, { ...pos });
    }

    printBanner(activeMap.size);

    // Send Telegram startup alert (no-op when Telegram is unconfigured)
    notifier.botStarted({
      copyWallet: config.COPY_WALLET,
      mode:       config.BOT_MODE,
      tradeType:  config.TRADE_TYPE,
    });

    // Cache of recently processed trade signatures to prevent double-execution
    // from duplicate WebSocket messages. Capped to avoid unbounded growth.
    const seenSignatures = new Set();
    const MAX_SEEN_SIGS  = 500;

    const connection = new Connection(config.SOLANA_RPC, 'confirmed');

    /** Poll until a transaction is confirmed or timeout. */
    async function waitForConfirmation(signature, timeoutSec = 15) {
      const start = Date.now();
      while ((Date.now() - start) / 1000 < timeoutSec) {
        try {
          const resp = await connection.getSignatureStatuses([signature]);
          const status = resp?.value?.[0];
          if (status?.confirmationStatus === 'confirmed') return true;
        } catch {
          // transient RPC error — retry
        }
        await sleep(1000);
      }
      warn(`[Confirm] Timed out waiting for ${signature}`);
      return false;
    }

    /**
     * Attempt to sell a position, retrying once with the live on-chain balance
     * if the first attempt fails due to an "Insufficient SPL token balance" error.
     */
    async function safeSell(pos) {
      const { mint, token_amount: storedAmt, id, dex } = pos;

      try {
        await sellToken({ mint, amountTokens: storedAmt, slippage: config.SLIPPAGE, tip: config.JITO_TIP, dex });
        return true;
      } catch (err) {
        if (!(err.message || '').includes('Insufficient SPL token balance')) throw err;

        warn(`[Main] Insufficient SPL balance for ${id}. Re-checking on-chain...`);

        const ownerPubkey = new PublicKey(config.PUBLIC_KEY);
        const accounts = await connection.getParsedTokenAccountsByOwner(ownerPubkey, {
          mint: new PublicKey(mint)
        });

        let totalRaw = BigInt(0);
        let decimals = null;
        for (const acct of accounts.value) {
          const info = acct.account.data.parsed.info.tokenAmount;
          totalRaw += BigInt(info.amount);
          decimals = info.decimals;
        }

        const actualStr = decimals !== null ? rawToDecimalString(totalRaw, decimals) : '0';
        const actualNum = parseFloat(actualStr);

        if (actualNum > 0) {
          info(`[Main] Retrying sell of ${actualStr} tokens for ${id}...`);
          try {
            await sellToken({ mint, amountTokens: actualStr, slippage: config.SLIPPAGE, tip: config.JITO_TIP, dex });
            return true;
          } catch (err2) {
            error(`[Main] Retry sell for ${id} failed:`, err2.message);
            return false;
          }
        } else {
          info(`[Main] Position ${id} has zero on-chain balance — marking closed.`);
          storage.updatePosition(id, { status: 'closed' });
          activeMap.delete(id);
          inSellingSet.delete(id);
          return false;
        }
      }
    }

    // ── BOT_MODE = SELLING ────────────────────────────────────────────────────
    if (config.BOT_MODE === 'SELLING') {
      info('[Main] BOT_MODE=SELLING → liquidating all active positions...');
      for (const pos of activeMap.values()) {
        const { id, mint } = pos;
        inSellingSet.add(id);

        // Fetch live price for accurate P&L before selling
        const priceData = await getPriceOnChain(mint).catch(() => null);
        const closePrice = priceData ? parseFloat(priceData.priceInUsd) : parseFloat(pos.current_price) || 0;

        const sold = await safeSell(pos);
        if (sold) {
          const closed = storage.closePosition(id, { closePrice, closeReason: 'MANUAL_SELL' });
          activeMap.delete(id);
          inSellingSet.delete(id);
          success(`[Main] Position ${id} closed. P&L: ${formatPnl(closed.pnl_pct, closed.pnl_usd)}`);
          notifier.positionClosed({ id, mint, pnlPct: closed.pnl_pct, pnlUsd: closed.pnl_usd, closeReason: 'MANUAL_SELL' });
        }
      }

      const stats = storage.getStats();
      if (stats) {
        info(`[Main] Session stats: ${stats.totalTrades} trades | Win rate ${stats.winRate}% | Total P&L $${stats.totalPnlUsd}`);
      }
      info('[Main] All positions processed. Exiting.');
      process.exit(0);
    }

    // ── BOT_MODE = COPY ───────────────────────────────────────────────────────
    info('[Main] BOT_MODE=COPY → starting normal copy flow.');

    // Price-polling loop — checks TP / SL / trailing stop for SAFE positions
    async function pricePollingLoop() {
      for (const pos of Array.from(activeMap.values())) {
        const {
          id, status, trade_mode, mint, entry_price,
          stop_loss_pct, take_profit_pct,
          highest_price, trailing_stop_price, trailing_stop_activated,
          trailing_stop_distance, trailing_stop_activation
        } = pos;

        if (status !== 'active' || inSellingSet.has(id)) continue;

        try {
          const entryPriceNum = parseFloat(entry_price);
          const priceData = await getPriceOnChain(mint);
          if (!priceData) continue;
          const currentPriceUsd = parseFloat(priceData.priceInUsd);

          pos.current_price = currentPriceUsd;
          storage.updatePosition(id, { current_price: currentPriceUsd });

          if (trade_mode !== 'SAFE') continue;

          const changePct = ((currentPriceUsd - entryPriceNum) / entryPriceNum) * 100.0;

          // ── Trailing Stop Loss ──────────────────────────────────────────
          if (config.ENABLE_TRAILING_STOP && trailing_stop_distance && trailing_stop_activation !== null) {
            let newHighest   = highest_price;
            let newTslPrice  = trailing_stop_price;
            let newTslActive = trailing_stop_activated;
            let tslTriggered = false;

            if (currentPriceUsd > highest_price) {
              newHighest   = currentPriceUsd;
              pos.highest_price = newHighest;

              if (!trailing_stop_activated && changePct >= trailing_stop_activation) {
                newTslActive = true;
                pos.trailing_stop_activated = newTslActive;
                info(`[Main][TSL] Activated for ${id} at ${changePct.toFixed(2)}% profit`);
              }
              if (newTslActive) {
                newTslPrice = newHighest * (1 - trailing_stop_distance / 100);
                pos.trailing_stop_price = newTslPrice;
                debug(`[Main][TSL] Stop updated for ${id}: $${newTslPrice.toFixed(9)}`);
              }
            }

            if (newTslActive && newTslPrice && currentPriceUsd <= newTslPrice) tslTriggered = true;

            storage.updatePosition(id, {
              highest_price: newHighest,
              trailing_stop_price: newTslPrice,
              trailing_stop_activated: newTslActive
            });

            if (tslTriggered) {
              const dropFromPeak = ((newHighest - currentPriceUsd) / newHighest) * 100.0;
              info(
                `[Main][TSL] Triggered for ${id} (${mint}). ` +
                `Peak $${newHighest.toFixed(9)}, Now $${currentPriceUsd.toFixed(9)}, ` +
                `Drop -${dropFromPeak.toFixed(2)}%`
              );
              inSellingSet.add(id);
              activeMap.delete(id);
              const closed = storage.closePosition(id, { closePrice: currentPriceUsd, closeReason: 'TRAILING_STOP' });
              const sold   = await safeSell(pos);
              if (sold) {
                success(`[Main][TSL] Position ${id} closed. P&L: ${formatPnl(closed.pnl_pct, closed.pnl_usd)}`);
                notifier.positionClosed({ id, mint, pnlPct: closed.pnl_pct, pnlUsd: closed.pnl_usd, closeReason: 'TRAILING_STOP' });
              }
              inSellingSet.delete(id);
              continue;
            }
          }

          // ── Take Profit ─────────────────────────────────────────────────
          if (changePct >= take_profit_pct) {
            info(`[Main][TP] Position ${id} hit +${changePct.toFixed(2)}%`);
            inSellingSet.add(id);
            activeMap.delete(id);
            const closed = storage.closePosition(id, { closePrice: currentPriceUsd, closeReason: 'TAKE_PROFIT' });
            const sold   = await safeSell(pos);
            if (sold) {
              success(`[Main][TP] Position ${id} closed. P&L: ${formatPnl(closed.pnl_pct, closed.pnl_usd)}`);
              notifier.positionClosed({ id, mint, pnlPct: closed.pnl_pct, pnlUsd: closed.pnl_usd, closeReason: 'TAKE_PROFIT' });
            }
            inSellingSet.delete(id);
            continue;
          }

          // ── Stop Loss ────────────────────────────────────────────────────
          if (changePct <= -stop_loss_pct) {
            info(`[Main][SL] Position ${id} hit -${(-changePct).toFixed(2)}%`);
            inSellingSet.add(id);
            activeMap.delete(id);
            const closed = storage.closePosition(id, { closePrice: currentPriceUsd, closeReason: 'STOP_LOSS' });
            const sold   = await safeSell(pos);
            if (sold) {
              success(`[Main][SL] Position ${id} closed. P&L: ${formatPnl(closed.pnl_pct, closed.pnl_usd)}`);
              notifier.positionClosed({ id, mint, pnlPct: closed.pnl_pct, pnlUsd: closed.pnl_usd, closeReason: 'STOP_LOSS' });
            }
            inSellingSet.delete(id);
            continue;
          }

          // ── Still open ───────────────────────────────────────────────────
          let msg =
            `[Main] ${id} (${mint}) | Entry $${entryPriceNum.toFixed(9)} ` +
            `→ $${currentPriceUsd.toFixed(9)} | Δ ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`;
          if (config.ENABLE_TRAILING_STOP && trailing_stop_distance && pos.trailing_stop_activated) {
            msg += ` | Peak $${pos.highest_price.toFixed(9)} | TSL $${pos.trailing_stop_price.toFixed(9)}`;
          }
          info(msg);

        } catch (err) {
          error('[Main] pricePollingLoop error for', id, err.message);
        }
      }
    }

    const pollingTimer = setInterval(pricePollingLoop, config.PRICE_CHECK_DELAY);
    info(`[Main] Price polling every ${config.PRICE_CHECK_DELAY}ms.`);

    // ── WebSocket listener ────────────────────────────────────────────────────
    const emitter = new CopyEmitter();
    emitter.connect();

    emitter.on('copyTrade', async (msg) => {
      try {
        debug('[Main] copyTrade received:', JSON.stringify(msg));

        const { signature, dexs, ca: mint, trade, solAmount, tokenAmount } = msg;

        // ── Duplicate-event guard ────────────────────────────────────────────
        if (signature) {
          if (seenSignatures.has(signature)) {
            debug(`[Main] Duplicate signature ignored: ${signature}`);
            return;
          }
          seenSignatures.add(signature);
          // Prevent unbounded memory growth — evict oldest entries
          if (seenSignatures.size > MAX_SEEN_SIGS) {
            seenSignatures.delete(seenSignatures.values().next().value);
          }
        }

        // ── Mint address validation ──────────────────────────────────────────
        if (!mint) {
          warn('[Main] copyTrade message missing mint address — ignoring.');
          return;
        }
        try { new PublicKey(mint); } catch {
          warn(`[Main] Invalid mint address received: ${mint} — ignoring.`);
          return;
        }

        let dex = mapDex(dexs);
        if (!dex) {
          warn(`[Main] Unrecognized dexs ${JSON.stringify(dexs)}, defaulting to "jupiter".`);
          dex = 'jupiter';
        }

        // ── COPY BUY ────────────────────────────────────────────────────────
        if (trade === 'buy' && solAmount < 0) {
          const existingPos = Array.from(activeMap.values()).find(
            p => p.mint === mint && p.status === 'active'
          );
          if (!config.ENABLE_MULTI_BUY && existingPos) {
            info(`[Main] MULTI_BUY disabled & position exists for ${mint} — skipping.`);
            return;
          }
          if (activeMap.size >= config.MAX_POSITIONS) {
            warn(`[Main] MAX_POSITIONS (${config.MAX_POSITIONS}) reached — skipping buy for ${mint}.`);
            return;
          }

          const buyAmountSol = config.TRADE_TYPE === 'EXACT' ? Math.abs(solAmount) : config.BUY_AMOUNT;
          info(`[Main] Copy BUY: mint=${mint}, placing ${buyAmountSol} SOL on ${dex}...`);

          const buySig = await buyToken({
            mint, amountSol: buyAmountSol, slippage: config.SLIPPAGE, tip: config.JITO_TIP, dex
          });

          info(`[Main] Waiting for confirmation of ${buySig}...`);
          const confirmed = await waitForConfirmation(buySig, 15);
          if (!confirmed) {
            warn(`[Main] Buy ${buySig} not confirmed — skipping position.`);
            return;
          }
          success(`[Main] Buy ${buySig} confirmed.`);

          // Fetch on-chain token balance
          const ownerPubkey = new PublicKey(config.PUBLIC_KEY);
          const tokenAccounts = await connection.getParsedTokenAccountsByOwner(ownerPubkey, {
            mint: new PublicKey(mint)
          });
          let totalRaw = BigInt(0);
          let decimals = null;
          for (const acct of tokenAccounts.value) {
            const parsed = acct.account.data.parsed.info.tokenAmount;
            totalRaw += BigInt(parsed.amount);
            decimals = parsed.decimals;
          }
          const tokenAmountStr = decimals !== null ? rawToDecimalString(totalRaw, decimals) : '0';

          const priceData    = await getPriceOnChain(mint);
          const entryPriceUsd = priceData ? parseFloat(priceData.priceInUsd) : 0;

          const newPos = storage.addPosition({
            mint,
            buy_amount:              buyAmountSol,
            token_amount:            tokenAmountStr,
            entry_price:             entryPriceUsd,
            status:                  'active',
            trade_mode:              config.TRADE_TYPE,
            parent_signature:        signature,
            stop_loss_pct:           config.TRADE_TYPE === 'SAFE' ? config.STOP_LOSS : null,
            take_profit_pct:         config.TRADE_TYPE === 'SAFE' ? config.TAKE_PROFIT : null,
            dex,
            trailing_stop_distance:  config.ENABLE_TRAILING_STOP ? config.TRAILING_STOP_DISTANCE : null,
            trailing_stop_activation:config.ENABLE_TRAILING_STOP ? config.TRAILING_STOP_ACTIVATION : null,
          });

          activeMap.set(newPos.id, { ...newPos });
          success(
            `[Main] Position opened: ID=${newPos.id}, mint=${mint}, ` +
            `tokens=${tokenAmountStr}, entry=$${entryPriceUsd.toFixed(9)}, dex=${dex}`
          );
          notifier.positionOpened({
            id:          newPos.id,
            mint,
            entryPrice:  entryPriceUsd,
            buyAmountSol,
            dex,
          });
        }

        // ── COPY SELL (EXACT mode) ──────────────────────────────────────────
        else if (trade === 'sell' && tokenAmount < 0) {
          if (config.TRADE_TYPE !== 'EXACT') return;

          const existingExact = Array.from(activeMap.values()).find(
            p => p.mint === mint && p.trade_mode === 'EXACT' && p.status === 'active'
          );
          if (!existingExact) {
            info(`[Main] Copy SELL for ${mint} — no EXACT position found, ignoring.`);
            return;
          }

          const { id } = existingExact;
          info(`[Main] Copy SELL detected for ${mint} → closing EXACT position ${id}...`);

          inSellingSet.add(id);
          activeMap.delete(id);
          // Use last known price for P&L; we don't have a live quote here
          const closePrice = parseFloat(existingExact.current_price) || 0;
          const closed     = storage.closePosition(id, { closePrice, closeReason: 'COPY_SELL' });

          const sold = await safeSell(existingExact);
          if (sold) {
            success(`[Main] EXACT position ${id} closed. P&L: ${formatPnl(closed.pnl_pct, closed.pnl_usd)}`);
            notifier.positionClosed({ id, mint, pnlPct: closed.pnl_pct, pnlUsd: closed.pnl_usd, closeReason: 'COPY_SELL' });
          }
          inSellingSet.delete(id);
        }

      } catch (err) {
        error('[Main] Error handling copyTrade:', err.message);
      }
    });

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    function shutdown(signal) {
      info(`\n[Main] ${signal} received — shutting down...`);
      clearInterval(pollingTimer);
      emitter.disconnect();
      const stats = storage.getStats();
      if (stats) {
        info(
          `[Main] Session ended. All-time: ${stats.totalTrades} trades | ` +
          `Win rate ${stats.winRate}% | Total P&L $${stats.totalPnlUsd}`
        );
      }
      info('[Main] Goodbye.');
      process.exit(0);
    }
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    info(`[Main] Listening to trades from ${config.COPY_WALLET} ...`);

  } catch (err) {
    error('[Main] Fatal error:', err.message);
    process.exit(1);
  }
})();
