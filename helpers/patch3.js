const fs = require('fs');
const file = 'c:/Users/Christian Jake/OneDrive/Desktop/CUCUMVERSE-RUNNING/cucumber bot/helpers/solana.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Rewrite sendJitoBundle logic completely
const sIdx = content.indexOf('async function sendJitoBundle');
const eIdx = content.indexOf('async function handleDeployRequest');

if (sIdx !== -1 && eIdx !== -1) {
    const before = content.substring(0, sIdx);
    const after = content.substring(content.lastIndexOf('/**\n * ===============================\n * 🚀 MAIN DEPLOYMENT HANDLER', eIdx));

    const newCode = `async function sendJitoBundle({ payer, instructions, connection, additionalSigners = [], maxRetries = 3 }) {
  const bs58 = require('bs58');
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { blockhash } = await connection.getLatestBlockhash("finalized");

      console.log('🔧 Building ATOMIC transaction...');
      const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: instructions,
      }).compileToV0Message();

      const tx = new VersionedTransaction(msg);
      
      const signers = [payer];
      if (additionalSigners && additionalSigners.length > 0) {
        signers.push(...additionalSigners);
      }
      
      console.log('📝 Signing ATOMIC transaction with signers length:', signers.length);
      tx.sign(signers);
      console.log('✅ ATOMIC transaction signed successfully');

      // 📦 BUNDLE ORDER: ONE TRANSACTION
      console.log('🔍 Debug - Building Jito bundle payload...');
      
      // Jito requires base58
      const serialized = bs58.default ? bs58.default.encode(tx.serialize()) : bs58.encode(tx.serialize());
      const bundle = [serialized];

      // 🚀 SEND TO JITO
      const response = await fetch('https://mainnet.block-engine.jito.wtf/api/v1/bundles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [bundle]
        }),
      });

      const data = await response.json();
      
      if (data.error) throw new Error(data.error.message);
      if (!data.result) throw new Error('No result returned from Jito bundle');

      console.log('✅ Bundle sent successfully:', data.result);
      return { success: true, signature: data.result };
      
    } catch (err) {
      console.error(\`❌ Bundle attempt \${attempt} failed:\`, err.message);
      if (attempt === maxRetries) return { success: false, error: err.message };
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

`;

    content = before + newCode + after;
    console.log("Patched sendJitoBundle successfully");
} else {
    console.log("Could not find start or end index for sendJitoBundle");
}

// 2. Patch buildBuyInstruction 
content = content.replace(
    /const \[globalVolumeAccumulator\] = PublicKey\.findProgramAddressSync\(\s*\[Buffer\.from\('global_volume_accumulator'\)\],\s*PUMP_PROGRAM\s*\);\s*ix\.keys\.push\(\{\s*pubkey: globalVolumeAccumulator,\s*isSigner: false,\s*isWritable: true\s*\}\);/g,
    `const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM);
          const [bondingCurveV2] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), typeof mint === 'string' ? new PublicKey(mint).toBuffer() : mint.toBuffer()], PUMP_PROGRAM);
          
          ix.keys.push({ pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true });
          ix.keys.push({ pubkey: bondingCurveV2, isSigner: false, isWritable: true });`
);

// 3. Patch sellTokenAmount (it needs new PublicKey(contractAddress) rather than mint)
content = content.replace(
    /ix\.keys\.push\(\{\s*pubkey: globalVolumeAccumulator,\s*isSigner: false,\s*isWritable: true\s*\}\);\s*\}\s*\n\s*\/\/ THE FIX END/g, // That string isn't there, I will use precise replace.
    ""
);

content = content.replace(
    /const \[globalVolumeAccumulator\] = PublicKey\.findProgramAddressSync\(\s*\[Buffer\.from\('global_volume_accumulator'\)\],\s*PUMP_PROGRAM\s*\);\s*ix\.keys\.push\(\{\s*pubkey: globalVolumeAccumulator,\s*isSigner: false,\s*isWritable: true\s*\}\);/g,
    `const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM);
          
          // Need to handle mint context based on whether we are in buildBuyInstruction or sellTokenAmount
          let mintBuffer;
          try {
             mintBuffer = typeof mint !== 'undefined' ? (typeof mint === 'string' ? new PublicKey(mint).toBuffer() : mint.toBuffer()) : new PublicKey(contractAddress).toBuffer();
          } catch(e) {
             mintBuffer = new PublicKey(contractAddress).toBuffer();
          }
          const [bondingCurveV2] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), mintBuffer], PUMP_PROGRAM);
          
          ix.keys.push({ pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true });
          ix.keys.push({ pubkey: bondingCurveV2, isSigner: false, isWritable: true });`
);

fs.writeFileSync(file, content, 'utf8');
console.log("Done");
