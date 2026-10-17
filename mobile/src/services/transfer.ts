/**
 * Streaming Native File Transfer Engine for JustShare Mobile.
 * 
 * Implements:
 * 1. 64 KB binary chunk packaging: [4B uint32 BE Header Length][JSON ChunkHeader][Raw binary chunk]
 * 2. High/low backpressure drain guards via bufferedAmount & bufferedAmountLowThreshold
 * 3. Bounded-memory chunk streaming from disk via expo-file-system base64 offsets & lengths
 * 4. Streaming SHA-256 incremental checksum validation via MobileIncrementalSha256
 * 5. Full compatibility with the existing web app's transfer state machine
 */
import * as FileSystem from 'expo-file-system/legacy';
import { MobileIncrementalSha256 } from './crypto';
import {
  ChunkHeader,
  FileEndMessage,
  FileStartMessage,
  FileVerifyingMessage,
  ManifestFileEntry,
  NativeFile,
  TransferCancelMessage,
  TransferEndMessage,
  TransferErrorMessage,
  TransferManifest,
  TransferProgress,
  TransferStartMessage,
} from '../types/transfer';

export interface FileAckMessage {
  type: 'FILE_ACK';
  transferId: string;
  fileId: string;
  sha256Match: boolean;
  error?: string;
}

export const CHUNK_SIZE = 65536; // 64 KB
export const BACKPRESSURE_HIGH_WATERMARK = 1024 * 1024; // 1 MB
export const BACKPRESSURE_LOW_WATERMARK = 256 * 1024; // 256 KB
export const DEFAULT_ACK_TIMEOUT_MS = 60000; // 60s
export const VERIFYING_KEEPALIVE_INTERVAL_MS = 5000; // 5s

/**
 * Validates filename to prevent path traversal.
 */
export function validateFilename(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return false;
  return !trimmed.includes('\0') && !trimmed.includes('..') && !trimmed.includes('/') && !trimmed.includes('\\');
}

/**
 * Base64 string to Uint8Array helper
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Uint8Array to Base64 string helper
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Reads a single 64 KB slice of a file directly from disk without reading the whole file into RAM.
 */
export async function readNativeFileChunk(uri: string, position: number, length: number): Promise<Uint8Array> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    position,
    length,
  });
  return base64ToUint8Array(base64);
}

/**
 * Calculates SHA-256 hash of a file on disk chunk-by-chunk in bounded memory (64 KB at a time).
 */
export async function calculateNativeFileSha256(uri: string, fileSize: number): Promise<string> {
  const hasher = new MobileIncrementalSha256();
  let offset = 0;

  while (offset < fileSize) {
    const sliceLen = Math.min(CHUNK_SIZE, fileSize - offset);
    const chunkBytes = await readNativeFileChunk(uri, offset, sliceLen);
    hasher.update(chunkBytes);
    offset += sliceLen;
  }

  return hasher.digest().toLowerCase();
}

/**
 * Sends a binary chunk across DataChannel with backpressure flow control.
 */
export async function sendChunkWithBackpressure(dc: any, data: ArrayBuffer): Promise<void> {
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
        reject(new Error('DataChannel closed during backpressure drain'));
      };
      const cleanup = () => {
        if (dc.removeEventListener) {
          dc.removeEventListener('bufferedamountlow', onLow);
          dc.removeEventListener('close', onClose);
        }
      };
      if (dc.addEventListener) {
        dc.addEventListener('bufferedamountlow', onLow);
        dc.addEventListener('close', onClose);
      } else {
        dc.onbufferedamountlow = onLow;
        dc.onclose = onClose;
      }
    });
  }

  if (dc.readyState !== 'open') {
    throw new Error('DataChannel closed before dispatch');
  }

  dc.send(data);
}

/**
 * Native Mobile File Sender
 */
export class MobileFileSender {
  private dc: any;
  private files: NativeFile[];
  private transferId: string;
  private manifest: TransferManifest | null = null;
  private cancelled = false;
  private bytesTransferred = 0;
  private totalBytes = 0;
  private startTime = 0;

