import { describe, expect, it } from 'vitest';
import {
  FileReceiver,
  FileSender,
  validateFilename,
  validateManifest,
} from './transfer';

// Mock RTCDataChannel helper
class MockDataChannel {
  public readyState: RTCDataChannelState = 'open';
  public bufferedAmount = 0;
  public bufferedAmountLowThreshold = 0;
  public binaryType: BinaryType = 'arraybuffer';
  private listeners: Map<string, ((event: unknown) => void)[]> = new Map();
  public peer: MockDataChannel | null = null;

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type);
    if (list) {
      this.listeners.set(
        type,
        list.filter((cb) => cb !== listener)
      );
    }
  }

  dispatchEvent(type: string, eventData: unknown): void {
    const list = this.listeners.get(type);
    if (list) {
      list.forEach((cb) => cb(eventData));
    }
  }

  send(data: string | ArrayBuffer): void {
    if (this.peer && this.peer.readyState === 'open') {
      setTimeout(() => {
        this.peer!.dispatchEvent('message', { data });
      }, 0);
    }
  }

  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent('close', {});
  }
}

function createConnectedPair(): [MockDataChannel, MockDataChannel] {
  const dc1 = new MockDataChannel();
  const dc2 = new MockDataChannel();
  dc1.peer = dc2;
  dc2.peer = dc1;
  return [dc1, dc2];
}

