const User = require('./User');

const MAX_STORED_WALLETS = 3;

function normalizeBuyer(b) {
  if (!b) return null;
  return {
    pub: b.pub || b.address,
    priv: b.priv || b.privateKey,
    lastBalance: b.lastBalance || 0
  };
}

/**
 * Normalize DB storedWallets into [{ address, priv, buyers }] (max 3).
 * Legacy: entries without buyers inherit global buyers when address matches main.
 */
function normalizeStoredWallets(dbStored, globalBuyers, mainAddr) {
  const gb = (globalBuyers || []).map(normalizeBuyer).filter(Boolean);
  const raw = Array.isArray(dbStored) ? dbStored : [];
  const out = [];
  for (const w of raw) {
    const address = w.address || w.publicKey;
    const priv = w.priv || w.privateKey;
    if (!address || !priv) continue;
    let buyers = Array.isArray(w.buyers) ? w.buyers.map(normalizeBuyer).filter(Boolean) : [];
    if (!buyers.length && mainAddr && address === mainAddr && gb.length) {
      buyers = gb;
    }
    out.push({ address, priv, buyers });
  }
  return out.slice(0, MAX_STORED_WALLETS);
}

async function loadNormalizedStored(chatId) {
  const u = await User.findOne({ telegramId: chatId.toString() });
  if (!u) return [];
  const mainAddr = u.mainWallet?.address || u.mainWallet?.publicKey || null;
  return normalizeStoredWallets(u.storedWallets || [], u.buyers || [], mainAddr);
}

async function persistStoredWallets(chatId, list) {
  await User.findOneAndUpdate(
    { telegramId: chatId.toString() },
    { $set: { storedWallets: list.slice(0, MAX_STORED_WALLETS) } },
    { upsert: true }
  );
}

module.exports = {
  MAX_STORED_WALLETS,
  normalizeBuyer,
  normalizeStoredWallets,
  loadNormalizedStored,
  persistStoredWallets
};
