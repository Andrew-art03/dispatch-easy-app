/**
 * SHA-256, written out in plain TypeScript — SPEC 4A, R1.
 *
 * `contentHash` has to be computable *inside* `normalizeLoad`, which SPEC 4A
 * freezes as a synchronous pure function. That rules out Web Crypto (async) and
 * it rules out `node:crypto` (a platform import inside `packages/domain/`, which
 * the domain-purity walk exists to keep out — and which would not resolve in the
 * browser bundle the PWA ships). So the hash lives here, ~70 lines of integer
 * arithmetic with no dependency of any kind.
 *
 * FIPS 180-4. Verified against the published test vectors in the suite.
 */

/** First 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** First 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** Lowercase hex SHA-256 of a byte array. */
export function sha256Bytes(input: Uint8Array): string {
  const bitLength = input.length * 8;
  // message + 0x80 + zero padding + 8-byte big-endian length, to a 64-byte multiple
  const padded = new Uint8Array(
    (((input.length + 9) / 64) | 0) * 64 + ((input.length + 9) % 64 === 0 ? 0 : 64),
  );
  padded.set(input, 0);
  padded[input.length] = 0x80;
  // Length is written as a 64-bit big-endian value. Inputs here are rate cons and
  // JSON payloads, so the high word is written from a float-free integer split.
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  const tail = padded.length - 8;
  padded[tail] = (high >>> 24) & 0xff;
  padded[tail + 1] = (high >>> 16) & 0xff;
  padded[tail + 2] = (high >>> 8) & 0xff;
  padded[tail + 3] = high & 0xff;
  padded[tail + 4] = (low >>> 24) & 0xff;
  padded[tail + 5] = (low >>> 16) & 0xff;
  padded[tail + 6] = (low >>> 8) & 0xff;
  padded[tail + 7] = low & 0xff;

  const h = [...H0];
  const w = new Array<number>(64).fill(0);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const b = offset + i * 4;
      w[i] =
        (((padded[b] ?? 0) << 24) |
          ((padded[b + 1] ?? 0) << 16) |
          ((padded[b + 2] ?? 0) << 8) |
          (padded[b + 3] ?? 0)) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0) >>> 0;
    }

    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;

    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
    h[5] = ((h[5] ?? 0) + f) >>> 0;
    h[6] = ((h[6] ?? 0) + g) >>> 0;
    h[7] = ((h[7] ?? 0) + hh) >>> 0;
  }

  return h.map((v) => v.toString(16).padStart(8, "0")).join("");
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
}