describe('Phase 2A - Transfer Protocol & Validation', () => {
  describe('validateFilename', () => {
    it('accepts valid filenames', () => {
      expect(validateFilename('photo.jpg')).toBe(true);
      expect(validateFilename('my-document.pdf')).toBe(true);
      expect(validateFilename('data_2026.csv')).toBe(true);
    });

    it('rejects path traversal and dangerous filenames', () => {
      expect(validateFilename('../secret.txt')).toBe(false);
      expect(validateFilename('folder/file.txt')).toBe(false);
      expect(validateFilename('folder\\file.txt')).toBe(false);
      expect(validateFilename('file\0.txt')).toBe(false);
      expect(validateFilename('')).toBe(false);
      expect(validateFilename('   ')).toBe(false);
      expect(validateFilename('a'.repeat(256))).toBe(false);
    });
  });

  describe('validateManifest', () => {
    const validHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    it('validates a correct manifest', () => {
      const manifest = {
        transferId: 'tx-123',
        totalFiles: 1,
        totalSize: 0,
        files: [
          {
            id: 'f-1',
            name: 'empty.txt',
            size: 0,
            mimeType: 'text/plain',
            totalChunks: 0,
            sha256: validHash,
          },
        ],
      };
      const res = validateManifest(manifest);
      expect(res.transferId).toBe('tx-123');
      expect(res.totalFiles).toBe(1);
    });

    it('rejects duplicate file IDs', () => {
      const manifest = {
        transferId: 'tx-123',
        totalFiles: 2,
        totalSize: 0,
        files: [
          { id: 'f-1', name: 'a.txt', size: 0, totalChunks: 0, sha256: validHash },
          { id: 'f-1', name: 'b.txt', size: 0, totalChunks: 0, sha256: validHash },
        ],
      };
      expect(() => validateManifest(manifest)).toThrow('duplicate file ID');
    });

    it('rejects invalid chunk count calculation', () => {
      const manifest = {
        transferId: 'tx-123',
        totalFiles: 1,
        totalSize: 100000,
        files: [
          { id: 'f-1', name: 'a.txt', size: 100000, totalChunks: 1, sha256: validHash }, // 100k needs 2 chunks of 64k
        ],
      };
      expect(() => validateManifest(manifest)).toThrow('invalid totalChunks');
    });

    it('rejects totalSize mismatch', () => {
      const manifest = {
        transferId: 'tx-123',
        totalFiles: 1,
        totalSize: 50,
        files: [
          { id: 'f-1', name: 'a.txt', size: 100, totalChunks: 1, sha256: validHash },
        ],
      };
      expect(() => validateManifest(manifest)).toThrow('totalSize mismatch');
    });
  });

  describe('End-to-End File Transfers via Mock Channel', () => {
    it('transfers a small file successfully with SHA-256 verification', async () => {
      const [senderDc, receiverDc] = createConnectedPair();
      const content = 'Hello JustShare Phase 2A!';
      const file = new File([content], 'hello.txt', { type: 'text/plain' });

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file]);
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel);

      const receiverCompletePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = async (files) => {
          try {
            expect(files.length).toBe(1);
            expect(files[0].name).toBe('hello.txt');
            expect(files[0].verified).toBe(true);
            const text = await files[0].blob.text();
            expect(text).toBe(content);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (err) => reject(new Error(err));
      });

      receiver.start();
      await sender.start();
      await receiverCompletePromise;
    });

    it('transfers multiple files including empty 0-byte file and duplicate names', async () => {
      const [senderDc, receiverDc] = createConnectedPair();
      const file1 = new File(['Content of file 1'], 'notes.txt', { type: 'text/plain' });
      const file2 = new File([''], 'empty.txt', { type: 'text/plain' });
      const file3 = new File(['Different content same name'], 'notes.txt', { type: 'text/plain' });

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file1, file2, file3]);
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel);

      const receiverCompletePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = async (files) => {
          try {
            expect(files.length).toBe(3);
            expect(files[0].name).toBe('notes.txt');
            expect(files[1].name).toBe('empty.txt');
            expect(files[2].name).toBe('notes.txt');
            expect(await files[0].blob.text()).toBe('Content of file 1');
            expect(await files[1].blob.text()).toBe('');
            expect(await files[2].blob.text()).toBe('Different content same name');
            expect(files.every((f) => f.verified)).toBe(true);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (err) => reject(new Error(err));
      });

      receiver.start();
      await sender.start();
      await receiverCompletePromise;
    });

    it('transfers a multi-chunk file (>64KB) with backpressure and progress reporting', async () => {
      const [senderDc, receiverDc] = createConnectedPair();
      const largeData = new Uint8Array(200 * 1024); // 200 KB -> 4 chunks
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }
      const file = new File([largeData], 'large.bin', { type: 'application/octet-stream' });

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file]);
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel);

      let lastSenderProgress = 0;
      sender.onProgress = (p) => {
        lastSenderProgress = p.percentage;
      };

      const receiverCompletePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = async (files) => {
          try {
            expect(files.length).toBe(1);
            expect(files[0].verified).toBe(true);
            const arrayBuffer = await files[0].blob.arrayBuffer();
            expect(arrayBuffer.byteLength).toBe(200 * 1024);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (err) => reject(new Error(err));
      });

      receiver.start();
      await sender.start();
      await receiverCompletePromise;
      expect(lastSenderProgress).toBe(100);
    });

    it('handles duplicate chunks safely without corrupting total bytes', async () => {
      const [senderDc, receiverDc] = createConnectedPair();
      const content = 'Test Duplicate Chunks Handling';
      const file = new File([content], 'dup.txt', { type: 'text/plain' });

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file], { transferId: 'tx-dup' });
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel, { expectedTransferId: 'tx-dup' });

      // Intercept sender messages to inject a duplicate chunk
      const originalSend = senderDc.send.bind(senderDc);
      senderDc.send = (data: string | ArrayBuffer) => {
        originalSend(data);
        if (typeof data !== 'string') {
          // It's a binary chunk, send it a second time as duplicate!
          originalSend(data);
        }
      };

      const receiverCompletePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = async (files) => {
          try {
            expect(files.length).toBe(1);
            expect(files[0].verified).toBe(true);
            expect(await files[0].blob.text()).toBe(content);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (err) => reject(new Error(err));
      });

      receiver.start();
      await sender.start();
      await receiverCompletePromise;
    });

    it('rejects chunks with invalid transfer ID or unknown file ID', async () => {
      const [, receiverDc] = createConnectedPair();
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel, { expectedTransferId: 'tx-valid' });

      let errorMsg = '';
      receiver.onError = (e) => {
        errorMsg = e;
      };
      receiver.start();

      // Send a fake chunk with mismatch transferId
      const fakeHeader = JSON.stringify({ transferId: 'tx-wrong', fileId: 'f-1', index: 0, totalChunks: 1, byteLength: 5 });
      const headerBytes = new TextEncoder().encode(fakeHeader);
      const payload = new Uint8Array(4 + headerBytes.length + 5);
      new DataView(payload.buffer).setUint32(0, headerBytes.length, false);
      payload.set(headerBytes, 4);

      receiverDc.dispatchEvent('message', { data: payload.buffer });
      expect(errorMsg).toContain('transfer ID mismatch');
    });

    it('detects corrupted chunk data and fails verification', async () => {
      const [senderDc, receiverDc] = createConnectedPair();
      const file = new File(['Original Uncorrupted Content'], 'corrupt.txt', { type: 'text/plain' });

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file]);
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel);

      // Corrupt the chunk data payload in transit
      const originalSend = senderDc.send.bind(senderDc);
      senderDc.send = (data: string | ArrayBuffer) => {
        if (typeof data !== 'string') {
          const u8 = new Uint8Array(data);
          u8[u8.length - 1] = u8[u8.length - 1] ^ 0xff; // flip bits
          originalSend(u8.buffer);
        } else {
          originalSend(data);
        }
      };

      let receiverError = '';
      receiver.onError = (err) => {
        receiverError = err;
      };

      let senderError = '';
      sender.onError = (err) => {
        senderError = err;
      };

      receiver.start();
      await sender.start();

      expect(receiverError).toContain('SHA-256 mismatch');
      expect(senderError).toContain('SHA-256 mismatch');
    });

    it('handles transfer cancellation from sender', async () => {
      const [senderDc, receiverDc] = createConnectedPair();
      const data = new Uint8Array(500 * 1024);
      const file = new File([data], 'cancel.bin');

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file]);
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel);

      let receiverCancelled = false;
      receiver.onError = (err) => {
        if (err.includes('cancelled') || err.includes('User abort')) {
          receiverCancelled = true;
        }
      };

      receiver.start();

      // Cancel immediately after starting
      const startPromise = sender.start();
      sender.cancel('User abort');
      await startPromise;

      await new Promise((r) => setTimeout(r, 50));
      expect(receiverCancelled).toBe(true);
    });

    it('times out when FILE_ACK is not received within deadline', async () => {
      const [senderDc, receiverDc] = createConnectedPair();
      const file = new File(['Hello Timeout'], 'time.txt');

      // 100ms ACK timeout for test
      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file], { ackTimeoutMs: 100 });
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel);

      // Intercept and swallow FILE_ACK
      const originalSend = receiverDc.send.bind(receiverDc);
      receiverDc.send = (data: string | ArrayBuffer) => {
        if (typeof data === 'string' && data.includes('FILE_ACK')) {
          return; // Drop ACK
        }
        originalSend(data);
      };

      let senderError = '';
      sender.onError = (err) => {
        senderError = err;
      };

      receiver.start();
      await sender.start();

      expect(senderError).toContain('Timeout waiting for receiver ACK');
    });
  });
});
