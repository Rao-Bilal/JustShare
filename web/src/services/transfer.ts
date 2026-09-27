import {
  AssembledFile,
  ChunkHeader,
  FileAckMessage,
  FileEndMessage,
  FileStartMessage,
  ManifestFileEntry,
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
import { sha256File } from './crypto';
import { MemoryTransferStorage } from './storage/memory';
import { TransferStorage } from './storage/types';

export const CHUNK_SIZE = 65536; // 64 KB
export const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024; // 100 GB
export const MAX_FILES_COUNT = 10000;
export const MAX_FILENAME_LENGTH = 255;
export const DEFAULT_ACK_TIMEOUT_MS = 30000; // 30s
export const DEFAULT_STALL_TIMEOUT_MS = 30000; // 30s
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
  resumeTimeoutMs?: number;
}

export class FileSender {
  private dc: RTCDataChannel;
  private files: File[];
  private transferId: string;
  private ackTimeoutMs: number;
  private resumeTimeoutMs: number;
  private hashes: Map<string, string> = new Map();
  private manifest: TransferManifest | null = null;
  public onProgress: ((progress: TransferProgress) => void) | null = null;
  public onComplete: (() => void) | null = null;
  public onError: ((error: string) => void) | null = null;
  private cancelled = false;
  private isPaused = false;

  private totalBytes = 0;
  private bytesTransferred = 0;
  private startTime = 0;

  constructor(dc: RTCDataChannel, files: File[], options?: SenderOptions) {
    this.dc = dc;
    this.files = files;
    this.transferId = options?.transferId || (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `tx_${Date.now()}`);
    this.ackTimeoutMs = options?.ackTimeoutMs || DEFAULT_ACK_TIMEOUT_MS;
    this.resumeTimeoutMs = options?.resumeTimeoutMs || DEFAULT_RESUME_TIMEOUT_MS;

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
    console.log('[TRANSFER][SEND] Calculating hashes before transfer start');

    try {
      const manifestFiles: ManifestFileEntry[] = [];

      for (let i = 0; i < this.files.length; i++) {
        if (this.cancelled || this.isPaused) return;
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

      if (this.cancelled || this.isPaused) return;

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

      await this.transferFiles();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown transfer error';
      console.error('[TRANSFER][SEND] Transfer failed:', errorMsg);
      if (this.onError && !this.cancelled && !this.isPaused) {
        this.onError(errorMsg);
      }
    }
  }

  async resume(newDc?: RTCDataChannel): Promise<void> {
    if (newDc) {
      this.attachDataChannel(newDc);
    }
    if (this.cancelled) return;
    this.isPaused = false;

    console.log(`[TRANSFER][SEND] Initiating resume handshake for transfer ${this.transferId}`);
    if (this.onProgress && this.files.length > 0) {
      this.updateProgress(0, 'resuming');
    }

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
              } else if (msg.type === 'CANCEL') {
                cleanup();
                reject(new Error(`Transfer cancelled by receiver: ${msg.reason}`));
              } else if (msg.type === 'ERROR') {
                cleanup();
                reject(new Error(`Receiver error: ${msg.message || msg.code}`));
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
      if (this.onError && !this.cancelled && !this.isPaused) {
        this.onError(errorMsg);
      }
    }
  }

