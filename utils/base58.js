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
  try {
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
  } catch (err) {
    console.error('❌ Base58 Decode Error:', err.message);
    throw new Error('Invalid Base58 private key format');
  }
}

module.exports = {
  base58Encode,
  base58Decode,
  encode: base58Encode,
  decode: base58Decode
};