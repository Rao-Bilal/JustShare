import { describe, expect, it } from 'vitest';
import {
  createStreamingHasher,
  PureJsIncrementalSha256,
  sha256Blob,
  sha256BlobStreaming,
  sha256Chunks,
  sha256File,
  STREAMING_HASH_SLICE_SIZE,
} from './crypto';

async function webCryptoSha256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('Streaming SHA-256 Hasher (WASM with Pure-JS Fallback)', () => {
  it('hashes empty data correctly matching standard SHA-256 empty digest', async () => {
    const jsHasher = new PureJsIncrementalSha256();
    const wasmHasher = await createStreamingHasher();

    const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(jsHasher.digest()).toBe(expected);
    expect(wasmHasher.digest()).toBe(expected);
    expect(await sha256BlobStreaming(new Blob([]))).toBe(expected);
  });

  it('hashes standard test vectors correctly across both implementations', async () => {
    const vectors = [
      'abc',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      'The quick brown fox jumps over the lazy dog',
      'JustShare Secure P2P File Transfer Protocol Phase 2C Storage Engine',
    ];

    for (const vec of vectors) {
      const bytes = new TextEncoder().encode(vec);
      const expected = await webCryptoSha256(bytes.buffer as ArrayBuffer);

      const jsHasher = new PureJsIncrementalSha256();
      jsHasher.update(bytes);
      expect(jsHasher.digest()).toBe(expected);

      const wasmHasher = await createStreamingHasher();
      wasmHasher.update(bytes);
      expect(wasmHasher.digest()).toBe(expected);
    }
  });

  it(
    'matches digest equality across exact boundary conditions: empty, "abc", 1 byte, exactly 1 block, block+1, >4MB random file',
    async () => {
    const testCases: { name: string; data: Uint8Array }[] = [
      { name: 'empty', data: new Uint8Array(0) },
      { name: 'abc', data: new TextEncoder().encode('abc') },
      { name: '1 byte', data: new Uint8Array([0x42]) },
      { name: 'exactly 1 block (64 bytes)', data: new Uint8Array(64).fill(0x5a) },
      { name: 'block + 1 (65 bytes)', data: new Uint8Array(65).fill(0x7b) },
      {
        name: 'exactly 1 slice block (2 MB)',
        data: (() => {
          const u = new Uint8Array(STREAMING_HASH_SLICE_SIZE);
          for (let i = 0; i < u.length; i++) u[i] = (i * 31) & 0xff;
          return u;
        })(),
      },
      {
        name: 'slice block + 1 (2 MB + 1 byte)',
        data: (() => {
          const u = new Uint8Array(STREAMING_HASH_SLICE_SIZE + 1);
          for (let i = 0; i < u.length; i++) u[i] = (i * 47) & 0xff;
          return u;
        })(),
      },
      {
        name: '>4 MB random file (5 MB)',
        data: (() => {
          const u = new Uint8Array(5 * 1024 * 1024);
          for (let i = 0; i < u.length; i++) u[i] = (i * 73 + 19) & 0xff;
          return u;
        })(),
      },
    ];

    for (const tc of testCases) {
      const expected = await webCryptoSha256(tc.data.buffer as ArrayBuffer);

      // 1. Pure JS
      const jsHasher = new PureJsIncrementalSha256();
      if (tc.data.byteLength > 0) jsHasher.update(tc.data);
      const jsDigest = jsHasher.digest();

      // 2. WASM
      const wasmHasher = await createStreamingHasher();
      if (tc.data.byteLength > 0) wasmHasher.update(tc.data);
      const wasmDigest = wasmHasher.digest();

      // 3. Streaming File / Blob
      const blob = new Blob([tc.data.buffer as ArrayBuffer]);
      const streamingDigest = await sha256Blob(blob);

      // Verify all 3 match WebCrypto and each other identically
      expect(jsDigest, `Pure JS mismatch on ${tc.name}`).toBe(expected);
      expect(wasmDigest, `WASM mismatch on ${tc.name}`).toBe(expected);
      expect(streamingDigest, `Streaming mismatch on ${tc.name}`).toBe(expected);
    }
  }, 20000);

  it('matches WebCrypto across arbitrary chunk slicing', async () => {
    const totalSize = 128 * 1024;
    const fullData = new Uint8Array(totalSize);
    for (let i = 0; i < totalSize; i++) {
      fullData[i] = (i * 37 + 13) % 256;
    }

    const expected = await webCryptoSha256(fullData.buffer as ArrayBuffer);
    const sliceSizes = [1, 63, 64, 65, 1024, 16384, 65536];

    for (const size of sliceSizes) {
      const hasher = await createStreamingHasher();
      let offset = 0;
      while (offset < totalSize) {
        const end = Math.min(offset + size, totalSize);
        hasher.update(fullData.subarray(offset, end));
        offset = end;
      }
      expect(hasher.digest()).toBe(expected);
    }
  });

  it('computes streaming blob SHA-256 with progress callbacks', async () => {
    const data = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 11) % 256;
    const file = new File([data], 'test-progress.bin');

    const expected = await webCryptoSha256(data.buffer as ArrayBuffer);
    const progressReports: number[] = [];

    const result = await sha256File(file, (processed, total) => {
      progressReports.push(Math.round((processed / total) * 100));
    });

    expect(result).toBe(expected);
    expect(progressReports.length).toBeGreaterThan(0);
    expect(progressReports[progressReports.length - 1]).toBe(100);
  });

  it('computes sha256Chunks identically to full arrayBuffer digest', async () => {
    const chunk1 = new Uint8Array([1, 2, 3, 4, 5]);
    const chunk2 = new Uint8Array([6, 7, 8, 9, 10]);
    const combined = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const expected = await webCryptoSha256(combined.buffer as ArrayBuffer);
    const result = await sha256Chunks([chunk1, chunk2]);
    expect(result).toBe(expected);
  });
});
