import {
  AssembledFile,
  ChunkHeader,
  FileAckMessage,
  FileEndMessage,
  FileStartMessage,
  FileVerifyingMessage,
  ManifestFileEntry,
  PreparingMessage,
  ResumeFileStatus,
  ResumeRequestMessage,
  ResumeResponseMessage,
  TransferCancelMessage,
  TransferEndMessage,
  TransferErrorMessage,
  TransferManifest,
  TransferProgress,
  TransferStartMessage,
} from '../types';
import { createStreamingHasher, sha256File } from './crypto';
import { RemoteDevLogger } from './devLogger';
import { MemoryTransferStorage } from './storage/memory';
import { TransferStorage } from './storage/types';

export const CHUNK_SIZE = 65536; // 64 KB
export const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024; // 100 GB
export const MAX_FILES_COUNT = 10000;
export const MAX_FILENAME_LENGTH = 255;
export const DEFAULT_ACK_TIMEOUT_MS = 60000; // 60s
export const ACK_HARD_CEILING_TIMEOUT_MS = 15 * 60 * 1000; // 15m
export const VERIFYING_KEEPALIVE_INTERVAL_MS = 5000; // 5s
export const PREPARING_KEEPALIVE_INTERVAL_MS = 5000; // 5s
export const PREPARE_HARD_CEILING_TIMEOUT_MS = 30 * 60 * 1000; // 30m
export const DEFAULT_STALL_TIMEOUT_MS = 60000; // 60s
export const DEFAULT_RESUME_TIMEOUT_MS = 15000; // 15s
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

    let sha256Val: string | undefined = undefined;
    if (file.sha256 !== undefined && file.sha256 !== null && file.sha256 !== '') {
      if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
        throw new Error(`Invalid manifest: file '${file.name}' has invalid SHA-256 hash`);
      }
      sha256Val = file.sha256.toLowerCase();
    }

    calculatedTotalSize += file.size;

    validatedFiles.push({
      id: file.id,
      name: file.name,
      size: file.size,
      mimeType: typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream',
      relativePath: typeof file.relativePath === 'string' ? file.relativePath : undefined,
      totalChunks: file.totalChunks,
      sha256: sha256Val,
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
  if (dc.readyState !== 'open') {
    throw new Error('DataChannel is not open');
  }
  if (dc.bufferedAmount > BACKPRESSURE_HIGH_WATERMARK) {
    dc.bufferedAmountLowThreshold = BACKPRESSURE_LOW_WATERMARK;
    await new Promise<void>((resolve, reject) => {
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('DataChannel closed while waiting for buffer drain'));
      };
      const cleanup = () => {
        dc.removeEventListener('bufferedamountlow', onLow);
        dc.removeEventListener('close', onClose);
      };
      dc.addEventListener('bufferedamountlow', onLow);
      dc.addEventListener('close', onClose);
    });
  }
  if (dc.readyState !== 'open') {
    throw new Error('DataChannel closed before sending');
  }
  dc.send(data);
}

export interface SenderOptions {
  transferId?: string;
  chunkSize?: number;
  ackTimeoutMs?: number;
  ackHardCeilingTimeoutMs?: number;
  resumeTimeoutMs?: number;
  logger?: RemoteDevLogger;
}

export class FileSender {
  private dc: RTCDataChannel;
  private files: File[];
  private transferId: string;
  private ackTimeoutMs: number;
  private ackHardCeilingTimeoutMs: number;
  private resumeTimeoutMs: number;
  private hashes: Map<string, string> = new Map();
  private manifest: TransferManifest | null = null;
  private logger: RemoteDevLogger | null = null;
  public onProgress: ((progress: TransferProgress) => void) | null = null;
  public onComplete: (() => void) | null = null;
  public onError: ((error: string) => void) | null = null;
  private cancelled = false;
  private isPaused = false;
  private isCompleted = false;
  private abortedError: Error | null = null;
  private onControlAbort: ((err: Error) => void) | null = null;

  private totalBytes = 0;
  private bytesTransferred = 0;
  private startTime = 0;

  constructor(dc: RTCDataChannel, files: File[], options?: SenderOptions) {
    this.dc = dc;
    this.files = files;
    this.transferId = options?.transferId || (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `tx_${Date.now()}`);
    this.ackTimeoutMs = options?.ackTimeoutMs || DEFAULT_ACK_TIMEOUT_MS;
    this.ackHardCeilingTimeoutMs = options?.ackHardCeilingTimeoutMs || ACK_HARD_CEILING_TIMEOUT_MS;
    this.resumeTimeoutMs = options?.resumeTimeoutMs || DEFAULT_RESUME_TIMEOUT_MS;
    this.logger = options?.logger || null;

    for (const f of files) {
      this.totalBytes += f.size;
    }
  }

  getTransferId(): string {
    return this.transferId;
  }

  getManifest(): TransferManifest | null {
    return this.manifest;
  }

  attachDataChannel(newDc: RTCDataChannel): void {
    console.log('[TRANSFER][SEND] Attaching new DataChannel to FileSender');
    this.dc = newDc;
  }

  setLogger(logger: RemoteDevLogger | null): void {
    this.logger = logger;
  }

