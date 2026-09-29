import { createSHA256 } from 'hash-wasm';

export interface IStreamingHasher {
  readonly implementationName: string;
  update(chunk: Uint8Array): this;
  digest(): string;
}

// Pure TypeScript Streaming SHA-256 fallback (FIPS 180-4 compliant)
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class PureJsIncrementalSha256 implements IStreamingHasher {
  readonly implementationName = 'PureJsIncrementalSha256';
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;

  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalBytesLow = 0;
  private totalBytesHigh = 0;
  private w = new Uint32Array(64);

  update(chunk: Uint8Array): this {
    let offset = 0;
    let length = chunk.byteLength;

    this.totalBytesLow += length;
    if (this.totalBytesLow >= 0x100000000) {
      this.totalBytesHigh += Math.floor(this.totalBytesLow / 0x100000000);
      this.totalBytesLow = this.totalBytesLow >>> 0;
    }

    if (this.bufferLength > 0) {
      const needed = 64 - this.bufferLength;
      if (length >= needed) {
        this.buffer.set(chunk.subarray(0, needed), this.bufferLength);
        this.processBlock(this.buffer, 0);
        offset += needed;
        length -= needed;
        this.bufferLength = 0;
      } else {
        this.buffer.set(chunk, this.bufferLength);
        this.bufferLength += length;
        return this;
      }
    }

    while (length >= 64) {
      this.processBlock(chunk, offset);
      offset += 64;
      length -= 64;
    }

    if (length > 0) {
      this.buffer.set(chunk.subarray(offset, offset + length), 0);
      this.bufferLength = length;
    }

    return this;
  }

  private processBlock(block: Uint8Array, offset: number): void {
    const w = this.w;

    for (let i = 0; i < 16; i++) {
      const idx = offset + (i << 2);
      w[i] = (block[idx] << 24) | (block[idx + 1] << 16) | (block[idx + 2] << 8) | block[idx + 3];
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15];
      const g0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const w2 = w[i - 2];
      const g1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (g1 + w[i - 7] + g0 + w[i - 16]) >>> 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;

    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const chVal = (e & f) ^ (~e & g);
      const t1 = (h + s1 + chVal + K[i] + w[i]) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majVal = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majVal) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }

  digest(): string {
    const totalBitsLow = (this.totalBytesLow << 3) >>> 0;
    const totalBitsHigh = ((this.totalBytesHigh << 3) | (this.totalBytesLow >>> 29)) >>> 0;

    const pad = new Uint8Array(128);
    pad[0] = 0x80;

    const padLength = this.bufferLength < 56 ? 56 - this.bufferLength : 120 - this.bufferLength;
    this.update(pad.subarray(0, padLength));

    const lenBlock = new Uint8Array(8);
    const view = new DataView(lenBlock.buffer);
    view.setUint32(0, totalBitsHigh, false);
    view.setUint32(4, totalBitsLow, false);

    this.update(lenBlock);

    const parts = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    return parts.map((x) => x.toString(16).padStart(8, '0')).join('');
  }
}

// Preserve IncrementalSha256 export for full backward compatibility
export class IncrementalSha256 extends PureJsIncrementalSha256 {}

/**
 * Creates an optimized streaming SHA-256 instance powered by WebAssembly (hash-wasm)
 * with transparent fallback to pure-JS if WASM is unavailable.
 */
export async function createStreamingHasher(): Promise<IStreamingHasher> {
  try {
    const wasmHasher = await createSHA256();
    wasmHasher.init();
    const instance: IStreamingHasher = {
      implementationName: 'hash-wasm (createSHA256)',
      update(chunk: Uint8Array): IStreamingHasher {
        wasmHasher.update(chunk);
        return instance;
      },
      digest(): string {
        return wasmHasher.digest('hex');
      },
    };
    return instance;
  } catch (err) {
    console.warn('[CRYPTO] Failed to initialize hash-wasm WebAssembly SHA-256. Falling back to pure-JS:', err);
    return new PureJsIncrementalSha256();
  }
}

export const STREAMING_HASH_SLICE_SIZE = 2 * 1024 * 1024; // 2 MB blocks

/**
 * Stream-reads a Blob or File in 2 MB slices to compute SHA-256 with WASM acceleration.
 */
export async function sha256BlobStreaming(
  blob: Blob,
  onProgress?: (bytesProcessed: number, totalBytes: number) => void
): Promise<string> {
  const total = blob.size;

  if (total === 0) {
    return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  }

  const hasher = await createStreamingHasher();
  let offset = 0;

  while (offset < total) {
    const end = Math.min(offset + STREAMING_HASH_SLICE_SIZE, total);
    const slice = blob.slice(offset, end);
    const buffer = await slice.arrayBuffer();
    hasher.update(new Uint8Array(buffer));
    offset = end;
    if (onProgress) {
      onProgress(offset, total);
    }
  }

  return hasher.digest();
}

export async function sha256File(
  file: File,
  onProgress?: (bytesProcessed: number, totalBytes: number) => void
): Promise<string> {
  return sha256BlobStreaming(file, onProgress);
}

export async function sha256Blob(
  blob: Blob,
  onProgress?: (bytesProcessed: number, totalBytes: number) => void
): Promise<string> {
  return sha256BlobStreaming(blob, onProgress);
}

export async function sha256Chunks(chunks: Uint8Array[]): Promise<string> {
  const hasher = await createStreamingHasher();
  for (const chunk of chunks) {
    if (chunk instanceof Uint8Array) {
      hasher.update(chunk);
    }
  }
  return hasher.digest();
}
