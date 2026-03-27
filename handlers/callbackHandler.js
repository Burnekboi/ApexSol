const { Keypair } = require('@solana/web3.js');
const { base58Encode, base58Decode } = require('../utils/base58');
const panels = require('../panels');
const { saveBuyersToDb, saveTradeConfigToDb } = require('../sessions');
const {
  loadNormalizedStored,
  persistStoredWallets,
  MAX_STORED_WALLETS
} = require('../helpers/walletStorage');
const User = require('../helpers/User');
const { getBalance } = require('../helpers/solana');

/**
 * Main callback handler — routes all inline button presses
 */
async function callbackHandler(bot, query, session, connection) {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;

  // Always answer the callback to remove the loading spinner
  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ─── MAIN MENU ────────────────────────────────────────────────────────────

  if (data === 'create_wallet') {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    const priv    = base58Encode(keypair.secretKey);

    session.mainWallet = { address, priv };
    session.buyers = [];

    // Persist to DB
    await User.findOneAndUpdate(
      { telegramId: chatId.toString() },
      { $set: { mainWallet: { address, priv }, buyers: [] } },
      { upsert: true }
    );

    // Add to storedWallets if not already there
    const stored = await loadNormalizedStored(chatId);
    if (!stored.find(w => w.address === address) && stored.length < MAX_STORED_WALLETS) {
      stored.push({ address, priv, buyers: [] });
      await persistStoredWallets(chatId, stored);
    }
    session.storedWallets = stored;

    await bot.editMessageText(
      `✅ *New Wallet Created!*\n\nAddress:\n\`${address}\`\n\n⚠️ Save your private key securely — it will not be shown again.\n\nPrivate Key:\n\`${priv}\``,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.buyerSetupMenu() }
    ).catch(() => bot.sendMessage(chatId, `✅ Wallet created!\n\`${address}\``, { parse_mode: 'Markdown', ...panels.buyerSetupMenu() }));
    return;
  }

  if (data === 'import_wallet') {
    const prompt = await bot.sendMessage(chatId, '🔑 Send your *Base58 private key* now.\n\n_This message will be deleted automatically._', { parse_mode: 'Markdown' });

    session.pendingInput = {
      resolve: async (text) => {
        try {
          await bot.deleteMessage(chatId, prompt.message_id).catch(() => {});
          const secretKey = base58Decode(text.trim());
          const keypair   = Keypair.fromSecretKey(secretKey);
          const address   = keypair.publicKey.toBase58();
          const priv      = base58Encode(keypair.secretKey);

          session.mainWallet = { address, priv };
          session.buyers = [];

          await User.findOneAndUpdate(
            { telegramId: chatId.toString() },
            { $set: { mainWallet: { address, priv }, buyers: [] } },
            { upsert: true }
          );

          const stored = await loadNormalizedStored(chatId);
          if (!stored.find(w => w.address === address) && stored.length < MAX_STORED_WALLETS) {
            stored.push({ address, priv, buyers: [] });
            await persistStoredWallets(chatId, stored);
          }
          session.storedWallets = stored;

          await bot.sendMessage(chatId,
            `✅ *Wallet Imported!*\n\nAddress:\n\`${address}\``,
            { parse_mode: 'Markdown', ...panels.buyerSetupMenu() }
          );
        } catch (err) {
          await bot.sendMessage(chatId, `❌ Invalid private key: ${err.message}`);
        }
      }
    };
    return;
  }

  if (data === 'existing_wallets') {
    const stored = await loadNormalizedStored(chatId);
    session.storedWallets = stored;
    session.existingWalletPage = 0;

    const wallet = stored[0] || null;
    await bot.editMessageText(
      panels.existingWalletsMessage(wallet, 0, stored.length),
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.existingWalletsKeyboard(0, stored.length) }
    ).catch(() => {});
    return;
  }

  if (data === 'refresh_session') {
    session.mainWallet = { address: null, priv: null };
    session.buyers = [];
    session.storedWallets = [];
    session.tradeConfig = { slippage: 5, minBuy: 0.01, maxBuy: 0.05, contractAddress: null, takeProfitPercent: 20, sellPortionPercent: 20 };
    session.isTrading = false;

    await bot.editMessageText(
      '🔄 *Session Refreshed*\n\nAll in-memory data cleared. Use the menu to start fresh.',
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.mainMenu() }
    ).catch(() => {});
    return;
  }

  // ─── EXISTING WALLETS PAGINATION ──────────────────────────────────────────

  if (data === 'ew_prev') {
    session.existingWalletPage = Math.max(0, (session.existingWalletPage || 0) - 1);
    const stored = session.storedWallets || [];
    const page   = session.existingWalletPage;
    await bot.editMessageText(
      panels.existingWalletsMessage(stored[page], page, stored.length),
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.existingWalletsKeyboard(page, stored.length) }
    ).catch(() => {});
    return;
  }

  if (data === 'ew_next') {
    const stored = session.storedWallets || [];
    session.existingWalletPage = Math.min(stored.length - 1, (session.existingWalletPage || 0) + 1);
    const page = session.existingWalletPage;
    await bot.editMessageText(
      panels.existingWalletsMessage(stored[page], page, stored.length),
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.existingWalletsKeyboard(page, stored.length) }
    ).catch(() => {});
    return;
  }

  if (data === 'ew_back') {
    await bot.editMessageText(
      `🥒 *Cucumverse Multi Wallet Bot*\n\nUse the menu below to begin.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.mainMenu() }
    ).catch(() => {});
    return;
  }

  if (data.startsWith('ew_u_')) {
    const idx    = parseInt(data.split('_')[2]);
    const stored = session.storedWallets || [];
    const wallet = stored[idx];
    if (!wallet) return;

    session.mainWallet = { address: wallet.address, priv: wallet.priv };
    session.buyers     = (wallet.buyers || []).map(b => ({ pub: b.pub, priv: b.priv, lastBalance: b.lastBalance || 0 }));

    await User.findOneAndUpdate(
      { telegramId: chatId.toString() },
      { $set: { mainWallet: { address: wallet.address, priv: wallet.priv }, buyers: session.buyers } },
      { upsert: true }
    );

    const bal = await getBalance(connection, wallet.address);
    const panel = panels.actionMenu(session, bal.toFixed(3));
    await bot.editMessageText(panel.text, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      reply_markup: panel.reply_markup
    }).catch(() => {});
    return;
  }

  if (data.startsWith('ew_d_')) {
    const idx    = parseInt(data.split('_')[2]);
    const stored = session.storedWallets || [];
    stored.splice(idx, 1);
    session.storedWallets = stored;
    await persistStoredWallets(chatId, stored);

    const page = Math.min(session.existingWalletPage || 0, Math.max(0, stored.length - 1));
    session.existingWalletPage = page;
    await bot.editMessageText(
      panels.existingWalletsMessage(stored[page] || null, page, stored.length),
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.existingWalletsKeyboard(page, stored.length) }
    ).catch(() => {});
    return;
  }

  // ─── BUYER WALLET SETUP ───────────────────────────────────────────────────

  if (data === 'buyer_wallets') {
    await bot.editMessageText(
      '👥 *Generate Buyer Wallets*\n\nChoose how many wallets to generate.\n\n🪙 = Paid tier (requires SOL payment)',
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.buyerOptionsMenu() }
    ).catch(() => {});
    return;
  }

  if (data === 'gen_2' || data === 'gen_10') {
    const count = data === 'gen_2' ? 2 : 10;
    await generateBuyerWallets(bot, chatId, msgId, session, connection, count);
    return;
  }

  if (data === 'paid_20' || data === 'paid_50' || data === 'paid_100') {
    const tiers = { paid_20: { count: 20, sol: 0.1 }, paid_50: { count: 50, sol: 0.5 }, paid_100: { count: 100, sol: 1.0 } };
    const tier  = tiers[data];
    await handlePaidWalletGeneration(bot, chatId, msgId, session, connection, tier.count, tier.sol);
    return;
  }

  // ─── ACTION MENU ──────────────────────────────────────────────────────────

  if (data === 'action_menu') {
    if (!session.mainWallet?.address) {
      await bot.sendMessage(chatId, '❌ No wallet set. Please create or import one first.');
      return;
    }
    const bal   = await getBalance(connection, session.mainWallet.address);
    const panel = panels.actionMenu(session, bal.toFixed(3));
    await bot.editMessageText(panel.text, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      reply_markup: panel.reply_markup
    }).catch(() => bot.sendMessage(chatId, panel.text, { parse_mode: 'Markdown', reply_markup: panel.reply_markup }));
    return;
  }

  // ─── WALLET STATUS ────────────────────────────────────────────────────────

  if (data === 'wallet_status_setup' || data === 'wallet_status_post' || data === 'wallet_status_trade') {
    await showWalletStatus(bot, chatId, msgId, session, connection);
    return;
  }

  // ─── BOT BALANCES ─────────────────────────────────────────────────────────

  if (data === 'bot_balances' || data === 'bot_balances_post') {
    await showBotBalances(bot, chatId, msgId, session, connection);
    return;
  }

  // ─── TRADE TOGGLE ─────────────────────────────────────────────────────────

  if (data === 'trade_toggle') {
    if (session.isTrading) {
      const { stopAllTrading } = require('../helpers/trading');
      await stopAllTrading(session);
      await bot.sendMessage(chatId, '🛑 *Trading Stopped.*', { parse_mode: 'Markdown' });
    } else {
      if (!session.tradeConfig?.contractAddress) {
        await bot.sendMessage(chatId, '❌ Set a contract address first via ⚙️ Trade Settings.');
        return;
      }
      const { performRealTrading } = require('../helpers/trading');
      performRealTrading(bot, connection, session, chatId);
      await bot.sendMessage(chatId, '🟢 *Trading Started!*', { parse_mode: 'Markdown' });
    }
    return;
  }

  // ─── SELL ALL ─────────────────────────────────────────────────────────────

  if (data === 'sell_all') {
    const { sellAllTokens } = require('../helpers/trading');
    await bot.sendMessage(chatId, '💥 *Initiating Sell All...*', { parse_mode: 'Markdown' });
    await sellAllTokens(bot, connection, session, chatId);
    return;
  }

  // ─── TOKEN BALANCES ───────────────────────────────────────────────────────

  if (data === 'token_balances') {
    await showTokenBalances(bot, chatId, session, connection);
    return;
  }

  // ─── TOKEN INFO ───────────────────────────────────────────────────────────

  if (data === 'token_info') {
    const ca = session.tradeConfig?.contractAddress;
    if (!ca) return bot.sendMessage(chatId, '❌ No contract address set.');
    await bot.sendMessage(chatId,
      `💰 *Token Info*\n\nContract:\n\`${ca}\`\n\n[View on Pump.fun](https://pump.fun/${ca})`,
      { parse_mode: 'Markdown', disable_web_page_preview: false }
    );
    return;
  }

  // ─── TRANSFER ─────────────────────────────────────────────────────────────

  if (data === 'transfer_main' || data === 'transfer_trade') {
    await handleTransfer(bot, chatId, msgId, session, connection);
    return;
  }

  // ─── DISTRIBUTE SOL ───────────────────────────────────────────────────────

  if (data === 'distribute_sol') {
    await handleDistribute(bot, chatId, session, connection);
    return;
  }

  // ─── BOT SETTINGS ─────────────────────────────────────────────────────────

  if (data === 'bot_settings') {
    await bot.editMessageText(
      '⚙️ *Bot Settings*\n\nManage your buyer bot wallets.',
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.botSettingsPanel() }
    ).catch(() => {});
    return;
  }

  if (data === 'add_bot_wallet') {
    const keypair = Keypair.generate();
    const newBot  = { pub: keypair.publicKey.toBase58(), priv: base58Encode(keypair.secretKey), lastBalance: 0 };
    session.buyers.push(newBot);
    await saveBuyersToDb(chatId, session.buyers);
    await bot.sendMessage(chatId, `✅ *Bot Wallet Added!*\n\nAddress:\n\`${newBot.pub}\``, { parse_mode: 'Markdown' });
    return;
  }

  if (data === 'delete_bot_wallet') {
    if (!session.buyers.length) {
      await bot.sendMessage(chatId, '❌ No bot wallets to delete.');
      return;
    }
    session.buyers.pop();
    await saveBuyersToDb(chatId, session.buyers);
    await bot.sendMessage(chatId, `🗑️ Last bot wallet removed. Remaining: ${session.buyers.length}`);
    return;
  }

  // ─── TRADE SETTINGS ───────────────────────────────────────────────────────

  if (data === 'trade_settings') {
    await bot.editMessageText(
      panels.tradeSettingsMessage(session),
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.tradeSettingsPanel() }
    ).catch(() => {});
    return;
  }

  if (data === 'ts_back') {
    const bal   = await getBalance(connection, session.mainWallet?.address || '');
    const panel = panels.actionMenu(session, bal.toFixed(3));
    await bot.editMessageText(panel.text, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      reply_markup: panel.reply_markup
    }).catch(() => {});
    return;
  }

  const tsFields = {
    ts_slippage:    { label: 'Slippage (%)',       key: 'slippage' },
    ts_min_buy:     { label: 'Min Buy (SOL)',       key: 'minBuy' },
    ts_max_buy:     { label: 'Max Buy (SOL)',       key: 'maxBuy' },
    ts_sell_pct:    { label: 'Sell Portion (%)',    key: 'sellPortionPercent' },
    ts_take_profit: { label: 'Take Profit (%)',     key: 'takeProfitPercent' },
    ts_contract:    { label: 'Contract Address',    key: 'contractAddress' }
  };

  if (tsFields[data]) {
    const field = tsFields[data];
    const prompt = await bot.sendMessage(chatId, `✏️ Enter new value for *${field.label}*:`, { parse_mode: 'Markdown' });

    session.pendingInput = {
      resolve: async (text) => {
        await bot.deleteMessage(chatId, prompt.message_id).catch(() => {});
        const val = field.key === 'contractAddress' ? text.trim() : parseFloat(text.trim());
        if (field.key !== 'contractAddress' && isNaN(val)) {
          return bot.sendMessage(chatId, '❌ Invalid number. Please try again.');
        }
        if (!session.tradeConfig) session.tradeConfig = {};
        session.tradeConfig[field.key] = val;
        await saveTradeConfigToDb(chatId, session.tradeConfig);
        await bot.sendMessage(chatId,
          panels.tradeSettingsMessage(session),
          { parse_mode: 'Markdown', ...panels.tradeSettingsPanel() }
        );
      }
    };
    return;
  }

  // ─── UNHANDLED ────────────────────────────────────────────────────────────
  console.log(`Unhandled callback: ${data}`);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function generateBuyerWallets(bot, chatId, msgId, session, connection, count) {
  const newBuyers = Array.from({ length: count }, () => {
    const kp = Keypair.generate();
    return { pub: kp.publicKey.toBase58(), priv: base58Encode(kp.secretKey), lastBalance: 0 };
  });

  session.buyers = newBuyers;
  await saveBuyersToDb(chatId, newBuyers);

  const lines = newBuyers.map((b, i) => `${i + 1}. \`${b.pub}\``).join('\n');
  await bot.editMessageText(
    `✅ *${count} Buyer Wallets Generated!*\n\n${lines}\n\nFund these wallets with SOL before trading.`,
    { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...panels.postBuyerMenu() }
  ).catch(() => bot.sendMessage(chatId, `✅ ${count} wallets generated.`, { parse_mode: 'Markdown', ...panels.postBuyerMenu() }));
}

