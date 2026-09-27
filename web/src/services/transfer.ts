import { TransferProgress } from '../types';
import { sha256File, sha256Chunks } from './crypto';

const CHUNK_SIZE = 65536; // 64KB

async function sendChunkWithBackpressure(dc: RTCDataChannel, data: ArrayBuffer): Promise<void> {
  if (dc.bufferedAmount > 1048576) { // 1MB
    dc.bufferedAmountLowThreshold = 262144; // 256KB
    await new Promise<void>(resolve => {
      dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; resolve(); };
    });
  }
  dc.send(data);
}

export class FileSender {
  private dc: RTCDataChannel;
  private files: File[];
  private hashes: Map<string, string> = new Map();
  public onProgress: ((progress: TransferProgress) => void) | null = null;
  public onComplete: (() => void) | null = null;
  public onError: ((error: string) => void) | null = null;
  private cancelled = false;

  private totalBytes = 0;
  private bytesTransferred = 0;
  private startTime = 0;

  constructor(dc: RTCDataChannel, files: File[]) {
    this.dc = dc;
    this.files = files;
    for (const f of files) {
      this.totalBytes += f.size;
    }
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    
    // Calculate hashes
    for (let i = 0; i < this.files.length; i++) {
      if (this.cancelled) return;
      this.updateProgress(i, 'verifying');
      const hash = await sha256File(this.files[i]);
      this.hashes.set(i.toString(), hash);
    }

    if (this.cancelled) return;

    // Send TRANSFER_START
    this.dc.send(JSON.stringify({
      type: 'TRANSFER_START',
      totalFiles: this.files.length,
      totalSize: this.totalBytes
    }));

    for (let i = 0; i < this.files.length; i++) {
      if (this.cancelled) return;
      
      const file = this.files[i];
      const fileId = i.toString();
      const hash = this.hashes.get(fileId)!;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      this.updateProgress(i, 'sending');

      this.dc.send(JSON.stringify({
        type: 'FILE_START',
        fileId,
        name: file.name,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks,
        sha256: hash
      }));

      // Send chunks
      for (let j = 0; j < totalChunks; j++) {
        if (this.cancelled) return;

        const start = j * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(start, end);
        const chunkData = await chunkBlob.arrayBuffer();

        const headerStr = JSON.stringify({ fileId, index: j });
        const headerBytes = new TextEncoder().encode(headerStr);
        
        const payload = new Uint8Array(4 + headerBytes.length + chunkData.byteLength);
        
        // 4 bytes uint32 BE header length
        const view = new DataView(payload.buffer);
        view.setUint32(0, headerBytes.length, false); // false = big endian
        
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

      this.dc.send(JSON.stringify({ type: 'FILE_END', fileId }));

      // Wait for FILE_ACK
      await new Promise<void>((resolve, reject) => {
        const handler = (event: MessageEvent) => {
          if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);
            if (msg.type === 'FILE_ACK' && msg.fileId === fileId) {
              this.dc.removeEventListener('message', handler);
              if (!msg.sha256Match) {
                reject(new Error('SHA-256 mismatch on receiver'));
              } else {
                resolve();
              }
            } else if (msg.type === 'CANCEL') {
              this.dc.removeEventListener('message', handler);
              reject(new Error('Transfer cancelled by receiver: ' + msg.reason));
            }
          }
        };
        this.dc.addEventListener('message', handler);
      });
    }

    if (this.cancelled) return;
    this.dc.send(JSON.stringify({ type: 'TRANSFER_END' }));
    if (this.onComplete) this.onComplete();
  }

  cancel(reason: string): void {
    this.cancelled = true;
    if (this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify({ type: 'CANCEL', reason }));
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
      state
    });
  }
}

