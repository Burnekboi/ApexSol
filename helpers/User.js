const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },

  // 🎯 THE ACTIVE WALLET: Used for current deployments/trades
  mainWallet: {
    address: { type: String, default: null },
    priv: { type: String, default: null }
  },

  // 📂 WALLET STORAGE: Main wallet slots (max 3) — each may embed buyer bots
  storedWallets: {
    type: Array,
    default: []
  },

  // 🤖 BOT FLEET: Storage for your buyer/swarm bots
  // Format: [{ pub: string, priv: string, lastBalance: number }]
  buyers: {
    type: Array,
    default: []
  },

  tradeConfig: {
    slippage: { type: Number, default: 5 },
    minBuy: { type: Number, default: 0.01 },
    maxBuy: { type: Number, default: 0.05 },
    takeProfitPercent: { type: Number, default: 20 },
    sellPortionPercent: { type: Number, default: 20 },
    contractAddress: { type: String, default: null }
  }
}, { timestamps: true });

// telegramId already has unique: true (creates an index); do not duplicate with schema.index()

module.exports = mongoose.model('User', UserSchema);