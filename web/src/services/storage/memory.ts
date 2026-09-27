import { ManifestFileEntry, TransferManifest } from '../../types';
import { IncrementalSha256 } from '../crypto';
import { StoredFileInfo, StoredTransferInfo, TransferStorage } from './types';

export class MemoryTransferStorage implements TransferStorage {
  readonly name = 'MemoryTransferStorage';
  readonly isPersistent = false;

  private transfers: Map<string, StoredTransferInfo> = new Map();
  private chunks: Map<string, Uint8Array> = new Map(); // key: `${transferId}:${fileId}:${index}`
  private finalizedBlobs: Map<string, Blob> = new Map(); // key: `${transferId}:${fileId}`

  private makeChunkKey(transferId: string, fileId: string, index: number): string {
    return `${transferId}:${fileId}:${index}`;
  }

  private makeBlobKey(transferId: string, fileId: string): string {
    return `${transferId}:${fileId}`;
  }

  async init(): Promise<void> {
    // In-memory requires no asynchronous disk initialization
  }

  async createTransfer(manifest: TransferManifest): Promise<void> {
    const existing = this.transfers.get(manifest.transferId);
    if (existing) return;

    const filesMap = new Map<string, StoredFileInfo>();
    const now = Date.now();

    for (const f of manifest.files) {
      filesMap.set(f.id, {
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
      });
    }

    this.transfers.set(manifest.transferId, {
      transferId: manifest.transferId,
      manifest,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
      files: filesMap,
    });
  }

  async getTransfer(transferId: string): Promise<StoredTransferInfo | null> {
    return this.transfers.get(transferId) || null;
  }

  async listActiveTransfers(): Promise<string[]> {
    const active: string[] = [];
    for (const [id, t] of this.transfers.entries()) {
      if (t.status === 'in_progress') {
        active.push(id);
      }
    }
    return active;
  }

  async initFile(transferId: string, file: ManifestFileEntry): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new Error(`Transfer '${transferId}' not found in storage`);
    }

    if (!transfer.files.has(file.id)) {
      const now = Date.now();
      transfer.files.set(file.id, {
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
      });
      transfer.updatedAt = now;
    }
  }

  async writeChunk(transferId: string, fileId: string, index: number, data: Uint8Array): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new Error(`Transfer '${transferId}' not found in storage`);
    }
    const file = transfer.files.get(fileId);
    if (!file) {
      throw new Error(`File '${fileId}' not found in transfer '${transferId}'`);
    }

    const key = this.makeChunkKey(transferId, fileId, index);
    if (!this.chunks.has(key)) {
      this.chunks.set(key, data);
      file.receivedChunksCount += 1;
      file.updatedAt = Date.now();
      transfer.updatedAt = Date.now();
    }
  }

  async hasChunk(transferId: string, fileId: string, index: number): Promise<boolean> {
    const key = this.makeChunkKey(transferId, fileId, index);
    return this.chunks.has(key);
  }

  async getReceivedChunks(transferId: string, fileId: string): Promise<number[]> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return [];
    const file = transfer.files.get(fileId);
    if (!file) return [];

    const received: number[] = [];
    for (let i = 0; i < file.totalChunks; i++) {
      const key = this.makeChunkKey(transferId, fileId, i);
      if (this.chunks.has(key)) {
        received.push(i);
      }
    }
    return received;
  }

  async getMissingChunks(transferId: string, fileId: string, totalChunks: number): Promise<number[]> {
    const missing: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const key = this.makeChunkKey(transferId, fileId, i);
      if (!this.chunks.has(key)) {
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
    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new Error(`Transfer '${transferId}' not found`);
    const file = transfer.files.get(fileId);
    if (!file) throw new Error(`File '${fileId}' not found`);

    if (file.totalChunks === 0 && file.size === 0) {
      const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const match = emptyHash.toLowerCase() === expectedSha256.toLowerCase();
      const blob = new Blob([], { type: file.mimeType });
      if (match) {
        file.completed = true;
        this.finalizedBlobs.set(this.makeBlobKey(transferId, fileId), blob);
      }
      return { match, calculatedSha256: emptyHash, blob };
    }

    const t0 = performance.now();
    console.log(`[TRANSFER][RECV][VERIFY] START fileId=${fileId}`);
    const hasher = new IncrementalSha256();
    const chunkParts: Uint8Array[] = [];
    let bytesProcessed = 0;

    console.log(`[TRANSFER][RECV][VERIFY] reading chunks`);
    for (let i = 0; i < file.totalChunks; i++) {
      const key = this.makeChunkKey(transferId, fileId, i);
      const chunk = this.chunks.get(key);
      if (!chunk) {
        throw new Error(`Cannot verify file '${file.name}': chunk ${i} is missing`);
      }
      hasher.update(chunk);
      chunkParts.push(chunk);
      bytesProcessed += chunk.byteLength;
      if (i % 500 === 0 || i === file.totalChunks - 1) {
        console.log(`[TRANSFER][RECV][VERIFY] processed chunk ${i + 1}/${file.totalChunks} (${(performance.now() - t0).toFixed(0)}ms)`);
      }
      if (onProgress) {
        onProgress(bytesProcessed, file.size);
      }
    }

    const calculatedSha256 = hasher.digest();
    const match = calculatedSha256.toLowerCase() === expectedSha256.toLowerCase();
    const verifyElapsed = performance.now() - t0;
    console.log(`[TRANSFER][RECV][VERIFY] SHA256 complete match=${match} calculated=${calculatedSha256} elapsed=${verifyElapsed.toFixed(0)}ms`);

    if (!match) {
      return { match: false, calculatedSha256, blob: new Blob() };
    }

    const tFinalize = performance.now();
    console.log(`[TRANSFER][RECV][FINALIZE] START fileId=${fileId}`);
    file.completed = true;
    const blob = new Blob(chunkParts as unknown as BlobPart[], { type: file.mimeType });
    this.finalizedBlobs.set(this.makeBlobKey(transferId, fileId), blob);
    console.log(`[TRANSFER][RECV][FINALIZE] COMPLETE fileId=${fileId} elapsed=${(performance.now() - tFinalize).toFixed(0)}ms`);

    // Check if all files in transfer are complete
    const allComplete = Array.from(transfer.files.values()).every((f) => f.completed);
    if (allComplete) {
      transfer.status = 'completed';
    }

    return { match: true, calculatedSha256, blob };
  }

  async getFinalizedBlob(transferId: string, fileId: string): Promise<Blob | null> {
    return this.finalizedBlobs.get(this.makeBlobKey(transferId, fileId)) || null;
  }

  async deleteTransfer(transferId: string): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (transfer) {
      for (const fileId of transfer.files.keys()) {
        for (let i = 0; i < (transfer.files.get(fileId)?.totalChunks || 0); i++) {
          this.chunks.delete(this.makeChunkKey(transferId, fileId, i));
        }
        this.finalizedBlobs.delete(this.makeBlobKey(transferId, fileId));
      }
      this.transfers.delete(transferId);
    }
  }

  async cleanupStaleTransfers(maxAgeMs: number): Promise<void> {
    const now = Date.now();
    for (const [id, t] of Array.from(this.transfers.entries())) {
      if (now - t.updatedAt > maxAgeMs) {
        await this.deleteTransfer(id);
      }
    }
  }
}
