import {
  AssembledFile,
  ChunkHeader,
  FileAckMessage,
  FileEndMessage,
  FileStartMessage,
  ManifestFileEntry,
  TransferCancelMessage,
  TransferEndMessage,
  TransferErrorMessage,
  TransferManifest,
  TransferProgress,
  TransferStartMessage,
} from '../types';
import { sha256Chunks, sha256File } from './crypto';

export const CHUNK_SIZE = 65536; // 64 KB
export const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024; // 100 GB
export const MAX_FILES_COUNT = 10000;
export const MAX_FILENAME_LENGTH = 255;
export const DEFAULT_ACK_TIMEOUT_MS = 30000; // 30s
export const DEFAULT_STALL_TIMEOUT_MS = 30000; // 30s
export const BACKPRESSURE_HIGH_WATERMARK = 1024 * 1024; // 1 MB
export const BACKPRESSURE_LOW_WATERMARK = 256 * 1024; // 256 KB

export function validateFilename(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FILENAME_LENGTH) return false;
  // Prevent path traversal, null bytes, control characters
  if (trimmed.includes('\0') || trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    return false;
  }
  return true;
}

export function validateManifest(manifest: unknown): TransferManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid manifest: expected object');
  }
  const m = manifest as Record<string, unknown>;

  if (typeof m.transferId !== 'string' || m.transferId.trim().length === 0) {
    throw new Error('Invalid manifest: missing or empty transferId');
  }

  if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > MAX_FILES_COUNT) {
    throw new Error(`Invalid manifest: files count must be between 1 and ${MAX_FILES_COUNT}`);
  }

  if (typeof m.totalFiles !== 'number' || m.totalFiles !== m.files.length) {
    throw new Error('Invalid manifest: totalFiles mismatch with files array length');
  }

  const seenFileIds = new Set<string>();
  let calculatedTotalSize = 0;

  const validatedFiles: ManifestFileEntry[] = [];

  for (const f of m.files) {
    if (!f || typeof f !== 'object') {
      throw new Error('Invalid manifest: file entry must be an object');
    }
    const file = f as Record<string, unknown>;

    if (typeof file.id !== 'string' || file.id.trim().length === 0) {
      throw new Error('Invalid manifest: file missing id');
    }
    if (seenFileIds.has(file.id)) {
      throw new Error(`Invalid manifest: duplicate file ID detected (${file.id})`);
    }
    seenFileIds.add(file.id);

    if (typeof file.name !== 'string' || !validateFilename(file.name)) {
      throw new Error(`Invalid manifest: file '${file.name}' has invalid or dangerous filename`);
    }

    if (typeof file.size !== 'number' || file.size < 0 || !Number.isInteger(file.size) || file.size > MAX_FILE_SIZE) {
      throw new Error(`Invalid manifest: file '${file.name}' has invalid size (${file.size})`);
    }

    const expectedChunks = file.size === 0 ? 0 : Math.ceil(file.size / CHUNK_SIZE);
    if (typeof file.totalChunks !== 'number' || file.totalChunks !== expectedChunks) {
      throw new Error(`Invalid manifest: file '${file.name}' has invalid totalChunks (${file.totalChunks}, expected ${expectedChunks})`);
    }

    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error(`Invalid manifest: file '${file.name}' has invalid SHA-256 hash`);
    }

    calculatedTotalSize += file.size;

    validatedFiles.push({
      id: file.id,
      name: file.name,
      size: file.size,
      mimeType: typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream',
      relativePath: typeof file.relativePath === 'string' ? file.relativePath : undefined,
      totalChunks: file.totalChunks,
      sha256: file.sha256.toLowerCase(),
    });
  }

  if (typeof m.totalSize !== 'number' || m.totalSize !== calculatedTotalSize) {
    throw new Error(`Invalid manifest: totalSize mismatch (${m.totalSize} vs calculated ${calculatedTotalSize})`);
  }

  return {
    transferId: m.transferId,
    totalFiles: m.totalFiles,
    totalSize: m.totalSize,
    files: validatedFiles,
  };
}