  public onProgress: ((progress: TransferProgress) => void) | null = null;
  public onComplete: (() => void) | null = null;
  public onError: ((err: string) => void) | null = null;

  constructor(dc: any, files: NativeFile[], transferId?: string) {
    this.dc = dc;
    this.files = files;
    this.transferId = transferId || `tx_${Date.now()}`;
    for (const f of files) {
      this.totalBytes += f.size;
    }
  }

  cancel(): void {
    this.cancelled = true;
    try {
      if (this.dc && this.dc.readyState === 'open') {
        const cancelMsg: TransferCancelMessage = {
          type: 'CANCEL',
          transferId: this.transferId,
          reason: 'Cancelled by user on mobile',
        };
        this.dc.send(JSON.stringify(cancelMsg));
      }
    } catch {}
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    this.cancelled = false;
    this.bytesTransferred = 0;

    if (!this.files || this.files.length === 0) {
      const err = 'Choose files first';
      console.warn(`[TRANSFER][SEND] ${err}`);
      if (this.onError) {
        this.onError(err);
      }
      return;
    }

    try {
      // Step 1: Precompute file SHA-256 hashes and create Manifest
      const manifestFiles: ManifestFileEntry[] = [];
      for (const file of this.files) {
        if (this.cancelled) return;
        const totalChunks = file.size === 0 ? 0 : Math.ceil(file.size / CHUNK_SIZE);
        const sha256 = await calculateNativeFileSha256(file.uri, file.size);

        manifestFiles.push({
          id: file.id,
          name: file.name,
          size: file.size,
          mimeType: file.mimeType,
          totalChunks,
          sha256,
        });
      }

      this.manifest = {
        transferId: this.transferId,
        totalFiles: manifestFiles.length,
        totalSize: this.totalBytes,
        files: manifestFiles,
      };

      // Step 2: Send TRANSFER_START
      const startMsg: TransferStartMessage = {
        type: 'TRANSFER_START',
        transferId: this.transferId,
        manifest: this.manifest,
      };
      console.log('[TRANSFER][DIAGNOSTIC][SEND] Raw files input to sender count:', this.files.length);
      console.log('[TRANSFER][DIAGNOSTIC][SEND] Stringified TRANSFER_START message:', JSON.stringify(startMsg));
      this.dc.send(JSON.stringify(startMsg));

      // Step 3: Stream each file chunk by chunk (bounded memory)
      for (let i = 0; i < this.files.length; i++) {
        if (this.cancelled) return;

        const file = this.files[i];
        const manifestEntry = this.manifest.files[i];
        const totalChunks = manifestEntry.totalChunks;

        const fileStartMsg: FileStartMessage = {
          type: 'FILE_START',
          transferId: this.transferId,
          fileId: file.id,
          name: file.name,
          size: file.size,
          chunkSize: CHUNK_SIZE,
          totalChunks,
          sha256: manifestEntry.sha256,
        };
        this.dc.send(JSON.stringify(fileStartMsg));

        // Read slices directly from disk one 64 KB chunk at a time
        for (let j = 0; j < totalChunks; j++) {
          if (this.cancelled) return;

          const start = j * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunkLen = end - start;

          const chunkData = await readNativeFileChunk(file.uri, start, chunkLen);

          // Build chunk header
          const header: ChunkHeader = {
            transferId: this.transferId,
            fileId: file.id,
            index: j,
            totalChunks,
            byteLength: chunkData.byteLength,
          };
          const headerStr = JSON.stringify(header);
          const headerBytes = new TextEncoder().encode(headerStr);

          // Wire format: [4B uint32 BE Header Length][JSON ChunkHeader][Raw binary chunk]
          const payload = new Uint8Array(4 + headerBytes.length + chunkData.byteLength);
          const view = new DataView(payload.buffer);
          view.setUint32(0, headerBytes.length, false);

          payload.set(headerBytes, 4);
          payload.set(chunkData, 4 + headerBytes.length);

          await sendChunkWithBackpressure(this.dc, payload.buffer);

          this.bytesTransferred += chunkData.byteLength;
          this.reportProgress(i, file.name, end, file.size, 'sending');
        }

        // Send FILE_END and wait for FILE_ACK from receiver
        const fileEndMsg: FileEndMessage = {
          type: 'FILE_END',
          transferId: this.transferId,
          fileId: file.id,
        };
        this.dc.send(JSON.stringify(fileEndMsg));

        await this.waitForAck(file.id);
      }

      // Step 4: Transfer End
      const endMsg: TransferEndMessage = {
        type: 'TRANSFER_END',
        transferId: this.transferId,
      };
      this.dc.send(JSON.stringify(endMsg));

      if (this.onComplete) {
        this.onComplete();
      }
    } catch (err: any) {
      if (this.onError) {
        this.onError(err?.message || 'Transfer failed');
      }
    }
  }

