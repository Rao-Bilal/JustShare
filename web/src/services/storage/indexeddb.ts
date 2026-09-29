import { ManifestFileEntry, TransferManifest } from '../../types';
import { createStreamingHasher } from '../crypto';
import { StoredFileInfo, StoredTransferInfo, TransferStorage } from './types';

const DB_NAME = 'justshare_storage_v1';
const DB_VERSION = 1;
export const VERIFY_BATCH_SIZE = 200;

export class IndexedDBTransferStorage implements TransferStorage {
  readonly name = 'IndexedDBTransferStorage';
  readonly isPersistent = true;

  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB is not supported in this environment'));
          return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;

          if (!db.objectStoreNames.contains('transfers')) {
            db.createObjectStore('transfers', { keyPath: 'transferId' });
          }

          if (!db.objectStoreNames.contains('files')) {
            const fileStore = db.createObjectStore('files', { keyPath: ['transferId', 'fileId'] });
            fileStore.createIndex('by_transferId', 'transferId', { unique: false });
          }

          if (!db.objectStoreNames.contains('chunks')) {
            const chunkStore = db.createObjectStore('chunks', { keyPath: ['transferId', 'fileId', 'index'] });
            chunkStore.createIndex('by_file', ['transferId', 'fileId'], { unique: false });
          }