  pause(): void {
    console.log('[TRANSFER][SEND] Transfer paused');
    this.isPaused = true;
    if (this.onProgress && this.files.length > 0) {
      this.updateProgress(0, 'paused');
    }
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    this.isPaused = false;
    this.isCompleted = false;
    this.abortedError = null;
    console.log('[TRANSFER][SEND] Starting transfer with deferred streaming SHA-256');

    const controlHandler = (event: MessageEvent) => {
      if (this.isCompleted || this.cancelled) return;
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'CANCEL') {
            console.log('[TRANSFER][SEND] Received CANCEL signal from receiver');
            this.cancelled = true;
            this.abortedError = new Error(`Transfer cancelled by receiver: ${msg.reason || 'unspecified'}`);
            if (this.onControlAbort) {
              this.onControlAbort(this.abortedError);
            }
          } else if (msg.type === 'ERROR') {
            console.error('[TRANSFER][SEND] Received ERROR signal from receiver', msg);
            this.cancelled = true;
            this.abortedError = new Error(`Transfer error from receiver: ${msg.message || msg.code || 'Transfer error'}`);
            if (this.onControlAbort) {
              this.onControlAbort(this.abortedError);
            }
          }
        } catch {
          // ignore malformed JSON
        }
      }
    };

    const closeHandler = () => {
      if (this.isCompleted || this.cancelled || this.isPaused) return;
      this.cancelled = true;
      this.abortedError = new Error('DataChannel closed unexpectedly');
      if (this.onControlAbort) {
        this.onControlAbort(this.abortedError);
      }
    };

    this.dc.addEventListener('message', controlHandler);
    this.dc.addEventListener('close', closeHandler);

    try {
      const manifestFiles: ManifestFileEntry[] = [];

      for (let i = 0; i < this.files.length; i++) {
        if (this.cancelled || this.isPaused || this.abortedError) {
          if (this.abortedError) throw this.abortedError;
          return;
        }
        const file = this.files[i];
        const totalChunks = file.size === 0 ? 0 : Math.ceil(file.size / CHUNK_SIZE);
        const fileId = `file_${i}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        manifestFiles.push({
          id: fileId,
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          totalChunks,
        });
      }

      if (this.cancelled || this.isPaused || this.abortedError) {
        if (this.abortedError) throw this.abortedError;
        return;
      }

      this.bytesTransferred = 0;

      this.manifest = validateManifest({
        transferId: this.transferId,
        totalFiles: manifestFiles.length,
        totalSize: this.totalBytes,
        files: manifestFiles,
      });

      this.logger?.log('manifest_created', {
        transferId: this.transferId,
        fileSize: this.totalBytes,
        totalChunks: manifestFiles.reduce((acc, f) => acc + f.totalChunks, 0),
      });

      console.log(`[TRANSFER][SEND] Sending TRANSFER_START with manifest (${this.manifest.totalFiles} files, ${this.manifest.totalSize} bytes)`);
      const startMsg: TransferStartMessage = {
        type: 'TRANSFER_START',
        transferId: this.transferId,
        manifest: this.manifest,
      };
      this.dc.send(JSON.stringify(startMsg));

      this.logger?.log('transfer_start_sent', {
        transferId: this.transferId,
        fileSize: this.totalBytes,
      });

      await this.transferFiles();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown transfer error';
      console.error('[TRANSFER][SEND] Transfer failed:', errorMsg);
      this.logger?.log('sender_error', {
        transferId: this.transferId,
        message: errorMsg,
      });
      if (this.onError && !this.isCompleted && !this.isPaused) {
        this.onError(errorMsg);
      }
    } finally {
      this.dc.removeEventListener('message', controlHandler);
      this.dc.removeEventListener('close', closeHandler);
      this.onControlAbort = null;
    }
  }

  async resume(newDc?: RTCDataChannel): Promise<void> {
    if (newDc) {
      this.attachDataChannel(newDc);
    }
    this.cancelled = false;
    this.isPaused = false;
    this.isCompleted = false;
    this.abortedError = null;

    console.log(`[TRANSFER][SEND] Initiating resume handshake for transfer ${this.transferId}`);
    if (this.onProgress && this.files.length > 0) {
      this.updateProgress(0, 'resuming');
    }

    const controlHandler = (event: MessageEvent) => {
      if (this.isCompleted || this.cancelled) return;
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'CANCEL') {
            console.log('[TRANSFER][SEND] Received CANCEL signal from receiver');
            this.cancelled = true;
            this.abortedError = new Error(`Transfer cancelled by receiver: ${msg.reason || 'unspecified'}`);
            if (this.onControlAbort) {
              this.onControlAbort(this.abortedError);
            }
          } else if (msg.type === 'ERROR') {
            console.error('[TRANSFER][SEND] Received ERROR signal from receiver', msg);
            this.cancelled = true;
            this.abortedError = new Error(`Transfer error from receiver: ${msg.message || msg.code || 'Transfer error'}`);
            if (this.onControlAbort) {
              this.onControlAbort(this.abortedError);
            }
          }
        } catch {
          // ignore malformed JSON
        }
      }
    };

    const closeHandler = () => {
      if (this.isCompleted || this.cancelled || this.isPaused) return;
      this.cancelled = true;
      this.abortedError = new Error('DataChannel closed unexpectedly');
      if (this.onControlAbort) {
        this.onControlAbort(this.abortedError);
      }
    };

    this.dc.addEventListener('message', controlHandler);
    this.dc.addEventListener('close', closeHandler);

    try {
      if (!this.manifest) {
        // If manifest was never computed, run fresh start
        await this.start();
        return;
      }

      const resumeReq: ResumeRequestMessage = {
        type: 'RESUME_REQUEST',
        transferId: this.transferId,
        manifest: this.manifest,
      };

      this.dc.send(JSON.stringify(resumeReq));

      const resumeResponse = await new Promise<ResumeResponseMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Timeout waiting for RESUME_RESPONSE from receiver'));
        }, this.resumeTimeoutMs);

        const cleanup = () => {
          clearTimeout(timer);
          this.dc.removeEventListener('message', handler);
          this.dc.removeEventListener('close', closeHandler);
          this.onControlAbort = null;
        };

        this.onControlAbort = (err: Error) => {
          cleanup();
          reject(err);
        };

        const closeHandler = () => {
          cleanup();
          reject(new Error('DataChannel closed while waiting for RESUME_RESPONSE'));
        };

        const handler = (event: MessageEvent) => {
          if (typeof event.data === 'string') {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === 'RESUME_RESPONSE' && msg.transferId === this.transferId) {
                console.log('[TRANSFER][SEND] Received RESUME_RESPONSE:', msg);
                cleanup();
                resolve(msg as ResumeResponseMessage);
              }
            } catch {
              // ignore parse errors
            }
          }
        };

        this.dc.addEventListener('message', handler);
        this.dc.addEventListener('close', closeHandler);
      });

      if (!resumeResponse.accepted) {
        throw new Error(`Resume rejected by receiver: ${resumeResponse.error || 'unauthorized or mismatched transfer'}`);
      }

      const fileStatusMap = new Map<string, ResumeFileStatus>();
      if (resumeResponse.files) {
        for (const fileStatus of resumeResponse.files) {
          fileStatusMap.set(fileStatus.fileId, fileStatus);
        }
      }

      // Recalculate accurately bytesTransferred already acknowledged
      let recomputedBytes = 0;
      for (let i = 0; i < this.manifest.files.length; i++) {
        const mFile = this.manifest.files[i];
        const status = fileStatusMap.get(mFile.id);
        if (status?.completed) {
          recomputedBytes += mFile.size;
        } else if (status) {
          const missingCount = status.missingChunks.length;
          const receivedCount = Math.max(0, mFile.totalChunks - missingCount);
          const receivedBytesForFile = Math.min(mFile.size, receivedCount * CHUNK_SIZE);
          recomputedBytes += receivedBytesForFile;
        }
      }
      this.bytesTransferred = recomputedBytes;
      console.log(`[TRANSFER][SEND] Resuming transfer at ${this.bytesTransferred}/${this.totalBytes} bytes`);

      await this.transferFiles(fileStatusMap);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Resume failed';
      console.error('[TRANSFER][SEND] Resume failed:', errorMsg);
      if (this.onError && !this.isCompleted && !this.isPaused) {
        this.onError(errorMsg);
      }
    } finally {
      this.dc.removeEventListener('message', controlHandler);
      this.dc.removeEventListener('close', closeHandler);
      this.onControlAbort = null;
    }
  }

  private async transferFiles(fileStatusMap?: Map<string, ResumeFileStatus>): Promise<void> {
    if (!this.manifest) return;

    for (let i = 0; i < this.files.length; i++) {
      if (this.cancelled || this.isPaused) return;

      const file = this.files[i];
      const manifestEntry = this.manifest.files[i];
      const fileId = manifestEntry.id;
      const totalChunks = manifestEntry.totalChunks;

      const fileStatus = fileStatusMap?.get(fileId);
      if (fileStatus?.completed) {
        console.log(`[TRANSFER][SEND] File '${file.name}' (${fileId}) already completed on receiver, skipping transmission`);
        continue;
      }

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
      };
      this.dc.send(JSON.stringify(fileStartMsg));

      this.logger?.log('file_start_sent', {
        transferId: this.transferId,
        fileId,
        fileName: file.name,
        fileSize: file.size,
        totalChunks,
      });

      const isResumedFile = fileStatus !== undefined;
      let finalHash: string;

      if (isResumedFile) {
        // Resuming: check if hash is already cached
        const cachedHash = this.hashes.get(fileId);
        let hashPromise: Promise<string>;
        if (cachedHash) {
          hashPromise = Promise.resolve(cachedHash);
        } else {
          console.log(`[TRANSFER][SEND] Hashing file '${file.name}' concurrently during resume`);
          hashPromise = sha256File(
            file,
            undefined,
            () => this.cancelled || this.isPaused || !!this.abortedError
          ).then((h) => {
            this.hashes.set(fileId, h);
            return h;
          });
        }

        const chunksToSend = fileStatus.missingChunks;
        console.log(`[TRANSFER][SEND] Transmitting ${chunksToSend.length}/${totalChunks} missing chunks for '${file.name}'`);

        let firstChunkLogged = false;
        let lastChunkLoggedIndex = -1;

        for (const j of chunksToSend) {
          if (this.cancelled || this.isPaused || this.abortedError) {
            if (this.abortedError) throw this.abortedError;
            return;
          }

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
          const view = new DataView(payload.buffer);
          view.setUint32(0, headerBytes.length, false);
          payload.set(headerBytes, 4);
          payload.set(new Uint8Array(chunkData), 4 + headerBytes.length);

          await sendChunkWithBackpressure(this.dc, payload.buffer);

          if (this.cancelled || this.isPaused || this.abortedError) {
            if (this.abortedError) throw this.abortedError;
            return;
          }

          this.bytesTransferred += chunkData.byteLength;

          if (!firstChunkLogged) {
            firstChunkLogged = true;
            this.logger?.log('first_chunk_sent', {
              transferId: this.transferId,
              fileId,
              fileName: file.name,
              chunkIndex: j,
              totalChunks,
            });
          }

          if (j - lastChunkLoggedIndex >= 100 || j === chunksToSend[chunksToSend.length - 1]) {
            lastChunkLoggedIndex = j;
            const pct = totalChunks > 0 ? Math.round(((j + 1) / totalChunks) * 100) : 100;
            this.logger?.log('chunk_progress', {
              transferId: this.transferId,
              fileId,
              fileName: file.name,
              chunkIndex: j + 1,
              totalChunks,
              percent: pct,
            });
          }

          if (j % 500 === 0 || j === chunksToSend[chunksToSend.length - 1]) {
            console.log(`[TRANSFER][SEND][CHUNK] sent index=${j + 1}/${totalChunks} bytes=${chunkData.byteLength}`);
          }

          if (j % 10 === 0 || j === chunksToSend[chunksToSend.length - 1]) {
            this.updateProgress(i, 'sending');
          }
        }

        finalHash = await hashPromise;
      } else {
        // Fresh transfer: stream hash chunk by chunk
        const hasher = await createStreamingHasher();
        const chunksToSend = Array.from({ length: totalChunks }, (_, idx) => idx);
        console.log(`[TRANSFER][SEND] Transmitting ${chunksToSend.length}/${totalChunks} chunks for '${file.name}'`);

        let firstChunkLogged = false;
        let lastChunkLoggedIndex = -1;

        for (const j of chunksToSend) {
          if (this.cancelled || this.isPaused || this.abortedError) {
            if (this.abortedError) throw this.abortedError;
            return;
          }

          const start = j * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunkBlob = file.slice(start, end);
          const chunkData = await chunkBlob.arrayBuffer();

          hasher.update(new Uint8Array(chunkData));

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
          const view = new DataView(payload.buffer);
          view.setUint32(0, headerBytes.length, false);
          payload.set(headerBytes, 4);
          payload.set(new Uint8Array(chunkData), 4 + headerBytes.length);

          await sendChunkWithBackpressure(this.dc, payload.buffer);

          if (this.cancelled || this.isPaused || this.abortedError) {
            if (this.abortedError) throw this.abortedError;
            return;
          }

          this.bytesTransferred += chunkData.byteLength;

          if (!firstChunkLogged) {
            firstChunkLogged = true;
            this.logger?.log('first_chunk_sent', {
              transferId: this.transferId,
              fileId,
              fileName: file.name,
              chunkIndex: j,
              totalChunks,
            });
          }

          if (j - lastChunkLoggedIndex >= 100 || j === chunksToSend[chunksToSend.length - 1]) {
            lastChunkLoggedIndex = j;
            const pct = totalChunks > 0 ? Math.round(((j + 1) / totalChunks) * 100) : 100;
            this.logger?.log('chunk_progress', {
              transferId: this.transferId,
              fileId,
              fileName: file.name,
              chunkIndex: j + 1,
              totalChunks,
              percent: pct,
            });
          }

          if (j % 500 === 0 || j === chunksToSend[chunksToSend.length - 1]) {
            console.log(`[TRANSFER][SEND][CHUNK] sent index=${j + 1}/${totalChunks} bytes=${chunkData.byteLength}`);
          }

          if (j % 10 === 0 || j === chunksToSend[chunksToSend.length - 1]) {
            this.updateProgress(i, 'sending');
          }
        }

        finalHash = hasher.digest();
        this.hashes.set(fileId, finalHash);
      }

      console.log(`[TRANSFER][SEND] Sending FILE_END for file ${i + 1} (${file.name}) with sha256=${finalHash}`);
      const fileEndMsg: FileEndMessage = {
        type: 'FILE_END',
        transferId: this.transferId,
        fileId,
        sha256: finalHash,
      };
      this.dc.send(JSON.stringify(fileEndMsg));

      this.logger?.log('file_end_sent', {
        transferId: this.transferId,
        fileId,
        fileName: file.name,
        totalChunks,
      });

      // Wait for FILE_ACK with rolling timeout (reset on VERIFYING keepalives) up to hard ceiling
      await new Promise<void>((resolve, reject) => {
        let ackTimer: ReturnType<typeof setTimeout> | null = null;
        let hardCeilingTimer: ReturnType<typeof setTimeout> | null = null;

        const resetAckTimer = () => {
          if (ackTimer) clearTimeout(ackTimer);
          ackTimer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting for receiver ACK for file ${file.name}`));
          }, this.ackTimeoutMs);
        };

        resetAckTimer();

        hardCeilingTimer = setTimeout(() => {
          cleanup();
          reject(new Error(`Hard ceiling timeout exceeded waiting for receiver ACK for file ${file.name}`));
        }, this.ackHardCeilingTimeoutMs);

        const cleanup = () => {
          if (ackTimer) clearTimeout(ackTimer);
          if (hardCeilingTimer) clearTimeout(hardCeilingTimer);
          this.dc.removeEventListener('message', handler);
          this.dc.removeEventListener('close', closeHandler);
          this.onControlAbort = null;
        };

        this.onControlAbort = (err: Error) => {
          cleanup();
          reject(err);
        };

        const closeHandler = () => {
          cleanup();
          reject(new Error(`DataChannel closed while waiting for receiver ACK for file ${file.name}`));
        };

        const handler = (event: MessageEvent) => {
          if (typeof event.data === 'string') {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === 'FILE_ACK' && msg.fileId === fileId && msg.transferId === this.transferId) {
                console.log(`[TRANSFER][SEND] Received FILE_ACK (fileId=${fileId}, match=${msg.sha256Match})`);
                this.logger?.log('file_ack_received', {
                  transferId: this.transferId,
                  fileId,
                  fileName: file.name,
                  message: `match=${msg.sha256Match}`,
                });
                cleanup();
                if (!msg.sha256Match) {
                  reject(new Error(`SHA-256 mismatch on receiver for file '${file.name}': ${msg.error || 'integrity check failed'}`));
                } else {
                  resolve();
                }
              } else if (msg.type === 'VERIFYING' && msg.fileId === fileId && msg.transferId === this.transferId) {
                console.log(`[TRANSFER][SEND] Received VERIFYING keepalive for file ${fileId}`);
                resetAckTimer();
              }
            } catch {
              // ignore JSON parse errors on malformed messages
            }
          }
        };

        this.dc.addEventListener('message', handler);
        this.dc.addEventListener('close', closeHandler);
      });
    }

    if (this.cancelled || this.isPaused || this.abortedError) {
      if (this.abortedError) throw this.abortedError;
      return;
    }
    console.log('[TRANSFER][SEND] Sending TRANSFER_END');
    const transferEndMsg: TransferEndMessage = {
      type: 'TRANSFER_END',
      transferId: this.transferId,
    };
    this.dc.send(JSON.stringify(transferEndMsg));

    this.logger?.log('transfer_end_sent', {
      transferId: this.transferId,
      fileSize: this.totalBytes,
    });

    this.logger?.log('sender_completed', {
      transferId: this.transferId,
      fileSize: this.totalBytes,
      elapsedMs: Math.round(Date.now() - this.startTime),
    });

    this.isCompleted = true;
    if (this.onComplete) this.onComplete();
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

  private lastProgressEmitTime = 0;

  private updateProgress(fileIndex: number, state: TransferProgress['state'], force = false) {
    if (!this.onProgress) return;

    const now = performance.now();
    const currentFile = this.files[fileIndex] || this.files[0];
    const currentName = currentFile ? currentFile.name : '';
    const percentage = this.totalBytes === 0 ? 100 : Math.min(100, (this.bytesTransferred / this.totalBytes) * 100);

    // Throttle progress updates to at most 4/s (every 250ms), except for forced updates, state transitions, or 100% completion
    if (!force && percentage < 100 && now - this.lastProgressEmitTime < 250) {
      return;
    }
    this.lastProgressEmitTime = now;

    const elapsed = (Date.now() - this.startTime) / 1000;
    const speed = elapsed > 0 ? this.bytesTransferred / elapsed : 0;
    const eta = speed > 0 ? Math.max(0, (this.totalBytes - this.bytesTransferred) / speed) : 0;

    this.onProgress({
      currentFile: currentName,
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

export interface ReceiverOptions {
  expectedTransferId?: string;
  stallTimeoutMs?: number;
  manifestTimeoutMs?: number;
  prepareHardCeilingTimeoutMs?: number;
  storage?: TransferStorage;
}

export type ReceiverLifecycleState =
  | 'idle'
  | 'waiting_for_manifest'
  | 'receiving_file'
  | 'verifying'
  | 'acknowledging'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const DEFAULT_MANIFEST_TIMEOUT_MS = 120000; // 120s for sender pre-transfer hashing

export class FileReceiver {
  private dc: RTCDataChannel;
  private storage: TransferStorage;
  private manifest: TransferManifest | null = null;
  private activeTransferId: string | null = null;
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
  private manifestTimeoutMs: number;
  private prepareHardCeilingTimeoutMs: number;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private manifestHardCeilingTimer: ReturnType<typeof setTimeout> | null = null;
  private messageListener: ((event: MessageEvent) => void) | null = null;
  private messageQueue: Promise<void> = Promise.resolve();
  private state: ReceiverLifecycleState = 'idle';

  constructor(dc: RTCDataChannel, options?: ReceiverOptions) {
    this.dc = dc;
    this.dc.binaryType = 'arraybuffer';
    this.activeTransferId = options?.expectedTransferId || null;
    this.stallTimeoutMs = options?.stallTimeoutMs || DEFAULT_STALL_TIMEOUT_MS;
    this.manifestTimeoutMs = options?.manifestTimeoutMs || DEFAULT_MANIFEST_TIMEOUT_MS;
    this.prepareHardCeilingTimeoutMs = options?.prepareHardCeilingTimeoutMs || PREPARE_HARD_CEILING_TIMEOUT_MS;
    this.storage = options?.storage || new MemoryTransferStorage();
  }

  getStorage(): TransferStorage {
    return this.storage;
  }

  getTransferId(): string | null {
    return this.activeTransferId;
  }

  getManifest(): TransferManifest | null {
    return this.manifest;
  }

  getAssembledFiles(): AssembledFile[] {
    return this.assembledFiles;
  }

  getState(): ReceiverLifecycleState {
    return this.state;
  }

  attachDataChannel(newDc: RTCDataChannel): void {
    console.log('[TRANSFER][RECEIVE] Attaching new DataChannel to FileReceiver');
    if (this.messageListener && this.dc) {
      this.dc.removeEventListener('message', this.messageListener);
    }
    this.dc = newDc;
    this.dc.binaryType = 'arraybuffer';
    this.bindDataChannelEvents();
  }

  resume(newDc?: RTCDataChannel): void {
    console.log('[TRANSFER][RECEIVE] FileReceiver resuming');
    if (newDc) {
      this.attachDataChannel(newDc);
    }
    this.transitionTo('receiving_file');
    this.resetStallTimer();
    this.updateProgress('resuming');
  }

  start(): void {
    this.bindDataChannelEvents();
    this.transitionTo('waiting_for_manifest');
    this.resetStallTimer(this.manifestTimeoutMs);
    this.armManifestHardCeilingTimer();
  }

  private transitionTo(newState: ReceiverLifecycleState) {
    console.log(`[TRANSFER][RECEIVE] State transition: ${this.state} -> ${newState}`);
    this.state = newState;
  }

  private bindDataChannelEvents(): void {
    if (this.messageListener && this.dc) {
      this.dc.removeEventListener('message', this.messageListener);
    }

    this.messageListener = (event: MessageEvent) => {
      if (this.cancelled) return;

      this.messageQueue = this.messageQueue
        .then(() => this.processMessage(event))
        .catch((err) => {
          console.error('[TRANSFER][RECEIVE] Message processing error:', err);
        });
    };

    this.dc.addEventListener('message', this.messageListener);
  }

  private async processMessage(event: MessageEvent): Promise<void> {
    if (this.cancelled) return;

    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data);
        console.log(`[TRANSFER][RECEIVE] Control message received: ${msg.type}`);

        switch (msg.type) {
          case 'PREPARING': {
            if (this.state === 'waiting_for_manifest') {
              const prepMsg = msg as PreparingMessage;
              if (this.activeTransferId && prepMsg.transferId && prepMsg.transferId !== this.activeTransferId) {
                console.warn(
                  `[TRANSFER][RECEIVE] PREPARING transferId mismatch (expected ${this.activeTransferId}, got ${prepMsg.transferId}) - ignoring`
                );
                break;
              }
              if (!this.activeTransferId && prepMsg.transferId) {
                this.activeTransferId = prepMsg.transferId;
              }
              console.log(`[TRANSFER][RECEIVE] Received PREPARING keepalive (progress=${prepMsg.progress}%)`);
              this.resetStallTimer(this.manifestTimeoutMs);
            }
            break;
          }

          case 'TRANSFER_START': {
            this.clearManifestHardCeilingTimer();
            const manifest = validateManifest(msg.manifest);
            if (this.activeTransferId && manifest.transferId !== this.activeTransferId) {
              throw new Error(`Transfer ID mismatch: expected ${this.activeTransferId}, got ${manifest.transferId}`);
            }
            this.activeTransferId = manifest.transferId;
            this.manifest = manifest;
            this.totalFiles = manifest.totalFiles;
            this.totalBytes = manifest.totalSize;
            this.startTime = Date.now();

            await this.storage.createTransfer(manifest);

            this.transitionTo('receiving_file');
            this.resetStallTimer();
            this.updateProgress('receiving');
            break;
          }

          case 'RESUME_REQUEST': {
            this.clearManifestHardCeilingTimer();
            const req = msg as ResumeRequestMessage;
            console.log(`[TRANSFER][RECEIVE] Received RESUME_REQUEST for transfer ${req.transferId}`);

            if (this.activeTransferId && req.transferId !== this.activeTransferId) {
              console.warn(`[TRANSFER][RECEIVE] RESUME_REQUEST transferId mismatch (${req.transferId} vs ${this.activeTransferId})`);
              const rejectResp: ResumeResponseMessage = {
                type: 'RESUME_RESPONSE',
                transferId: req.transferId,
                accepted: false,
                error: `Transfer ID mismatch: active is ${this.activeTransferId}`,
              };
              this.dc.send(JSON.stringify(rejectResp));
              return;
            }

            if (!this.manifest && req.manifest) {
              this.manifest = validateManifest(req.manifest);
              this.activeTransferId = this.manifest.transferId;
              this.totalFiles = this.manifest.totalFiles;
              this.totalBytes = this.manifest.totalSize;
              await this.storage.createTransfer(this.manifest);
            }

            if (!this.activeTransferId) {
              this.activeTransferId = req.transferId;
            }

            const fileStatuses: ResumeFileStatus[] = [];
            if (this.manifest) {
              for (const mFile of this.manifest.files) {
                const storedBlob = await this.storage.getFinalizedBlob(this.activeTransferId, mFile.id);
                const missingChunks = await this.storage.getMissingChunks(
                  this.activeTransferId,
                  mFile.id,
                  mFile.totalChunks
                );

                const isComplete =
                  storedBlob !== null ||
                  (missingChunks.length === 0 && (mFile.totalChunks === 0 || mFile.size === 0));

                fileStatuses.push({
                  fileId: mFile.id,
                  completed: isComplete,
                  missingChunks: isComplete ? [] : missingChunks,
                });
              }
            }

            const acceptResp: ResumeResponseMessage = {
              type: 'RESUME_RESPONSE',
              transferId: this.activeTransferId,
              accepted: true,
              files: fileStatuses,
            };

            console.log('[TRANSFER][RECEIVE] Sending RESUME_RESPONSE:', acceptResp);
            this.dc.send(JSON.stringify(acceptResp));
            this.transitionTo('receiving_file');
            this.resetStallTimer();
            this.updateProgress('resuming');
            break;
          }

          case 'FILE_START': {
            if (!this.manifest || !this.activeTransferId) {
              throw new Error('Received FILE_START before TRANSFER_START manifest or RESUME_REQUEST');
            }
            if (msg.transferId !== this.activeTransferId) {
              throw new Error(`FILE_START transferId mismatch (${msg.transferId} vs ${this.activeTransferId})`);
            }
            const manifestEntry = this.manifest.files.find((f) => f.id === msg.fileId);
            if (!manifestEntry) {
              throw new Error(`FILE_START fileId '${msg.fileId}' not found in authorized manifest`);
            }
            if (msg.size !== manifestEntry.size || msg.totalChunks !== manifestEntry.totalChunks) {
              throw new Error(`FILE_START metadata mismatch for file '${manifestEntry.name}'`);
            }
            if (manifestEntry.sha256 && msg.sha256 && msg.sha256 !== manifestEntry.sha256) {
              throw new Error(`FILE_START hash mismatch for file '${manifestEntry.name}'`);
            }

            await this.storage.initFile(this.activeTransferId, manifestEntry);

            this.currentFileName = manifestEntry.name;
            this.transitionTo('receiving_file');
            this.resetStallTimer();
            this.updateProgress('receiving');
            break;
          }

          case 'FILE_END': {
            if (!this.activeTransferId || msg.transferId !== this.activeTransferId) {
              throw new Error('FILE_END transferId mismatch');
            }
            const fileEndMsg = msg as FileEndMessage;
            if (typeof fileEndMsg.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(fileEndMsg.sha256)) {
              throw new Error(`FILE_END missing or invalid SHA-256 hash for fileId '${fileEndMsg.fileId}'`);
            }
            await this.handleFileEnd(fileEndMsg.fileId, fileEndMsg.sha256.toLowerCase());
            break;
          }

          case 'TRANSFER_END': {
            if (!this.activeTransferId || msg.transferId !== this.activeTransferId) {
              throw new Error('TRANSFER_END transferId mismatch');
            }
            console.log('[TRANSFER][RECEIVE] TRANSFER_END received, validating complete assembly');
            this.clearStallTimer();
            this.clearManifestHardCeilingTimer();
            if (this.manifest && this.assembledFiles.length !== this.manifest.totalFiles) {
              throw new Error(`Incomplete transfer: received ${this.assembledFiles.length} of ${this.manifest.totalFiles} files`);
            }
            this.transitionTo('completed');
            if (this.onComplete) {
              this.onComplete(this.assembledFiles);
            }
            break;
          }

          case 'CANCEL': {
            console.log('[TRANSFER][RECEIVE] CANCEL received');
            this.cancelled = true;
            this.clearStallTimer();
            this.clearManifestHardCeilingTimer();
            this.transitionTo('cancelled');
            if (this.onError) this.onError(msg.reason || 'Transfer cancelled by peer');
            break;
          }

          case 'ERROR': {
            console.error('[TRANSFER][RECEIVE] ERROR received from sender', msg);
            this.cancelled = true;
            this.clearStallTimer();
            this.clearManifestHardCeilingTimer();
            this.transitionTo('failed');
            if (this.onError) this.onError(msg.message || msg.code || 'Transfer error');
            break;
          }
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Malformed transfer message';
        console.error('[TRANSFER][RECEIVE] Control message error:', errorMsg);
        this.sendError('PROTOCOL_ERROR', errorMsg);
        this.clearStallTimer();
        this.transitionTo('failed');
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

        if (!this.manifest) {
          throw new Error('Chunk received before manifest initialized');
        }

        const manifestEntry = this.manifest.files.find((f) => f.id === header.fileId);
        if (!manifestEntry) {
          throw new Error(`Chunk rejected: unknown file ID '${header.fileId}'`);
        }

        if (header.index < 0 || header.index >= manifestEntry.totalChunks) {
          throw new Error(`Chunk rejected: index ${header.index} out of bounds (totalChunks=${manifestEntry.totalChunks})`);
        }

        const chunkData = new Uint8Array(buffer, 4 + headerLen);
        if (chunkData.byteLength > CHUNK_SIZE) {
          throw new Error(`Chunk rejected: oversized chunk (${chunkData.byteLength} > ${CHUNK_SIZE})`);
        }

        const alreadyHas = await this.storage.hasChunk(this.activeTransferId, header.fileId, header.index);
        if (alreadyHas) {
          console.log(`[TRANSFER][RECEIVE] Duplicate chunk ${header.index} received for file ${manifestEntry.name} - ignoring`);
        } else {
          await this.storage.writeChunk(this.activeTransferId, header.fileId, header.index, chunkData);
          this.totalReceivedBytes += chunkData.byteLength;

          if (header.index % 500 === 0 || header.index === manifestEntry.totalChunks - 1) {
            console.log(`[TRANSFER][RECV][CHUNK] persisted index=${header.index + 1}/${manifestEntry.totalChunks}`);
          }

          if (header.index % 10 === 0 || this.totalReceivedBytes >= this.totalBytes) {
            this.updateProgress('receiving');
          }
        }

        // Active chunk successfully received and written: reset network stall timer
        if (this.state === 'receiving_file') {
          this.resetStallTimer();
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Chunk processing error';
        console.error('[TRANSFER][RECEIVE] Chunk error:', errorMsg);
        this.cancelled = true;
        this.sendError('CHUNK_ERROR', errorMsg);
        this.clearStallTimer();
        this.transitionTo('failed');
        if (this.onError) this.onError(errorMsg);
      }
    }
  }

  private async handleFileEnd(fileId: string, expectedSha256: string) {
    const tFileEndStart = performance.now();
    console.log(`[TRANSFER][RECV][FILE_END] START fileId=${fileId}`);
    this.transitionTo('verifying');
    this.clearStallTimer();

    if (!this.manifest || !this.activeTransferId) {
      throw new Error(`FILE_END received without active manifest`);
    }

    const manifestEntry = this.manifest.files.find((f) => f.id === fileId);
    if (!manifestEntry) {
      throw new Error(`FILE_END received for unknown file ID '${fileId}'`);
    }

    // If manifest had a sha256 specified, verify that FILE_END matches it
    if (manifestEntry.sha256 && manifestEntry.sha256 !== expectedSha256) {
      throw new Error(
        `FILE_END sha256 mismatch with manifest for file '${manifestEntry.name}' (${expectedSha256} vs ${manifestEntry.sha256})`
      );
    }

    console.log(`[TRANSFER][RECV][FILE_END] checking missing chunks`);
    console.log(`[TRANSFER][RECV][FILE_END] expectedChunks=${manifestEntry.totalChunks}`);
    const receivedChunks = await this.storage.getReceivedChunks(this.activeTransferId, fileId);
    console.log(`[TRANSFER][RECV][FILE_END] receivedChunks=${receivedChunks.length}`);
    const missingChunks = await this.storage.getMissingChunks(this.activeTransferId, fileId, manifestEntry.totalChunks);
    console.log(`[TRANSFER][RECV][FILE_END] missingCount=${missingChunks.length}`);
    if (missingChunks.length > 0) {
      console.log(`[TRANSFER][RECV][FILE_END] missingIndexes=${JSON.stringify(missingChunks.slice(0, 10))}`);
      throw new Error(`Cannot verify file '${manifestEntry.name}': ${missingChunks.length} chunks missing`);
    }

    this.updateProgress('verifying');

    const sendVerifyingKeepalive = (progressBytes?: number) => {
      if (this.dc.readyState === 'open' && this.activeTransferId) {
        try {
          const verifyingMsg: FileVerifyingMessage = {
            type: 'VERIFYING',
            transferId: this.activeTransferId,
            fileId,
            progress: progressBytes,
          };
          this.dc.send(JSON.stringify(verifyingMsg));
        } catch {
          // ignore send error on closed channel
        }
      }
    };

    // Send first VERIFYING keepalive immediately
    sendVerifyingKeepalive(0);

    // Periodic 5s keepalive timer
    const keepaliveTimer = setInterval(() => {
      sendVerifyingKeepalive();
    }, VERIFYING_KEEPALIVE_INTERVAL_MS);

    try {
      const result = await this.storage.verifyAndFinalizeFile(
        this.activeTransferId,
        fileId,
        expectedSha256,
        (processed, total) => {
          if (total > 0) {
            this.updateProgress('verifying');
          }
        }
      );

      if (!result.match) {
        throw new Error(
          `SHA-256 mismatch for file '${manifestEntry.name}' (calculated ${result.calculatedSha256}, expected ${expectedSha256})`
        );
      }

      this.transitionTo('acknowledging');
      console.log(`[TRANSFER][RECV][ACK] sending FILE_ACK`);
      const ackMsg: FileAckMessage = {
        type: 'FILE_ACK',
        transferId: this.activeTransferId,
        fileId,
        sha256Match: true,
      };
      this.dc.send(JSON.stringify(ackMsg));
      console.log(`[TRANSFER][RECV][ACK] FILE_ACK sent`);

      this.assembledFiles.push({
        id: manifestEntry.id,
        name: manifestEntry.name,
        size: manifestEntry.size,
        blob: result.blob,
        verified: true,
        sha256: result.calculatedSha256,
      });

      this.currentFileIndex++;
      this.transitionTo('receiving_file');
      this.resetStallTimer();
      console.log(`[TRANSFER][RECV][FILE_END] COMPLETE fileId=${fileId} elapsed=${(performance.now() - tFileEndStart).toFixed(0)}ms`);
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
      try {
        this.dc.send(JSON.stringify(ackMsg));
      } catch {
        // ignore send error
      }
      this.sendError('VERIFY_FAILED', errorMsg);
      this.clearStallTimer();
      this.transitionTo('failed');
      if (this.onError) {
        this.onError(errorMsg);
      }
    } finally {
      clearInterval(keepaliveTimer);
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
    this.clearManifestHardCeilingTimer();
    this.transitionTo('cancelled');
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

  private armManifestHardCeilingTimer() {
    this.clearManifestHardCeilingTimer();
    this.manifestHardCeilingTimer = setTimeout(() => {
      console.error('[TRANSFER][RECEIVE] Preparation phase exceeded maximum timeout limit');
      this.cancelled = true;
      this.clearStallTimer();
      this.clearManifestHardCeilingTimer();
      this.transitionTo('failed');
      this.sendError('PREPARE_TIMEOUT', 'Preparation phase exceeded 30 minute limit');
      if (this.onError) {
        this.onError('Preparation phase exceeded maximum timeout limit');
      }
    }, this.prepareHardCeilingTimeoutMs);
  }

  private clearManifestHardCeilingTimer() {
    if (this.manifestHardCeilingTimer) {
      clearTimeout(this.manifestHardCeilingTimer);
      this.manifestHardCeilingTimer = null;
    }
  }

  private resetStallTimer(timeoutMs?: number) {
    this.clearStallTimer();
    const duration = timeoutMs || this.stallTimeoutMs;
    this.stallTimer = setTimeout(() => {
      console.error('[TRANSFER][RECEIVE] Transfer timed out (no activity received within limit)');
      this.cancelled = true;
      this.clearManifestHardCeilingTimer();
      this.transitionTo('failed');
      this.sendError('STALL_TIMEOUT', 'Transfer timed out due to inactivity');
      if (this.onError) {
        this.onError('Transfer timed out due to inactivity');
      }
    }, duration);
  }

  private clearStallTimer() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private lastProgressEmitTime = 0;
  private lastEmittedState: TransferProgress['state'] | null = null;

  private updateProgress(state: TransferProgress['state'], force = false) {
    if (!this.onProgress) return;

    const now = performance.now();
    const percentage = this.totalBytes === 0 ? 100 : Math.min(100, (this.totalReceivedBytes / this.totalBytes) * 100);

    const stateChanged = this.lastEmittedState !== state;

    // Throttle progress updates to at most 4/s (every 250ms), except for forced updates, state transitions, or 100% completion
    if (!force && !stateChanged && percentage < 100 && now - this.lastProgressEmitTime < 250) {
      return;
    }
    this.lastEmittedState = state;
    this.lastProgressEmitTime = now;

    const elapsed = (Date.now() - this.startTime) / 1000;
    const speed = elapsed > 0 ? this.totalReceivedBytes / elapsed : 0;
    const eta = speed > 0 ? Math.max(0, (this.totalBytes - this.totalReceivedBytes) / speed) : 0;

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