async function sendChunkWithBackpressure(dc: RTCDataChannel, data: ArrayBuffer): Promise<void> {
  if (dc.bufferedAmount > BACKPRESSURE_HIGH_WATERMARK) {
    dc.bufferedAmountLowThreshold = BACKPRESSURE_LOW_WATERMARK;
    await new Promise<void>((resolve) => {
      const onLow = () => {
        dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', onLow);
    });
  }
  dc.send(data);
}

export interface SenderOptions {
  transferId?: string;
  chunkSize?: number;
  ackTimeoutMs?: number;
}

export class FileSender {
  private dc: RTCDataChannel;
  private files: File[];
  private transferId: string;
  private ackTimeoutMs: number;
  private hashes: Map<string, string> = new Map();
  private manifest: TransferManifest | null = null;
  public onProgress: ((progress: TransferProgress) => void) | null = null;
  public onComplete: (() => void) | null = null;
  public onError: ((error: string) => void) | null = null;
  private cancelled = false;

  private totalBytes = 0;
  private bytesTransferred = 0;
  private startTime = 0;

  constructor(dc: RTCDataChannel, files: File[], options?: SenderOptions) {
    this.dc = dc;
    this.files = files;
    this.transferId = options?.transferId || (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `tx_${Date.now()}`);
    this.ackTimeoutMs = options?.ackTimeoutMs || DEFAULT_ACK_TIMEOUT_MS;

    for (const f of files) {
      this.totalBytes += f.size;
    }
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    console.log('[TRANSFER][SEND] Calculating hashes before transfer start');

    try {
      const manifestFiles: ManifestFileEntry[] = [];

      for (let i = 0; i < this.files.length; i++) {
        if (this.cancelled) return;
        const file = this.files[i];
        this.updateProgress(i, 'verifying');

        const hash = await sha256File(file);
        const fileId = `file_${i}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        this.hashes.set(fileId, hash);

        const totalChunks = file.size === 0 ? 0 : Math.ceil(file.size / CHUNK_SIZE);
        manifestFiles.push({
          id: fileId,
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          totalChunks,
          sha256: hash,
        });
      }

      if (this.cancelled) return;

      this.manifest = validateManifest({
        transferId: this.transferId,
        totalFiles: manifestFiles.length,
        totalSize: this.totalBytes,
        files: manifestFiles,
      });

      console.log(`[TRANSFER][SEND] Sending TRANSFER_START with manifest (${this.manifest.totalFiles} files, ${this.manifest.totalSize} bytes)`);
      const startMsg: TransferStartMessage = {
        type: 'TRANSFER_START',
        transferId: this.transferId,
        manifest: this.manifest,
      };
      this.dc.send(JSON.stringify(startMsg));

      for (let i = 0; i < this.files.length; i++) {
        if (this.cancelled) return;

        const file = this.files[i];
        const manifestEntry = this.manifest.files[i];
        const fileId = manifestEntry.id;
        const hash = manifestEntry.sha256;
        const totalChunks = manifestEntry.totalChunks;

        this.updateProgress(i, 'sending');

        console.log(`[TRANSFER][SEND] Sending FILE_START for file ${i + 1}/${this.files.length} (${file.name})`);
        const fileStartMsg: FileStartMessage = {
          type: 'FILE_START',
          transferId: this.transferId,
          fileId,
          name: file.name,
          size: file.size,
          chunkSize: CHUNK_SIZE,
          totalChunks,
          sha256: hash,
        };
        this.dc.send(JSON.stringify(fileStartMsg));

        // If file is empty (0 bytes), no chunks to send
        if (totalChunks > 0) {
          // Send chunks
          for (let j = 0; j < totalChunks; j++) {
            if (this.cancelled) return;

            const start = j * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunkBlob = file.slice(start, end);
            const chunkData = await chunkBlob.arrayBuffer();

            const header: ChunkHeader = {
              transferId: this.transferId,
              fileId,
              index: j,
              totalChunks,
              byteLength: chunkData.byteLength,
            };
            const headerStr = JSON.stringify(header);
            const headerBytes = new TextEncoder().encode(headerStr);

            const payload = new Uint8Array(4 + headerBytes.length + chunkData.byteLength);

            // 4 bytes uint32 BE header length
            const view = new DataView(payload.buffer);
            view.setUint32(0, headerBytes.length, false);

            // header bytes
            payload.set(headerBytes, 4);
            // chunk data
            payload.set(new Uint8Array(chunkData), 4 + headerBytes.length);

            await sendChunkWithBackpressure(this.dc, payload.buffer);

            this.bytesTransferred += chunkData.byteLength;

            // Update progress every 10 chunks or on last chunk
            if (j % 10 === 0 || j === totalChunks - 1) {
              this.updateProgress(i, 'sending');
            }
          }
        }

        console.log(`[TRANSFER][SEND] Sending FILE_END for file ${i + 1} (${file.name})`);
        const fileEndMsg: FileEndMessage = {
          type: 'FILE_END',
          transferId: this.transferId,
          fileId,
        };
        this.dc.send(JSON.stringify(fileEndMsg));

        // Wait for FILE_ACK with timeout
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.dc.removeEventListener('message', handler);
            reject(new Error(`Timeout waiting for receiver ACK for file ${file.name}`));
          }, this.ackTimeoutMs);

          const handler = (event: MessageEvent) => {
            if (typeof event.data === 'string') {
              try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'FILE_ACK' && msg.fileId === fileId && msg.transferId === this.transferId) {
                  console.log(`[TRANSFER][SEND] Received FILE_ACK (fileId=${fileId}, match=${msg.sha256Match})`);
                  clearTimeout(timer);
                  this.dc.removeEventListener('message', handler);
                  if (!msg.sha256Match) {
                    reject(new Error(`SHA-256 mismatch on receiver for file '${file.name}': ${msg.error || 'integrity check failed'}`));
                  } else {
                    resolve();
                  }
                } else if (msg.type === 'CANCEL') {
                  console.log('[TRANSFER][SEND] Received CANCEL signal');
                  clearTimeout(timer);
                  this.dc.removeEventListener('message', handler);
                  reject(new Error(`Transfer cancelled by receiver: ${msg.reason}`));
                } else if (msg.type === 'ERROR') {
                  console.error('[TRANSFER][SEND] Received ERROR signal', msg);
                  clearTimeout(timer);
                  this.dc.removeEventListener('message', handler);
                  reject(new Error(`Transfer error from receiver: ${msg.message || msg.code}`));
                }
              } catch {
                // ignore JSON parse errors on malformed messages
              }
            }
          };
          this.dc.addEventListener('message', handler);
        });
      }

      if (this.cancelled) return;
      console.log('[TRANSFER][SEND] Sending TRANSFER_END');
      const transferEndMsg: TransferEndMessage = {
        type: 'TRANSFER_END',
        transferId: this.transferId,
      };
      this.dc.send(JSON.stringify(transferEndMsg));
      if (this.onComplete) this.onComplete();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown transfer error';
      console.error('[TRANSFER][SEND] Transfer failed:', errorMsg);
      if (this.onError && !this.cancelled) {
        this.onError(errorMsg);
      }
    }
  }

  cancel(reason: string): void {
    console.log(`[TRANSFER][SEND] Transfer cancelled: ${reason}`);
    this.cancelled = true;
    if (this.dc.readyState === 'open') {
      const cancelMsg: TransferCancelMessage = {
        type: 'CANCEL',
        transferId: this.transferId,
        reason,
      };
      try {
        this.dc.send(JSON.stringify(cancelMsg));
      } catch {
        // ignore send error on closed channel
      }
    }
  }

  private updateProgress(fileIndex: number, state: TransferProgress['state']) {
    if (!this.onProgress) return;

    const currentFile = this.files[fileIndex];
    const percentage = this.totalBytes === 0 ? 100 : (this.bytesTransferred / this.totalBytes) * 100;

    const elapsed = (Date.now() - this.startTime) / 1000;
    const speed = elapsed > 0 ? this.bytesTransferred / elapsed : 0;
    const eta = speed > 0 ? (this.totalBytes - this.bytesTransferred) / speed : 0;

    this.onProgress({
      currentFile: currentFile.name,
      currentFileIndex: fileIndex,
      totalFiles: this.files.length,
      bytesTransferred: this.bytesTransferred,
      totalBytes: this.totalBytes,
      percentage,
      speed,
      eta,
      state,
    });
  }
}

interface ActiveFileRecord {
  id: string;
  name: string;
  size: number;
  totalChunks: number;
  sha256: string;
  chunks: (Uint8Array | undefined)[];
  receivedBytes: number;
  completed: boolean;
}

export interface ReceiverOptions {
  expectedTransferId?: string;
  stallTimeoutMs?: number;
}

export class FileReceiver {
  private dc: RTCDataChannel;
  private manifest: TransferManifest | null = null;
  private activeTransferId: string | null = null;
  private files: Map<string, ActiveFileRecord> = new Map();
  private assembledFiles: AssembledFile[] = [];
  public onProgress: ((progress: TransferProgress) => void) | null = null;
  public onComplete: ((files: AssembledFile[]) => void) | null = null;
  public onError: ((error: string) => void) | null = null;

  private totalBytes = 0;
  private totalFiles = 0;
  private totalReceivedBytes = 0;
  private currentFileIndex = 0;
  private currentFileName = '';
  private cancelled = false;
  private startTime = 0;
  private stallTimeoutMs: number;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dc: RTCDataChannel, options?: ReceiverOptions) {
    this.dc = dc;
    this.dc.binaryType = 'arraybuffer';
    this.activeTransferId = options?.expectedTransferId || null;
    this.stallTimeoutMs = options?.stallTimeoutMs || DEFAULT_STALL_TIMEOUT_MS;
  }

  start(): void {
    this.resetStallTimer();

    this.dc.addEventListener('message', async (event) => {
      if (this.cancelled) return;
      this.resetStallTimer();

      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          console.log(`[TRANSFER][RECEIVE] Control message received: ${msg.type}`);

          switch (msg.type) {
            case 'TRANSFER_START': {
              const manifest = validateManifest(msg.manifest);
              if (this.activeTransferId && manifest.transferId !== this.activeTransferId) {
                throw new Error(`Transfer ID mismatch: expected ${this.activeTransferId}, got ${manifest.transferId}`);
              }
              this.activeTransferId = manifest.transferId;
              this.manifest = manifest;
              this.totalFiles = manifest.totalFiles;
              this.totalBytes = manifest.totalSize;
              this.startTime = Date.now();
              this.updateProgress('receiving');
              break;
            }

            case 'FILE_START': {
              if (!this.manifest || !this.activeTransferId) {
                throw new Error('Received FILE_START before TRANSFER_START manifest');
              }
              if (msg.transferId !== this.activeTransferId) {
                throw new Error(`FILE_START transferId mismatch (${msg.transferId} vs ${this.activeTransferId})`);
              }
              const manifestEntry = this.manifest.files.find((f) => f.id === msg.fileId);
              if (!manifestEntry) {
                throw new Error(`FILE_START fileId '${msg.fileId}' not found in authorized manifest`);
              }
              if (msg.size !== manifestEntry.size || msg.totalChunks !== manifestEntry.totalChunks || msg.sha256 !== manifestEntry.sha256) {
                throw new Error(`FILE_START metadata mismatch for file '${manifestEntry.name}'`);
              }

              this.files.set(msg.fileId, {
                id: msg.fileId,
                name: manifestEntry.name,
                size: manifestEntry.size,
                totalChunks: manifestEntry.totalChunks,
                sha256: manifestEntry.sha256,
                chunks: new Array(manifestEntry.totalChunks),
                receivedBytes: 0,
                completed: false,
              });
              this.currentFileName = manifestEntry.name;
              this.updateProgress('receiving');
              break;
            }

            case 'FILE_END': {
              if (!this.activeTransferId || msg.transferId !== this.activeTransferId) {
                throw new Error('FILE_END transferId mismatch');
              }
              await this.handleFileEnd(msg.fileId);
              break;
            }

            case 'TRANSFER_END': {
              if (!this.activeTransferId || msg.transferId !== this.activeTransferId) {
                throw new Error('TRANSFER_END transferId mismatch');
              }
              console.log('[TRANSFER][RECEIVE] TRANSFER_END received, validating complete assembly');
              this.clearStallTimer();
              if (this.manifest && this.assembledFiles.length !== this.manifest.totalFiles) {
                throw new Error(`Incomplete transfer: received ${this.assembledFiles.length} of ${this.manifest.totalFiles} files`);
              }
              if (this.onComplete) {
                this.onComplete(this.assembledFiles);
              }
              break;
            }

            case 'CANCEL': {
              console.log('[TRANSFER][RECEIVE] CANCEL received');
              this.cancelled = true;
              this.clearStallTimer();
              if (this.onError) this.onError(msg.reason || 'Transfer cancelled by peer');
              break;
            }

            case 'ERROR': {
              console.error('[TRANSFER][RECEIVE] ERROR received from sender', msg);
              this.cancelled = true;
              this.clearStallTimer();
              if (this.onError) this.onError(msg.message || msg.code || 'Transfer error');
              break;
            }
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : 'Malformed transfer message';
          console.error('[TRANSFER][RECEIVE] Control message error:', errorMsg);
          this.sendError('PROTOCOL_ERROR', errorMsg);
          this.clearStallTimer();
          if (this.onError) this.onError(errorMsg);
        }
      } else {
        // ArrayBuffer Binary Chunk
        try {
          const buffer = event.data as ArrayBuffer;
          if (buffer.byteLength < 4) {
            throw new Error('Malformed chunk: payload too small');
          }
          const view = new DataView(buffer);
          const headerLen = view.getUint32(0, false);

          if (4 + headerLen > buffer.byteLength) {
            throw new Error('Malformed chunk: invalid header length');
          }

          const headerBytes = new Uint8Array(buffer, 4, headerLen);
          const headerStr = new TextDecoder().decode(headerBytes);
          const header = JSON.parse(headerStr) as ChunkHeader;

          if (!this.activeTransferId || header.transferId !== this.activeTransferId) {
            throw new Error(`Chunk rejected: transfer ID mismatch (${header.transferId} vs ${this.activeTransferId})`);
          }

          const fileRecord = this.files.get(header.fileId);
          if (!fileRecord) {
            throw new Error(`Chunk rejected: unknown file ID '${header.fileId}'`);
          }

          if (fileRecord.completed) {
            throw new Error(`Chunk rejected: file '${fileRecord.name}' already completed`);
          }

          if (header.index < 0 || header.index >= fileRecord.totalChunks) {
            throw new Error(`Chunk rejected: index ${header.index} out of bounds (totalChunks=${fileRecord.totalChunks})`);
          }

          const chunkData = new Uint8Array(buffer, 4 + headerLen);
          if (chunkData.byteLength > CHUNK_SIZE) {
            throw new Error(`Chunk rejected: oversized chunk (${chunkData.byteLength} > ${CHUNK_SIZE})`);
          }

          // Handle duplicate vs new chunk
          const existingChunk = fileRecord.chunks[header.index];
          if (existingChunk) {
            console.log(`[TRANSFER][RECEIVE] Duplicate chunk ${header.index} received for file ${fileRecord.name} - ignoring`);
          } else {
            fileRecord.chunks[header.index] = chunkData;
            fileRecord.receivedBytes += chunkData.byteLength;
            this.totalReceivedBytes += chunkData.byteLength;

            if (header.index % 10 === 0 || fileRecord.receivedBytes >= fileRecord.size) {
              this.updateProgress('receiving');
            }
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : 'Chunk processing error';
          console.error('[TRANSFER][RECEIVE] Chunk error:', errorMsg);
          this.sendError('CHUNK_ERROR', errorMsg);
          this.clearStallTimer();
          if (this.onError) this.onError(errorMsg);
        }
      }
    });
  }

  private async handleFileEnd(fileId: string) {
    const fileRecord = this.files.get(fileId);
    if (!fileRecord) {
      throw new Error(`FILE_END received for unknown file ID '${fileId}'`);
    }

    this.updateProgress('verifying');

    try {
      // Validate all chunks are present
      let verified = false;
      let hash = '';

      if (fileRecord.totalChunks === 0 && fileRecord.size === 0) {
        // Empty file handling
        hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        verified = hash.toLowerCase() === fileRecord.sha256.toLowerCase();
      } else {
        const hasMissingChunk = fileRecord.chunks.some((c) => !(c instanceof Uint8Array));
        if (hasMissingChunk) {
          throw new Error(`Missing chunks detected in file '${fileRecord.name}'`);
        }
        const validChunks = fileRecord.chunks.filter((c): c is Uint8Array => c instanceof Uint8Array);
        hash = await sha256Chunks(validChunks);
        verified = hash.toLowerCase() === fileRecord.sha256.toLowerCase();
      }

      if (!verified) {
        throw new Error(`SHA-256 mismatch for file '${fileRecord.name}' (calculated ${hash}, expected ${fileRecord.sha256})`);
      }

      fileRecord.completed = true;

      const ackMsg: FileAckMessage = {
        type: 'FILE_ACK',
        transferId: this.activeTransferId || '',
        fileId,
        sha256Match: true,
      };
      this.dc.send(JSON.stringify(ackMsg));

      const validChunks = fileRecord.chunks.filter((c): c is Uint8Array => c instanceof Uint8Array);
      const blob = new Blob(validChunks as unknown as BlobPart[]);
      this.assembledFiles.push({
        id: fileRecord.id,
        name: fileRecord.name,
        size: fileRecord.size,
        blob,
        verified: true,
        sha256: hash,
      });

      this.currentFileIndex++;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'File verification error';
      console.error('[TRANSFER][RECEIVE] Verification failed:', errorMsg);
      const ackMsg: FileAckMessage = {
        type: 'FILE_ACK',
        transferId: this.activeTransferId || '',
        fileId,
        sha256Match: false,
        error: errorMsg,
      };
      this.dc.send(JSON.stringify(ackMsg));
      if (this.onError) {
        this.onError(errorMsg);
      }
    }
  }

  private sendError(code: string, message: string) {
    if (this.dc.readyState === 'open') {
      const errorMsg: TransferErrorMessage = {
        type: 'ERROR',
        transferId: this.activeTransferId || undefined,
        code,
        message,
      };
      try {
        this.dc.send(JSON.stringify(errorMsg));
      } catch {
        // ignore send error
      }
    }
  }

  cancel(reason: string): void {
    console.log(`[TRANSFER][RECEIVE] Transfer cancelled: ${reason}`);
    this.cancelled = true;
    this.clearStallTimer();
    if (this.dc.readyState === 'open') {
      const cancelMsg: TransferCancelMessage = {
        type: 'CANCEL',
        transferId: this.activeTransferId || undefined,
        reason,
      };
      try {
        this.dc.send(JSON.stringify(cancelMsg));
      } catch {
        // ignore send error
      }
    }
  }

  private resetStallTimer() {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      console.error('[TRANSFER][RECEIVE] Transfer timed out (no activity received within limit)');
      this.cancelled = true;
      this.sendError('STALL_TIMEOUT', 'Transfer timed out due to inactivity');
      if (this.onError) {
        this.onError('Transfer timed out due to inactivity');
      }
    }, this.stallTimeoutMs);
  }

  private clearStallTimer() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private updateProgress(state: TransferProgress['state']) {
    if (!this.onProgress) return;

    const percentage = this.totalBytes === 0 ? 100 : (this.totalReceivedBytes / this.totalBytes) * 100;

    const elapsed = (Date.now() - this.startTime) / 1000;
    const speed = elapsed > 0 ? this.totalReceivedBytes / elapsed : 0;
    const eta = speed > 0 ? (this.totalBytes - this.totalReceivedBytes) / speed : 0;

    this.onProgress({
      currentFile: this.currentFileName,
      currentFileIndex: this.currentFileIndex,
      totalFiles: this.totalFiles,
      bytesTransferred: this.totalReceivedBytes,
      totalBytes: this.totalBytes,
      percentage,
      speed,
      eta,
      state,
    });
  }
}
