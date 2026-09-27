import { ManifestFileEntry, TransferManifest } from '../../types';
import { IncrementalSha256 } from '../crypto';
import { StoredFileInfo, StoredTransferInfo, TransferStorage } from './types';

export class OPFSTransferStorage implements TransferStorage {
  readonly name = 'OPFSTransferStorage';
  readonly isPersistent = true;

  private rootDir: FileSystemDirectoryHandle | null = null;

  async init(): Promise<void> {
    if (this.rootDir) return;
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) {
      throw new Error('Origin Private File System (OPFS) is not supported in this browser environment');
    }
    const root = await navigator.storage.getDirectory();
    this.rootDir = await root.getDirectoryHandle('justshare_transfers', { create: true });
  }

  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    if (!this.rootDir) {
      await this.init();
    }
    if (!this.rootDir) {
      throw new Error('OPFS storage not initialized');
    }
    return this.rootDir;
  }

  private async getTransferDir(transferId: string, create = false): Promise<FileSystemDirectoryHandle | null> {
    const root = await this.getRoot();
    try {
      return await root.getDirectoryHandle(transferId, { create });
    } catch {
      return null;
    }
  }

  private async getFileDir(transferId: string, fileId: string, create = false): Promise<FileSystemDirectoryHandle | null> {
    const tDir = await this.getTransferDir(transferId, create);
    if (!tDir) return null;
    try {
      const filesDir = await tDir.getDirectoryHandle('files', { create });
      return await filesDir.getDirectoryHandle(fileId, { create });
    } catch {
      return null;
    }
  }

  async createTransfer(manifest: TransferManifest): Promise<void> {
    const tDir = await this.getTransferDir(manifest.transferId, true);
    if (!tDir) throw new Error('Failed to create transfer directory');

    const now = Date.now();
    const info = {
      transferId: manifest.transferId,
      manifest,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    };

    const manifestFile = await tDir.getFileHandle('manifest.json', { create: true });
    const writable = await manifestFile.createWritable();
    await writable.write(JSON.stringify(info));
    await writable.close();

    for (const f of manifest.files) {
      await this.initFile(manifest.transferId, f);
    }
  }

  async getTransfer(transferId: string): Promise<StoredTransferInfo | null> {
    const tDir = await this.getTransferDir(transferId, false);
    if (!tDir) return null;

    try {
      const manifestFile = await tDir.getFileHandle('manifest.json', { create: false });
      const file = await manifestFile.getFile();
      const text = await file.text();
      const data = JSON.parse(text);

      const filesMap = new Map<string, StoredFileInfo>();
      const filesDir = await tDir.getDirectoryHandle('files', { create: false }).catch(() => null);

      if (filesDir) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const [fileId, handle] of (filesDir as any).entries()) {
          if (handle.kind === 'directory') {
            try {
              const metaHandle = await (handle as FileSystemDirectoryHandle).getFileHandle('meta.json', { create: false });
              const metaFile = await metaHandle.getFile();
              const metaText = await metaFile.text();
              const meta = JSON.parse(metaText);
              filesMap.set(fileId, meta);
            } catch {
              // skip unreadable metadata
            }
          }
        }
      }

      return {
        transferId: data.transferId,
        manifest: data.manifest,
        status: data.status,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        files: filesMap,
      };
    } catch {
      return null;
    }
  }

  async listActiveTransfers(): Promise<string[]> {
    const root = await this.getRoot();
    const active: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [name, handle] of (root as any).entries()) {
      if (handle.kind === 'directory') {
        const transfer = await this.getTransfer(name);
        if (transfer && transfer.status === 'in_progress') {
          active.push(name);
        }
      }
    }
    return active;
  }

  async initFile(transferId: string, file: ManifestFileEntry): Promise<void> {
    const fDir = await this.getFileDir(transferId, file.id, true);
    if (!fDir) throw new Error('Failed to create file directory in OPFS');

    const now = Date.now();
    const meta: StoredFileInfo = {
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

    const metaHandle = await fDir.getFileHandle('meta.json', { create: true });
    const writable = await metaHandle.createWritable();
    await writable.write(JSON.stringify(meta));
    await writable.close();
  }

  async writeChunk(transferId: string, fileId: string, index: number, data: Uint8Array): Promise<void> {
    const fDir = await this.getFileDir(transferId, fileId, true);
    if (!fDir) throw new Error('File directory not found');

    const chunkFileName = `chunk_${index}.bin`;
    const chunkHandle = await fDir.getFileHandle(chunkFileName, { create: true });
    const writable = await chunkHandle.createWritable();
    await writable.write(data.buffer as ArrayBuffer);
    await writable.close();

    // Update metadata
    try {
      const metaHandle = await fDir.getFileHandle('meta.json', { create: false });
      const metaFile = await metaHandle.getFile();
      const metaText = await metaFile.text();
      const meta: StoredFileInfo = JSON.parse(metaText);
      meta.receivedChunksCount += 1;
      meta.updatedAt = Date.now();

      const metaWritable = await metaHandle.createWritable();
      await metaWritable.write(JSON.stringify(meta));
      await metaWritable.close();
    } catch {
      // ignore non-fatal meta write error
    }
  }

  async hasChunk(transferId: string, fileId: string, index: number): Promise<boolean> {
    const fDir = await this.getFileDir(transferId, fileId, false);
    if (!fDir) return false;
    try {
      await fDir.getFileHandle(`chunk_${index}.bin`, { create: false });
      return true;
    } catch {
      return false;
    }
  }

  async getReceivedChunks(transferId: string, fileId: string): Promise<number[]> {
    const fDir = await this.getFileDir(transferId, fileId, false);
    if (!fDir) return [];

    const received: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [name, handle] of (fDir as any).entries()) {
      if (handle.kind === 'file' && name.startsWith('chunk_') && name.endsWith('.bin')) {
        const idxStr = name.substring('chunk_'.length, name.length - '.bin'.length);
        const idx = parseInt(idxStr, 10);
        if (!isNaN(idx)) {
          received.push(idx);
        }
      }
    }
    received.sort((a, b) => a - b);
    return received;
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
    const fDir = await this.getFileDir(transferId, fileId, false);
    if (!fDir) throw new Error('File directory not found');

    const metaHandle = await fDir.getFileHandle('meta.json', { create: false });
    const metaFile = await metaHandle.getFile();
    const meta: StoredFileInfo = JSON.parse(await metaFile.text());

    if (meta.totalChunks === 0 && meta.size === 0) {
      const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const match = emptyHash.toLowerCase() === expectedSha256.toLowerCase();
      const blob = new Blob([], { type: meta.mimeType });
      if (match) {
        meta.completed = true;
        const w = await metaHandle.createWritable();
        await w.write(JSON.stringify(meta));
        await w.close();
      }
      return { match, calculatedSha256: emptyHash, blob };
    }

    const hasher = new IncrementalSha256();
    const chunkParts: Uint8Array[] = [];
    let bytesProcessed = 0;

    for (let i = 0; i < meta.totalChunks; i++) {
      const chunkHandle = await fDir.getFileHandle(`chunk_${i}.bin`, { create: false });
      const chunkFile = await chunkHandle.getFile();
      const chunkBuf = await chunkFile.arrayBuffer();
      const chunkData = new Uint8Array(chunkBuf);

      hasher.update(chunkData);
      chunkParts.push(chunkData);
      bytesProcessed += chunkData.byteLength;

      if (onProgress) {
        onProgress(bytesProcessed, meta.size);
      }
    }

    const calculatedSha256 = hasher.digest();
    const match = calculatedSha256.toLowerCase() === expectedSha256.toLowerCase();

    if (!match) {
      return { match: false, calculatedSha256, blob: new Blob() };
    }

    meta.completed = true;
    const w = await metaHandle.createWritable();
    await w.write(JSON.stringify(meta));
    await w.close();

    const blob = new Blob(chunkParts as unknown as BlobPart[], { type: meta.mimeType });

    // Store final.bin
    const finalHandle = await fDir.getFileHandle('final.bin', { create: true });
    const finalWritable = await finalHandle.createWritable();
    await finalWritable.write(blob);
    await finalWritable.close();

    return { match: true, calculatedSha256, blob };
  }

  async getFinalizedBlob(transferId: string, fileId: string): Promise<Blob | null> {
    const fDir = await this.getFileDir(transferId, fileId, false);
    if (!fDir) return null;
    try {
      const finalHandle = await fDir.getFileHandle('final.bin', { create: false });
      const file = await finalHandle.getFile();
      return file;
    } catch {
      return null;
    }
  }

  async deleteTransfer(transferId: string): Promise<void> {
    const root = await this.getRoot();
    try {
      await root.removeEntry(transferId, { recursive: true });
    } catch {
      // ignore error if directory does not exist
    }
  }

  async cleanupStaleTransfers(maxAgeMs: number): Promise<void> {
    const root = await this.getRoot();
    const now = Date.now();
    const stale: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [name, handle] of (root as any).entries()) {
      if (handle.kind === 'directory') {
        const transfer = await this.getTransfer(name);
        if (transfer && now - transfer.updatedAt > maxAgeMs) {
          stale.push(name);
        }
      }
    }

    for (const name of stale) {
      await this.deleteTransfer(name);
    }
  }
}
