import { describe, expect, it } from 'vitest';
import { IncrementalSha256, sha256BlobStreaming, sha256Chunks } from './crypto';

async function webCryptoSha256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('Streaming SHA-256 Hasher', () => {
  it('hashes empty data correctly matching standard SHA-256 empty digest', () => {
    const hasher = new IncrementalSha256();
    expect(hasher.digest()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes standard test vectors correctly', async () => {
    const vectors = [
      'abc',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      'The quick brown fox jumps over the lazy dog',
      'JustShare Secure P2P File Transfer Protocol Phase 2C Storage Engine',
    ];

    for (const vec of vectors) {
      const bytes = new TextEncoder().encode(vec);
      const expected = await webCryptoSha256(bytes.buffer as ArrayBuffer);

      const hasher = new IncrementalSha256();
      hasher.update(bytes);
      expect(hasher.digest()).toBe(expected);
    }
  });

  it('matches WebCrypto across random data with arbitrary chunk slicing', async () => {
    // Generate 128 KB of deterministic pseudo-random bytes
    const totalSize = 128 * 1024;
    const fullData = new Uint8Array(totalSize);
    for (let i = 0; i < totalSize; i++) {
      fullData[i] = (i * 37 + 13) % 256;
    }

    const expected = await webCryptoSha256(fullData.buffer as ArrayBuffer);

    // Feed in various chunk sizes: 1 byte, 63 bytes, 64 bytes, 65 bytes, 1024 bytes
    const sliceSizes = [1, 63, 64, 65, 1024, 16384, 65536];

    for (const size of sliceSizes) {
      const hasher = new IncrementalSha256();
      let offset = 0;
      while (offset < totalSize) {
        const end = Math.min(offset + size, totalSize);
        hasher.update(fullData.subarray(offset, end));
        offset = end;
      }
      expect(hasher.digest()).toBe(expected);
    }
  });

  it('computes streaming blob SHA-256 identically to full blob arrayBuffer', async () => {
    const data = new Uint8Array(250 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 11) % 256;
    const blob = new Blob([data]);

    const expected = await webCryptoSha256(data.buffer as ArrayBuffer);
    const result = await sha256BlobStreaming(blob);
    expect(result).toBe(expected);
  });

  it('computes sha256Chunks identically', async () => {
    const chunk1 = new Uint8Array([1, 2, 3, 4, 5]);
    const chunk2 = new Uint8Array([6, 7, 8, 9, 10]);
    const combined = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const expected = await webCryptoSha256(combined.buffer as ArrayBuffer);
    const result = await sha256Chunks([chunk1, chunk2]);
    expect(result).toBe(expected);
  });
});