async function handlePaidWalletGeneration(bot, chatId, msgId, session, connection, count, requiredSol) {
  if (!session.mainWallet?.address) {
    return bot.sendMessage(chatId, '❌ No main wallet. Create or import one first.');
  }
  const bal = await getBalance(connection, session.mainWallet.address);
  if (bal < requiredSol) {
    return bot.sendMessage(chatId,
      `❌ *Insufficient Balance*\n\nYou need *${requiredSol} SOL* but have *${bal.toFixed(4)} SOL*.\n\nFund your main wallet first.`,
      { parse_mode: 'Markdown' }
    );
  }
  // For paid tiers, generate wallets (payment verification can be added later)
  await generateBuyerWallets(bot, chatId, msgId, session, connection, count);
}

async function showWalletStatus(bot, chatId, msgId, session, connection) {
  const addr = session.mainWallet?.address;
  if (!addr) {
    return bot.sendMessage(chatId, '❌ No wallet set.');
  }
  const bal = await getBalance(connection, addr);
  const buyerLines = await Promise.all(
    (session.buyers || []).map(async (b, i) => {
      const b_bal = await getBalance(connection, b.pub);
      return `${i + 1}. \`${b.pub.slice(0, 8)}...\` — ${b_bal.toFixed(4)} SOL`;
    })
  );
  const text =
    `📂 *Wallet Status*\n\n` +
    `*Main:* \`${addr}\`\n*Balance:* ${bal.toFixed(4)} SOL\n\n` +
    `*Buyer Bots (${session.buyers.length}):*\n` +
    (buyerLines.length ? buyerLines.join('\n') : '_None generated yet._');

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

async function showBotBalances(bot, chatId, msgId, session, connection) {
  if (!session.buyers?.length) {
    return bot.sendMessage(chatId, '❌ No buyer wallets found.');
  }
  const lines = await Promise.all(
    session.buyers.map(async (b, i) => {
      const bal = await getBalance(connection, b.pub);
      b.lastBalance = bal;
      return `${i + 1}. \`${b.pub.slice(0, 8)}...\` — ${bal.toFixed(4)} SOL`;
    })
  );
  await bot.sendMessage(chatId,
    `📊 *Bot Balances*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
}

async function showTokenBalances(bot, chatId, session, connection) {
  const ca = session.tradeConfig?.contractAddress;
  if (!ca) return bot.sendMessage(chatId, '❌ No contract address set.');

  const { getTokenBalance } = require('../helpers/solana');
  const lines = await Promise.all(
    (session.buyers || []).map(async (b, i) => {
      const bal = await getTokenBalance(connection, b.pub, ca);
      return `${i + 1}. \`${b.pub.slice(0, 8)}...\` — ${bal.toFixed(2)} tokens`;
    })
  );
  await bot.sendMessage(chatId,
    `💰 *Token Balances*\n\nContract: \`${ca}\`\n\n${lines.join('\n') || '_No balances found._'}`,
    { parse_mode: 'Markdown' }
  );
}

