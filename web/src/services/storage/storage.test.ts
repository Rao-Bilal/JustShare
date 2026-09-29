import { describe, expect, it } from 'vitest';
import { TransferManifest } from '../../types';
import { IncrementalSha256 } from '../crypto';
import { MemoryTransferStorage } from './memory';
import { TransferStorage } from './types';

describe('TransferStorage Implementations', () => {
  const runStorageTestSuite = (name: string, createStorage: () => Promise<TransferStorage>) => {
    describe(name, () => {
      it('creates and retrieves transfer metadata', async () => {
        const storage = await createStorage();
        const manifest: TransferManifest = {
          transferId: 'tx-storage-test-1',
          totalFiles: 2,
          totalSize: 1000,
          files: [
            {
              id: 'f-1',
              name: 'a.txt',
              size: 400,
              mimeType: 'text/plain',
              totalChunks: 1,
              sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
            {
              id: 'f-2',
              name: 'b.txt',
              size: 600,
              mimeType: 'text/plain',
              totalChunks: 2,
              sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
          ],
        };

        await storage.createTransfer(manifest);
        const stored = await storage.getTransfer('tx-storage-test-1');
        expect(stored).not.toBeNull();
        expect(stored?.transferId).toBe('tx-storage-test-1');
        expect(stored?.files.size).toBe(2);
        expect(stored?.files.get('f-1')?.name).toBe('a.txt');
      });

      it('writes chunks, lists received chunks, and reports missing chunks', async () => {
        const storage = await createStorage();
        const manifest: TransferManifest = {
          transferId: 'tx-chunk-test',
          totalFiles: 1,
          totalSize: 300,
          files: [
            {
              id: 'f-multi',
              name: 'multi.bin',
              size: 300,
              mimeType: 'application/octet-stream',
              totalChunks: 3,
              sha256: 'abc...',
            },
          ],
        };

        await storage.createTransfer(manifest);

        // Initially all 3 chunks missing
        let missing = await storage.getMissingChunks('tx-chunk-test', 'f-multi', 3);
        expect(missing).toEqual([0, 1, 2]);

        // Write chunk 0 and 2 (out of order, missing chunk 1)
        const chunk0 = new Uint8Array([1, 2, 3]);
        const chunk2 = new Uint8Array([7, 8, 9]);

        await storage.writeChunk('tx-chunk-test', 'f-multi', 0, chunk0);
        await storage.writeChunk('tx-chunk-test', 'f-multi', 2, chunk2);

        expect(await storage.hasChunk('tx-chunk-test', 'f-multi', 0)).toBe(true);
        expect(await storage.hasChunk('tx-chunk-test', 'f-multi', 1)).toBe(false);
        expect(await storage.hasChunk('tx-chunk-test', 'f-multi', 2)).toBe(true);

        const received = await storage.getReceivedChunks('tx-chunk-test', 'f-multi');
        expect(received).toEqual([0, 2]);

        missing = await storage.getMissingChunks('tx-chunk-test', 'f-multi', 3);
        expect(missing).toEqual([1]);

        // Idempotent duplicate chunk write
        await storage.writeChunk('tx-chunk-test', 'f-multi', 0, chunk0);
        expect(await storage.getReceivedChunks('tx-chunk-test', 'f-multi')).toEqual([0, 2]);
      });

      it('verifies and finalizes completed files with SHA-256 integrity check', async () => {
        const storage = await createStorage();
        const chunk0 = new Uint8Array([10, 20, 30]);
        const chunk1 = new Uint8Array([40, 50, 60]);

        const hasher = new IncrementalSha256();
        hasher.update(chunk0);
        hasher.update(chunk1);
        const expectedHash = hasher.digest();

        const manifest: TransferManifest = {
          transferId: 'tx-finalize-test',
          totalFiles: 1,
          totalSize: 6,
          files: [
            {
              id: 'f-fin',
              name: 'final.bin',
              size: 6,
              mimeType: 'application/octet-stream',
              totalChunks: 2,
              sha256: expectedHash,
            },
          ],
        };

        await storage.createTransfer(manifest);
        await storage.writeChunk('tx-finalize-test', 'f-fin', 0, chunk0);
        await storage.writeChunk('tx-finalize-test', 'f-fin', 1, chunk1);

        const result = await storage.verifyAndFinalizeFile('tx-finalize-test', 'f-fin', expectedHash);
        expect(result.match).toBe(true);
        expect(result.calculatedSha256).toBe(expectedHash);
        expect(result.blob.size).toBe(6);

        const storedBlob = await storage.getFinalizedBlob('tx-finalize-test', 'f-fin');
        expect(storedBlob).not.toBeNull();
        expect(storedBlob?.size).toBe(6);
      });

      it('fails verification and does not finalize if SHA-256 does not match', async () => {
        const storage = await createStorage();
        const chunk0 = new Uint8Array([1, 2, 3]);

        const manifest: TransferManifest = {
          transferId: 'tx-fail-test',
          totalFiles: 1,
          totalSize: 3,
          files: [
            {
              id: 'f-bad',
              name: 'bad.bin',
              size: 3,
              mimeType: 'application/octet-stream',
              totalChunks: 1,
              sha256: '0000000000000000000000000000000000000000000000000000000000000000',
            },
          ],
        };

        await storage.createTransfer(manifest);
        await storage.writeChunk('tx-fail-test', 'f-bad', 0, chunk0);

        const result = await storage.verifyAndFinalizeFile(
          'tx-fail-test',
          'f-bad',
          '0000000000000000000000000000000000000000000000000000000000000000'
        );
        expect(result.match).toBe(false);

        const blob = await storage.getFinalizedBlob('tx-fail-test', 'f-bad');
        expect(blob).toBeNull();
      });

      it('deletes transfer and cleans up associated chunks and metadata', async () => {
        const storage = await createStorage();
        const manifest: TransferManifest = {
          transferId: 'tx-delete-test',
          totalFiles: 1,
          totalSize: 10,
          files: [
            {
              id: 'f-del',
              name: 'del.bin',
              size: 10,
              mimeType: 'text/plain',
              totalChunks: 1,
              sha256: '...',
            },
          ],
        };

        await storage.createTransfer(manifest);
        await storage.writeChunk('tx-delete-test', 'f-del', 0, new Uint8Array(10));

        expect(await storage.getTransfer('tx-delete-test')).not.toBeNull();
        expect(await storage.hasChunk('tx-delete-test', 'f-del', 0)).toBe(true);

        await storage.deleteTransfer('tx-delete-test');

        expect(await storage.getTransfer('tx-delete-test')).toBeNull();
        expect(await storage.hasChunk('tx-delete-test', 'f-del', 0)).toBe(false);
      });

      describe('verifyAndFinalizeFile chunk batching & boundary test suite', () => {
        const createMultiChunkTest = (totalChunks: number, chunkSize = 16) => {
          return async () => {
            const storage = await createStorage();
            const txId = `tx-batch-${totalChunks}`;
            const fileId = `f-batch-${totalChunks}`;

            const hasher = new IncrementalSha256();
            const chunks: Uint8Array[] = [];
            let totalBytes = 0;

            for (let i = 0; i < totalChunks; i++) {
              const chunk = new Uint8Array(chunkSize);
              for (let b = 0; b < chunkSize; b++) {
                chunk[b] = (i * 17 + b * 3) & 0xff;
              }
              chunks.push(chunk);
              hasher.update(chunk);
              totalBytes += chunkSize;
            }

            const expectedHash = hasher.digest();

            const manifest: TransferManifest = {
              transferId: txId,
              totalFiles: 1,
              totalSize: totalBytes,
              files: [
                {
                  id: fileId,
                  name: `test-${totalChunks}.bin`,
                  size: totalBytes,
                  mimeType: 'application/octet-stream',
                  totalChunks,
                  sha256: expectedHash,
                },
              ],
            };

            await storage.createTransfer(manifest);
            for (let i = 0; i < totalChunks; i++) {
              await storage.writeChunk(txId, fileId, i, chunks[i]);
            }

            let progressCallCount = 0;
            let lastProcessed = 0;
            const result = await storage.verifyAndFinalizeFile(
              txId,
              fileId,
              expectedHash,
              (bytesProcessed, total) => {
                progressCallCount++;
                lastProcessed = bytesProcessed;
                expect(total).toBe(totalBytes);
              }
            );

            expect(result.match).toBe(true);
            expect(result.calculatedSha256).toBe(expectedHash);
            expect(result.blob.size).toBe(totalBytes);

            if (totalChunks > 0) {
              expect(progressCallCount).toBe(totalChunks);
              expect(lastProcessed).toBe(totalBytes);
            }

            const finalizedBlob = await storage.getFinalizedBlob(txId, fileId);
            expect(finalizedBlob).not.toBeNull();
            expect(finalizedBlob?.size).toBe(totalBytes);
          };
        };

        it('verifies 0-chunk (0-byte) file correctly', createMultiChunkTest(0));
        it('verifies 1-chunk file correctly', createMultiChunkTest(1));
        it('verifies exactly 1 batch size (200 chunks) correctly', createMultiChunkTest(200, 8));
        it('verifies batch size + 1 (201 chunks) correctly', createMultiChunkTest(201, 8));
        it('verifies >2 batches (450 chunks) correctly with correct digest', createMultiChunkTest(450, 8));

        it('throws descriptive error on missing chunks during verify', async () => {
          const storage = await createStorage();
          const txId = 'tx-err-missing';
          const fileId = 'f-err-missing';

          const manifest: TransferManifest = {
            transferId: txId,
            totalFiles: 1,
            totalSize: 30,
            files: [
              {
                id: fileId,
                name: 'missing.bin',
                size: 30,
                mimeType: 'text/plain',
                totalChunks: 3,
                sha256: 'somehash',
              },
            ],
          };

          await storage.createTransfer(manifest);
          await storage.writeChunk(txId, fileId, 0, new Uint8Array(10));
          // chunk 1 is missing
          await storage.writeChunk(txId, fileId, 2, new Uint8Array(10));

          await expect(
            storage.verifyAndFinalizeFile(txId, fileId, 'somehash')
          ).rejects.toThrow();
        });
      });
    });
  };

  runStorageTestSuite('MemoryTransferStorage', async () => {
    const mem = new MemoryTransferStorage();
    await mem.init();
    return mem;
  });
});