export class FileReceiver {
  private dc: RTCDataChannel;
  private files: Map<string, {name: string, size: number, sha256: string, chunks: Uint8Array[], received: number}> = new Map();
  public onProgress: ((progress: TransferProgress) => void) | null = null;
  public onComplete: ((files: {name: string, blob: Blob, verified: boolean}[]) => void) | null = null;
  public onError: ((error: string) => void) | null = null;
  private totalBytes = 0;
  private totalFiles = 0;
  private totalReceived = 0;
  private currentFileIndex = 0;
  private currentFileName = '';
  private cancelled = false;
  private startTime = 0;

  private assembledFiles: {name: string, blob: Blob, verified: boolean}[] = [];

  constructor(dc: RTCDataChannel) {
    this.dc = dc;
    this.dc.binaryType = 'arraybuffer';
  }

  start(): void {
    this.dc.addEventListener('message', async (event) => {
      if (this.cancelled) return;

      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        
        switch (msg.type) {
          case 'TRANSFER_START':
            this.totalFiles = msg.totalFiles;
            this.totalBytes = msg.totalSize;
            this.startTime = Date.now();
            this.updateProgress('receiving');
            break;
            
          case 'FILE_START':
            this.files.set(msg.fileId, {
              name: msg.name,
              size: msg.size,
              sha256: msg.sha256,
              chunks: new Array(msg.totalChunks),
              received: 0
            });
            this.currentFileName = msg.name;
            this.updateProgress('receiving');
            break;
            
          case 'FILE_END':
            await this.handleFileEnd(msg.fileId);
            break;
            
          case 'TRANSFER_END':
            if (this.onComplete) {
              this.onComplete(this.assembledFiles);
            }
            break;

          case 'CANCEL':
            this.cancelled = true;
            if (this.onError) this.onError(msg.reason);
            break;
        }
      } else {
        // ArrayBuffer
        const buffer = event.data as ArrayBuffer;
        const view = new DataView(buffer);
        const headerLen = view.getUint32(0, false);
        
        const headerBytes = new Uint8Array(buffer, 4, headerLen);
        const headerStr = new TextDecoder().decode(headerBytes);
        const header = JSON.parse(headerStr);
        
        const chunkData = new Uint8Array(buffer, 4 + headerLen);
        
        const fileInfo = this.files.get(header.fileId);
        if (fileInfo) {
          fileInfo.chunks[header.index] = chunkData;
          fileInfo.received += chunkData.byteLength;
          this.totalReceived += chunkData.byteLength;
          
          if (header.index % 10 === 0 || fileInfo.received >= fileInfo.size) {
            this.updateProgress('receiving');
          }
        }
      }
    });
  }

  private async handleFileEnd(fileId: string) {
    const fileInfo = this.files.get(fileId);
    if (!fileInfo) return;

    this.updateProgress('verifying');
    
    // Assemble chunks
    const hash = await sha256Chunks(fileInfo.chunks);
    const verified = hash === fileInfo.sha256;
    
    this.dc.send(JSON.stringify({
      type: 'FILE_ACK',
      fileId,
      sha256Match: verified
    }));

    const blob = new Blob(fileInfo.chunks as unknown as BlobPart[]);
    this.assembledFiles.push({
      name: fileInfo.name,
      blob,
      verified
    });
    
    // Free up memory
    this.files.delete(fileId);
    this.currentFileIndex++;
  }

  cancel(reason: string): void {
    this.cancelled = true;
    if (this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify({ type: 'CANCEL', reason }));
    }
  }

  private updateProgress(state: TransferProgress['state']) {
    if (!this.onProgress) return;
    
    const percentage = this.totalBytes === 0 ? 100 : (this.totalReceived / this.totalBytes) * 100;
    
    const elapsed = (Date.now() - this.startTime) / 1000;
    const speed = elapsed > 0 ? this.totalReceived / elapsed : 0;
    const eta = speed > 0 ? (this.totalBytes - this.totalReceived) / speed : 0;

    this.onProgress({
      currentFile: this.currentFileName,
      currentFileIndex: this.currentFileIndex,
      totalFiles: this.totalFiles,
      bytesTransferred: this.totalReceived,
      totalBytes: this.totalBytes,
      percentage,
      speed,
      eta,
      state
    });
  }
}
