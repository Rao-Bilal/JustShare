import { ManifestFileEntry, TransferManifest } from '../../types';

export interface StoredFileInfo {
  id: string;
  name: string;
  size: number;
  totalChunks: number;
  chunkSize: number;
  sha256: string;
  mimeType: string;
  completed: boolean;
  receivedChunksCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredTransferInfo {
  transferId: string;
  manifest: TransferManifest;
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  files: Map<string, StoredFileInfo>;
}

export interface TransferStorage {
  readonly name: string;
  readonly isPersistent: boolean;

  init(): Promise<void>;
  createTransfer(manifest: TransferManifest): Promise<void>;
  getTransfer(transferId: string): Promise<StoredTransferInfo | null>;
  listActiveTransfers(): Promise<string[]>;

  initFile(transferId: string, file: ManifestFileEntry): Promise<void>;
  writeChunk(transferId: string, fileId: string, index: number, data: Uint8Array): Promise<void>;
  hasChunk(transferId: string, fileId: string, index: number): Promise<boolean>;
  getReceivedChunks(transferId: string, fileId: string): Promise<number[]>;
  getMissingChunks(transferId: string, fileId: string, totalChunks: number): Promise<number[]>;

  verifyAndFinalizeFile(
    transferId: string,
    fileId: string,
    expectedSha256: string,
    onProgress?: (bytesProcessed: number, totalBytes: number) => void
  ): Promise<{ match: boolean; calculatedSha256: string; blob: Blob }>;

  getFinalizedBlob(transferId: string, fileId: string): Promise<Blob | null>;
  deleteTransfer(transferId: string): Promise<void>;
  cleanupStaleTransfers(maxAgeMs: number): Promise<void>;
}