  private waitForAck(fileId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for FILE_ACK on file ${fileId}`));
      }, DEFAULT_ACK_TIMEOUT_MS);

      const onMessage = (event: any) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'FILE_ACK' && msg.fileId === fileId) {
              cleanup();
              resolve();
            } else if (msg.type === 'ERROR') {
              cleanup();
              reject(new Error(`Receiver error: ${msg.message || msg.code}`));
            }
          } catch {}
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        if (this.dc.removeEventListener) {
          this.dc.removeEventListener('message', onMessage);
        }
      };

      if (this.dc.addEventListener) {
        this.dc.addEventListener('message', onMessage);
      } else {
        this.dc.onmessage = onMessage;
      }
    });
  }

  private reportProgress(
    fileIndex: number,
    fileName: string,
    fileBytes: number,
    fileTotal: number,
    status: TransferProgress['status']
  ): void {
    if (!this.onProgress) return;
    const elapsedSec = (Date.now() - this.startTime) / 1000;
    const speedBps = elapsedSec > 0 ? this.bytesTransferred / elapsedSec : 0;
    const percent = this.totalBytes > 0 ? Math.round((this.bytesTransferred / this.totalBytes) * 100) : 0;

    this.onProgress({
      fileIndex,
      fileName,
      fileBytesTransferred: fileBytes,
      fileTotalBytes: fileTotal,
      totalBytesTransferred: this.bytesTransferred,
      totalBytes: this.totalBytes,
      percent,
      speedBps,
      status,
    });
  }
}

/**
 * Native Mobile File Receiver
 */
export class MobileFileReceiver {
  private dc: any;
  private manifest: TransferManifest | null = null;
  private activeTransferId: string | null = null;
  private currentTargetUri: string | null = null;
  private currentHasher: MobileIncrementalSha256 | null = null;
  private currentBytesWritten = 0;
  private currentFileEntry: ManifestFileEntry | null = null;
  private receivedFiles: Array<{ name: string; uri: string; size: number }> = [];
  private bytesTransferred = 0;
  private startTime = 0;
  private cancelled = false;
  private messageQueue: Promise<void> = Promise.resolve();

  public onProgress: ((progress: TransferProgress) => void) | null = null;
  public onComplete: ((files: Array<{ name: string; uri: string; size: number }>) => void) | null = null;
  public onError: ((err: string) => void) | null = null;

  constructor(dc: any) {
    this.dc = dc;
    this.attachListeners();
  }

  cancel(): void {
    this.cancelled = true;
    try {
      if (this.dc && this.dc.readyState === 'open') {
        const cancelMsg: TransferCancelMessage = {
          type: 'CANCEL',
          transferId: this.activeTransferId || '',
          reason: 'Cancelled by user on mobile',
        };
        this.dc.send(JSON.stringify(cancelMsg));
      }
    } catch {}
  }

  private attachListeners(): void {
    const onMessage = (event: any) => {
      if (this.cancelled) return;

      // Promise-chain queue: each message runs strictly one at a time, in arrival order
      this.messageQueue = this.messageQueue
        .then(async () => {
          if (this.cancelled) return;

          if (typeof event.data === 'string') {
            let msg: any;
            try {
              msg = JSON.parse(event.data);
            } catch (err: any) {
              console.warn('[TRANSFER][RECEIVE] Malformed JSON control message', err);
              this.sendError('CONTROL_ERROR', 'Malformed control message received');
              return;
            }

            try {
              await this.handleControlMessage(msg);
            } catch (err: any) {
              const errMsg = err?.message || 'Error processing control message';
              console.error('[TRANSFER][RECEIVE] Control message processing error:', errMsg);
              this.sendError('CONTROL_ERROR', errMsg);
            }
          } else {
            // Binary Chunk
            try {
              await this.handleBinaryChunk(event.data);
            } catch (err: any) {
              const errMsg = err?.message || 'Error processing chunk';
              console.error('[TRANSFER][RECEIVE] Binary chunk processing error:', errMsg);
              this.sendError('CHUNK_ERROR', errMsg);
            }
          }
        })
        .catch((err: any) => {
          // Catch any unexpected queue errors so the chain never breaks
          console.error('[TRANSFER][RECEIVE] Message queue unexpected failure:', err);
        });
    };

    if (this.dc.addEventListener) {
      this.dc.addEventListener('message', onMessage);
    } else {
      this.dc.onmessage = onMessage;
    }
  }

  private async handleControlMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'TRANSFER_START': {
        this.manifest = msg.manifest;
        this.activeTransferId = msg.transferId;
        this.startTime = Date.now();
        this.bytesTransferred = 0;
        this.receivedFiles = [];
        break;
      }

      case 'FILE_START': {
        this.currentFileEntry = this.manifest?.files.find((f) => f.id === msg.fileId) || null;
        if (!this.currentFileEntry) return;

        const safeFilename = this.currentFileEntry.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        this.currentTargetUri = `${FileSystem.documentDirectory}${Date.now()}_${safeFilename}`;
        this.currentHasher = new MobileIncrementalSha256();
        this.currentBytesWritten = 0;

        // Initialize empty file on disk
        await FileSystem.writeAsStringAsync(this.currentTargetUri, '', {
          encoding: FileSystem.EncodingType.Base64,
        });
        break;
      }

      case 'FILE_END': {
        if (!this.currentFileEntry || !this.currentTargetUri || !this.currentHasher) return;

        // Verify bytes written matches manifest expected size
        const expectedSize = this.currentFileEntry.size;
        if (this.currentBytesWritten !== expectedSize) {
          const errMsg = `Size mismatch on file ${this.currentFileEntry.name}: received ${this.currentBytesWritten} bytes, expected ${expectedSize}`;
          console.error(`[TRANSFER][RECEIVE] ${errMsg}`);
          try {
            this.dc.send(JSON.stringify({
              type: 'FILE_ACK',
              transferId: this.activeTransferId || '',
              fileId: msg.fileId,
              sha256Match: false,
              error: errMsg,
            }));
          } catch {}
          throw new Error(errMsg);
        }

        // Verify on-disk size matches manifest expected size
        const fileInfo = await FileSystem.getInfoAsync(this.currentTargetUri);
        const onDiskSize = fileInfo.exists ? (fileInfo as any).size : -1;
        if (onDiskSize !== expectedSize) {
          const errMsg = `On-disk size mismatch on file ${this.currentFileEntry.name}: disk size is ${onDiskSize}, expected ${expectedSize}`;
          console.error(`[TRANSFER][RECEIVE] ${errMsg}`);
          try {
            this.dc.send(JSON.stringify({
              type: 'FILE_ACK',
              transferId: this.activeTransferId || '',
              fileId: msg.fileId,
              sha256Match: false,
              error: errMsg,
            }));
          } catch {}
          throw new Error(errMsg);
        }

        // Verify SHA-256 computed on the fly across all streamed chunks
        const calculatedSha = this.currentHasher.digest().toLowerCase();
        const expectedSha = this.currentFileEntry.sha256.toLowerCase();

        // Diagnostic re-read from disk
        let diskSha = 'unknown';
        try {
          diskSha = await calculateNativeFileSha256(this.currentTargetUri, onDiskSize);
        } catch (e: any) {
          diskSha = `error: ${e?.message}`;
        }

        console.log(
          `[TRANSFER][DIAGNOSTIC][FILE_END] file: ${this.currentFileEntry.name}\n` +
          `  calculatedSha:   ${calculatedSha}\n` +
          `  manifestSha:     ${expectedSha}\n` +
          `  diskSha:         ${diskSha}\n` +
          `  bytesHashed:     ${this.currentBytesWritten}\n` +
          `  onDiskSize:      ${onDiskSize}\n` +
          `  expectedSize:    ${expectedSize}`
        );

        if (calculatedSha !== expectedSha) {
          const errMsg = `Checksum mismatch on file ${this.currentFileEntry.name}: computed ${calculatedSha} != expected ${expectedSha}`;
          console.error(`[TRANSFER][RECEIVE] ${errMsg}`);
          try {
            this.dc.send(JSON.stringify({
              type: 'FILE_ACK',
              transferId: this.activeTransferId || '',
              fileId: msg.fileId,
              sha256Match: false,
              error: errMsg,
            }));
          } catch {}
          throw new Error(errMsg);
        }

        this.receivedFiles.push({
          name: this.currentFileEntry.name,
          uri: this.currentTargetUri,
          size: this.currentBytesWritten,
        });

        // Send FILE_ACK back to sender with sha256Match: true
        const ackMsg: FileAckMessage = {
          type: 'FILE_ACK',
          transferId: this.activeTransferId || '',
          fileId: msg.fileId,
          sha256Match: true,
        };
        this.dc.send(JSON.stringify(ackMsg));
        break;
      }

      case 'TRANSFER_END': {
        if (this.onComplete) {
          this.onComplete(this.receivedFiles);
        }
        break;
      }

      case 'CANCEL': {
        this.cancelled = true;
        if (this.onError) {
          this.onError(msg.reason || 'Transfer cancelled by sender');
        }
        break;
      }
    }
  }

  private async handleBinaryChunk(buffer: ArrayBuffer): Promise<void> {
    if (buffer.byteLength < 4) return;
    const view = new DataView(buffer);
    const headerLen = view.getUint32(0, false);

    const headerBytes = new Uint8Array(buffer, 4, headerLen);
    const headerStr = new TextDecoder().decode(headerBytes);
    const header = JSON.parse(headerStr) as ChunkHeader;

    const chunkData = new Uint8Array(buffer, 4 + headerLen);

    const first8Hex = Array.from(chunkData.slice(0, 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    console.log(
      `[TRANSFER][DIAGNOSTIC][CHUNK] index: ${header.index}, totalChunks: ${header.totalChunks}, payload length: ${chunkData.byteLength}, first 8 bytes: ${first8Hex}`
    );

    if (this.currentTargetUri && this.currentHasher) {
      // 1. Update streaming SHA-256 and byte counters in arrival order before awaited disk write
      this.currentHasher.update(chunkData);
      this.currentBytesWritten += chunkData.byteLength;

      // 2. Append binary chunk directly to disk
      const base64Chunk = uint8ArrayToBase64(chunkData);
      await FileSystem.writeAsStringAsync(this.currentTargetUri, base64Chunk, {
        encoding: FileSystem.EncodingType.Base64,
        append: true,
      });
    }

    this.bytesTransferred += chunkData.byteLength;

    if (this.onProgress && this.manifest && this.currentFileEntry) {
      const elapsedSec = (Date.now() - this.startTime) / 1000;
      const speedBps = elapsedSec > 0 ? this.bytesTransferred / elapsedSec : 0;
      const percent =
        this.manifest.totalSize > 0
          ? Math.round((this.bytesTransferred / this.manifest.totalSize) * 100)
          : 0;

      this.onProgress({
        fileIndex: 0,
        fileName: this.currentFileEntry.name,
        fileBytesTransferred: this.bytesTransferred,
        fileTotalBytes: this.currentFileEntry.size,
        totalBytesTransferred: this.bytesTransferred,
        totalBytes: this.manifest.totalSize,
        percent,
        speedBps,
        status: 'receiving',
      });
    }
  }

  private sendError(code: string, message: string): void {
    this.cancelled = true;
    try {
      const errorMsg: TransferErrorMessage = {
        type: 'ERROR',
        code,
        message,
        transferId: this.activeTransferId || undefined,
      };
      this.dc.send(JSON.stringify(errorMsg));
    } catch {}
    if (this.onError) {
      this.onError(message);
    }
  }
}