          if (!db.objectStoreNames.contains('blobs')) {
            db.createObjectStore('blobs', { keyPath: ['transferId', 'fileId'] });
          }
        };

        request.onsuccess = () => {
          this.db = request.result;
          resolve(request.result);
        };

        request.onerror = () => {
          reject(request.error || new Error('Failed to open IndexedDB'));
        };
      });
    }
    await this.dbPromise;
  }

  private async getDB(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.init();
    }
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }
    return this.db;
  }

  async createTransfer(manifest: TransferManifest): Promise<void> {
    const db = await this.getDB();
    const existing = await this.getTransfer(manifest.transferId);
    if (existing) return;

    const now = Date.now();
    const transferRecord = {
      transferId: manifest.transferId,
      manifest,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    };

    const tx = db.transaction(['transfers', 'files'], 'readwrite');
    const transfersStore = tx.objectStore('transfers');
    const filesStore = tx.objectStore('files');

    transfersStore.put(transferRecord);

    for (const f of manifest.files) {
      const fileRecord: StoredFileInfo = {
        id: f.id,
        name: f.name,
        size: f.size,
        totalChunks: f.totalChunks,
        chunkSize: 65536,
        sha256: f.sha256,
        mimeType: f.mimeType,
        completed: false,
        receivedChunksCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      filesStore.put({
        transferId: manifest.transferId,
        fileId: f.id,
        metadata: fileRecord,
        completed: false,
        sha256: f.sha256,
        updatedAt: now,
      });
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getTransfer(transferId: string): Promise<StoredTransferInfo | null> {
    const db = await this.getDB();

    return new Promise<StoredTransferInfo | null>((resolve, reject) => {
      const tx = db.transaction(['transfers', 'files'], 'readonly');
      const transfersStore = tx.objectStore('transfers');
      const filesStore = tx.objectStore('files');
      const fileIndex = filesStore.index('by_transferId');

      const transferReq = transfersStore.get(transferId);

      transferReq.onsuccess = () => {
        const transferData = transferReq.result;
        if (!transferData) {
          resolve(null);
          return;
        }

        const filesReq = fileIndex.getAll(transferId);
        filesReq.onsuccess = () => {
          const filesList = filesReq.result || [];
          const filesMap = new Map<string, StoredFileInfo>();
          for (const item of filesList) {
            filesMap.set(item.fileId, item.metadata);
          }

          resolve({
            transferId: transferData.transferId,
            manifest: transferData.manifest,
            status: transferData.status,
            createdAt: transferData.createdAt,
            updatedAt: transferData.updatedAt,
            files: filesMap,
          });
        };
        filesReq.onerror = () => reject(filesReq.error);
      };

      transferReq.onerror = () => reject(transferReq.error);
    });
  }

  async listActiveTransfers(): Promise<string[]> {
    const db = await this.getDB();
    return new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(['transfers'], 'readonly');
      const store = tx.objectStore('transfers');
      const request = store.openCursor();
      const active: string[] = [];

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (cursor.value.status === 'in_progress') {
            active.push(cursor.value.transferId);
          }
          cursor.continue();
        } else {
          resolve(active);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async initFile(transferId: string, file: ManifestFileEntry): Promise<void> {
    const db = await this.getDB();
    const now = Date.now();

    const tx = db.transaction(['files'], 'readwrite');
    const store = tx.objectStore('files');
    const key = [transferId, file.id];

    const getReq = store.get(key);
    getReq.onsuccess = () => {
      if (!getReq.result) {
        const fileRecord: StoredFileInfo = {
          id: file.id,
          name: file.name,
          size: file.size,
          totalChunks: file.totalChunks,
          chunkSize: 65536,
          sha256: file.sha256,
          mimeType: file.mimeType,
          completed: false,
          receivedChunksCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        store.put({
          transferId,
          fileId: file.id,
          metadata: fileRecord,
          completed: false,
          sha256: file.sha256,
          updatedAt: now,
        });
      }
    };

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async writeChunk(transferId: string, fileId: string, index: number, data: Uint8Array): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(['chunks', 'files'], 'readwrite');
    const chunksStore = tx.objectStore('chunks');
    const filesStore = tx.objectStore('files');

    const chunkKey = [transferId, fileId, index];
    const checkReq = chunksStore.get(chunkKey);

    checkReq.onsuccess = () => {
      if (!checkReq.result) {
        chunksStore.put({
          transferId,
          fileId,
          index,
          data,
          byteLength: data.byteLength,
        });

        const fileReq = filesStore.get([transferId, fileId]);
        fileReq.onsuccess = () => {
          if (fileReq.result) {
            const rec = fileReq.result;
            rec.metadata.receivedChunksCount += 1;
            rec.metadata.updatedAt = Date.now();
            filesStore.put(rec);
          }
        };
      }
    };

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async hasChunk(transferId: string, fileId: string, index: number): Promise<boolean> {
    const db = await this.getDB();
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(['chunks'], 'readonly');
      const store = tx.objectStore('chunks');
      const request = store.getKey([transferId, fileId, index]);
      request.onsuccess = () => resolve(!!request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getReceivedChunks(transferId: string, fileId: string): Promise<number[]> {
    const db = await this.getDB();
    return new Promise<number[]>((resolve, reject) => {
      const tx = db.transaction(['chunks'], 'readonly');
      const store = tx.objectStore('chunks');
      const index = store.index('by_file');
      const range = IDBKeyRange.only([transferId, fileId]);
      const request = index.openKeyCursor(range);
      const indices: number[] = [];

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          // Primary key is [transferId, fileId, chunkIndex]
          const pk = cursor.primaryKey as [string, string, number];
          indices.push(pk[2]);
          cursor.continue();
        } else {
          indices.sort((a, b) => a - b);
          resolve(indices);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getMissingChunks(transferId: string, fileId: string, totalChunks: number): Promise<number[]> {
    const received = await this.getReceivedChunks(transferId, fileId);
    const receivedSet = new Set(received);
    const missing: number[] = [];

    for (let i = 0; i < totalChunks; i++) {
      if (!receivedSet.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  async verifyAndFinalizeFile(
    transferId: string,
    fileId: string,
    expectedSha256: string,
    onProgress?: (bytesProcessed: number, totalBytes: number) => void
  ): Promise<{ match: boolean; calculatedSha256: string; blob: Blob }> {
    const t0 = performance.now();
    console.log(`[TRANSFER][RECV][VERIFY] START fileId=${fileId}`);
    const db = await this.getDB();
    const transfer = await this.getTransfer(transferId);
    if (!transfer) throw new Error(`Transfer '${transferId}' not found`);
    const file = transfer.files.get(fileId);
    if (!file) throw new Error(`File '${fileId}' not found`);

    if (file.totalChunks === 0 && file.size === 0) {
      const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const match = emptyHash.toLowerCase() === expectedSha256.toLowerCase();
      const blob = new Blob([], { type: file.mimeType });
      if (match) {
        await this.storeFinalizedBlob(transferId, fileId, blob);
        await this.markFileComplete(transferId, fileId);
      }
      return { match, calculatedSha256: emptyHash, blob };
    }

    const hasher = await createStreamingHasher();
    console.log(`[TRANSFER][RECV][VERIFY] START fileId=${fileId} hasher=${hasher.implementationName}`);
    const chunkParts: Uint8Array[] = [];
    let bytesProcessed = 0;
    let expectedIndex = 0;
    const batchSize = VERIFY_BATCH_SIZE;

    let totalGetAllTimeMs = 0;
    let totalHasherUpdateTimeMs = 0;
    let totalOnProgressTimeMs = 0;

    console.log(`[TRANSFER][RECV][VERIFY] reading chunks in batches of ${batchSize}`);
    while (expectedIndex < file.totalChunks) {
      const batchStartIndex = expectedIndex;
      const batchEndIndex = Math.min(file.totalChunks - 1, batchStartIndex + batchSize - 1);
      const batchRange = IDBKeyRange.bound(
        [transferId, fileId, batchStartIndex],
        [transferId, fileId, batchEndIndex]
      );

      const tGetAllStart = performance.now();
      const batchRecords = await new Promise<{ index: number; data: Uint8Array; byteLength: number }[]>((resolve, reject) => {
        const tx = db.transaction(['chunks'], 'readonly');
        const store = tx.objectStore('chunks');
        const req = store.getAll(batchRange);

        req.onsuccess = () => {
          resolve(req.result as { index: number; data: Uint8Array; byteLength: number }[]);
        };
        req.onerror = () => reject(req.error);
      });
      totalGetAllTimeMs += performance.now() - tGetAllStart;

      const expectedBatchCount = batchEndIndex - batchStartIndex + 1;
      if (batchRecords.length !== expectedBatchCount) {
        throw new Error(`Missing chunks: received ${expectedIndex + batchRecords.length} of ${file.totalChunks}`);
      }

      for (let b = 0; b < batchRecords.length; b++) {
        const rec = batchRecords[b];
        if (rec.index !== expectedIndex) {
          throw new Error(`Missing or out-of-order chunk: expected ${expectedIndex}, got ${rec.index}`);
        }
        const chunkData = rec.data as Uint8Array;
        
        const tHashStart = performance.now();
        hasher.update(chunkData);
        totalHasherUpdateTimeMs += performance.now() - tHashStart;

        chunkParts.push(chunkData);
        bytesProcessed += chunkData.byteLength;
        expectedIndex++;

        if (expectedIndex % 500 === 0 || expectedIndex === file.totalChunks) {
          console.log(`[TRANSFER][RECV][VERIFY] processed chunk ${expectedIndex}/${file.totalChunks} (${(performance.now() - t0).toFixed(0)}ms)`);
        }

        if (onProgress) {
          const tProgStart = performance.now();
          onProgress(bytesProcessed, file.size);
          totalOnProgressTimeMs += performance.now() - tProgStart;
        }
      }
    }

    const tDigestStart = performance.now();
    const calculatedSha256 = hasher.digest();
    const digestTimeMs = performance.now() - tDigestStart;
    const match = calculatedSha256.toLowerCase() === expectedSha256.toLowerCase();
    const verifyDuration = performance.now() - t0;
    const everythingElseMs = verifyDuration - (totalGetAllTimeMs + totalHasherUpdateTimeMs + totalOnProgressTimeMs);

    console.log(`[TRANSFER][RECV][VERIFY] SHA256 complete match=${match} calculated=${calculatedSha256} elapsed=${verifyDuration.toFixed(0)}ms`);
    console.log(
      `[TRANSFER][RECV][VERIFY][TIMING_BREAKDOWN] fileId=${fileId} totalVerifyMs=${verifyDuration.toFixed(2)}ms ` +
      `| getAllAwaitsMs=${totalGetAllTimeMs.toFixed(2)}ms ` +
      `| hasherUpdateMs=${totalHasherUpdateTimeMs.toFixed(2)}ms ` +
      `| onProgressMs=${totalOnProgressTimeMs.toFixed(2)}ms ` +
      `| everythingElseMs=${everythingElseMs.toFixed(2)}ms ` +
      `| (digestTime=${digestTimeMs.toFixed(2)}ms)`
    );

    if (!match) {
      return { match: false, calculatedSha256, blob: new Blob() };
    }

    const tFinalize = performance.now();
    console.log(`[TRANSFER][RECV][FINALIZE] START fileId=${fileId}`);
    const blob = new Blob(chunkParts as unknown as BlobPart[], { type: file.mimeType });
    await this.storeFinalizedBlob(transferId, fileId, blob);
    await this.markFileComplete(transferId, fileId);
    console.log(`[TRANSFER][RECV][FINALIZE] COMPLETE fileId=${fileId} elapsed=${(performance.now() - tFinalize).toFixed(0)}ms`);

    return { match: true, calculatedSha256, blob };
  }

  private async storeFinalizedBlob(transferId: string, fileId: string, blob: Blob): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(['blobs'], 'readwrite');
    const store = tx.objectStore('blobs');
    store.put({
      transferId,
      fileId,
      blob,
      createdAt: Date.now(),
    });

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async markFileComplete(transferId: string, fileId: string): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(['files', 'transfers'], 'readwrite');
    const filesStore = tx.objectStore('files');
    const transfersStore = tx.objectStore('transfers');

    const fileReq = filesStore.get([transferId, fileId]);
    fileReq.onsuccess = () => {
      if (fileReq.result) {
        const item = fileReq.result;
        item.completed = true;
        item.metadata.completed = true;
        item.updatedAt = Date.now();
        filesStore.put(item);
      }
    };

    // Check if transfer complete
    const transferReq = transfersStore.get(transferId);
    transferReq.onsuccess = () => {
      if (transferReq.result) {
        const t = transferReq.result;
        const fileIndex = filesStore.index('by_transferId');
        const allFilesReq = fileIndex.getAll(transferId);
        allFilesReq.onsuccess = () => {
          const files = allFilesReq.result || [];
          if (files.length > 0 && files.every((f) => f.completed)) {
            t.status = 'completed';
            t.updatedAt = Date.now();
            transfersStore.put(t);
          }
        };
      }
    };

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getFinalizedBlob(transferId: string, fileId: string): Promise<Blob | null> {
    const db = await this.getDB();
    return new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(['blobs'], 'readonly');
      const store = tx.objectStore('blobs');
      const request = store.get([transferId, fileId]);
      request.onsuccess = () => {
        resolve(request.result ? request.result.blob : null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteTransfer(transferId: string): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(['transfers', 'files', 'chunks', 'blobs'], 'readwrite');
    const transfersStore = tx.objectStore('transfers');
    const filesStore = tx.objectStore('files');
    const chunksStore = tx.objectStore('chunks');
    const blobsStore = tx.objectStore('blobs');

    transfersStore.delete(transferId);

    const fileIndex = filesStore.index('by_transferId');
    const fileCursorReq = fileIndex.openCursor(IDBKeyRange.only(transferId));

    fileCursorReq.onsuccess = () => {
      const cursor = fileCursorReq.result;
      if (cursor) {
        const fileId = cursor.value.fileId;
        blobsStore.delete([transferId, fileId]);
        cursor.delete();
        cursor.continue();
      }
    };

    const chunkIndex = chunksStore.index('by_file');
    const chunkCursorReq = chunkIndex.openKeyCursor(
      IDBKeyRange.bound([transferId, ''], [transferId, '\uffff'])
    );

    chunkCursorReq.onsuccess = () => {
      const cursor = chunkCursorReq.result;
      if (cursor) {
        chunksStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async cleanupStaleTransfers(maxAgeMs: number): Promise<void> {
    const db = await this.getDB();
    const now = Date.now();
    const staleTransferIds: string[] = [];

    const tx = db.transaction(['transfers'], 'readonly');
    const store = tx.objectStore('transfers');
    const req = store.openCursor();

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        if (now - cursor.value.updatedAt > maxAgeMs) {
          staleTransferIds.push(cursor.value.transferId);
        }
        cursor.continue();
      }
    };

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    for (const id of staleTransferIds) {
      await this.deleteTransfer(id);
    }
  }
}