async function handleTransfer(bot, chatId, msgId, session, connection) {
  if (!session.buyers?.length) {
    return bot.sendMessage(chatId, '❌ No buyer wallets to transfer from.');
  }
  if (!session.mainWallet?.address) {
    return bot.sendMessage(chatId, '❌ No main wallet set.');
  }

  const prompt = await bot.sendMessage(chatId,
    `🔁 *Transfer SOL to Main Wallet*\n\nEnter amount in SOL to collect from each bot wallet (or "all"):`,
    { parse_mode: 'Markdown' }
  );

  session.pendingInput = {
    resolve: async (text) => {
      await bot.deleteMessage(chatId, prompt.message_id).catch(() => {});
      const { transferFromBuyers } = require('../helpers/solana');
      if (typeof transferFromBuyers !== 'function') {
        return bot.sendMessage(chatId, '⚠️ Transfer function not yet implemented.');
      }
      await transferFromBuyers(bot, connection, session, chatId, text.trim());
    }
  };
}

async function handleDistribute(bot, chatId, session, connection) {
  if (!session.buyers?.length) {
    return bot.sendMessage(chatId, '❌ No buyer wallets to distribute to.');
  }

  const prompt = await bot.sendMessage(chatId,
    `💸 *Distribute SOL*\n\nEnter total SOL amount to distribute evenly across ${session.buyers.length} bot wallets:`,
    { parse_mode: 'Markdown' }
  );

  session.pendingInput = {
    resolve: async (text) => {
      await bot.deleteMessage(chatId, prompt.message_id).catch(() => {});
      const { distributeSol } = require('../helpers/solana');
      if (typeof distributeSol !== 'function') {
        return bot.sendMessage(chatId, '⚠️ Distribute function not yet implemented.');
      }
      await distributeSol(bot, connection, session, chatId, parseFloat(text.trim()));
    }
  };
}

module.exports = callbackHandler;