  private async transferFiles(fileStatusMap?: Map<string, ResumeFileStatus>): Promise<void> {
    if (!this.manifest) return;

    for (let i = 0; i < this.files.length; i++) {
      if (this.cancelled || this.isPaused) return;

      const file = this.files[i];
      const manifestEntry = this.manifest.files[i];
      const fileId = manifestEntry.id;
      const hash = manifestEntry.sha256;
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
        sha256: hash,
      };
      this.dc.send(JSON.stringify(fileStartMsg));

      const chunksToSend = fileStatus
        ? fileStatus.missingChunks
        : Array.from({ length: totalChunks }, (_, idx) => idx);

      console.log(`[TRANSFER][SEND] Transmitting ${chunksToSend.length}/${totalChunks} chunks for '${file.name}'`);

      for (const j of chunksToSend) {
        if (this.cancelled || this.isPaused) return;

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
        if (j % 10 === 0 || j === chunksToSend[chunksToSend.length - 1]) {
          this.updateProgress(i, 'sending');
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
          cleanup();
          reject(new Error(`Timeout waiting for receiver ACK for file ${file.name}`));
        }, this.ackTimeoutMs);

        const cleanup = () => {
          clearTimeout(timer);
          this.dc.removeEventListener('message', handler);
          this.dc.removeEventListener('close', closeHandler);
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
                cleanup();
                if (!msg.sha256Match) {
                  reject(new Error(`SHA-256 mismatch on receiver for file '${file.name}': ${msg.error || 'integrity check failed'}`));
                } else {
                  resolve();
                }
              } else if (msg.type === 'CANCEL') {
                console.log('[TRANSFER][SEND] Received CANCEL signal');
                cleanup();
                reject(new Error(`Transfer cancelled by receiver: ${msg.reason}`));
              } else if (msg.type === 'ERROR') {
                console.error('[TRANSFER][SEND] Received ERROR signal', msg);
                cleanup();
                reject(new Error(`Transfer error from receiver: ${msg.message || msg.code}`));
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

    if (this.cancelled || this.isPaused) return;
    console.log('[TRANSFER][SEND] Sending TRANSFER_END');
    const transferEndMsg: TransferEndMessage = {
      type: 'TRANSFER_END',
      transferId: this.transferId,
    };
    this.dc.send(JSON.stringify(transferEndMsg));
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

  private updateProgress(fileIndex: number, state: TransferProgress['state']) {
    if (!this.onProgress) return;

    const currentFile = this.files[fileIndex] || this.files[0];
    const currentName = currentFile ? currentFile.name : '';
    const percentage = this.totalBytes === 0 ? 100 : Math.min(100, (this.bytesTransferred / this.totalBytes) * 100);

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
  storage?: TransferStorage;
}

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
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private messageListener: ((event: MessageEvent) => void) | null = null;

  constructor(dc: RTCDataChannel, options?: ReceiverOptions) {
    this.dc = dc;
    this.dc.binaryType = 'arraybuffer';
    this.activeTransferId = options?.expectedTransferId || null;
    this.stallTimeoutMs = options?.stallTimeoutMs || DEFAULT_STALL_TIMEOUT_MS;
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
    this.resetStallTimer();
    this.updateProgress('resuming');
  }

  start(): void {
    this.bindDataChannelEvents();
    this.resetStallTimer();
  }

  private bindDataChannelEvents(): void {
    if (this.messageListener && this.dc) {
      this.dc.removeEventListener('message', this.messageListener);
    }

    this.messageListener = async (event: MessageEvent) => {
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

              await this.storage.createTransfer(manifest);

              this.updateProgress('receiving');
              break;
            }

            case 'RESUME_REQUEST': {
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
              if (msg.size !== manifestEntry.size || msg.totalChunks !== manifestEntry.totalChunks || msg.sha256 !== manifestEntry.sha256) {
                throw new Error(`FILE_START metadata mismatch for file '${manifestEntry.name}'`);
              }

              await this.storage.initFile(this.activeTransferId, manifestEntry);

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

            if (header.index % 10 === 0 || this.totalReceivedBytes >= this.totalBytes) {
              this.updateProgress('receiving');
            }
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : 'Chunk processing error';
          console.error('[TRANSFER][RECEIVE] Chunk error:', errorMsg);
          this.cancelled = true;
          this.sendError('CHUNK_ERROR', errorMsg);
          this.clearStallTimer();
          if (this.onError) this.onError(errorMsg);
        }
      }
    };

    this.dc.addEventListener('message', this.messageListener);
  }

  private async handleFileEnd(fileId: string) {
    if (!this.manifest || !this.activeTransferId) {
      throw new Error(`FILE_END received without active manifest`);
    }

    const manifestEntry = this.manifest.files.find((f) => f.id === fileId);
    if (!manifestEntry) {
      throw new Error(`FILE_END received for unknown file ID '${fileId}'`);
    }

    this.updateProgress('verifying');

    try {
      const result = await this.storage.verifyAndFinalizeFile(
        this.activeTransferId,
        fileId,
        manifestEntry.sha256,
        (processed, total) => {
          if (total > 0) {
            this.updateProgress('verifying');
          }
        }
      );

      if (!result.match) {
        throw new Error(
          `SHA-256 mismatch for file '${manifestEntry.name}' (calculated ${result.calculatedSha256}, expected ${manifestEntry.sha256})`
        );
      }

      const ackMsg: FileAckMessage = {
        type: 'FILE_ACK',
        transferId: this.activeTransferId,
        fileId,
        sha256Match: true,
      };
      this.dc.send(JSON.stringify(ackMsg));

      this.assembledFiles.push({
        id: manifestEntry.id,
        name: manifestEntry.name,
        size: manifestEntry.size,
        blob: result.blob,
        verified: true,
        sha256: result.calculatedSha256,
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

    const percentage = this.totalBytes === 0 ? 100 : Math.min(100, (this.totalReceivedBytes / this.totalBytes) * 100);

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


