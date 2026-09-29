import { describe, expect, it } from 'vitest';
import { MemoryTransferStorage } from './storage/memory';
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
      await new Promise((r) => setTimeout(r, 10));
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

  describe('Phase 2B - Resumable Transfer & Interruption Recovery', () => {
    it('handles interruption and resume of a partially completed file', async () => {
      // Create a 200 KB file (4 chunks of 64KB)
      const data = new Uint8Array(200 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
      const file = new File([data], 'resume-single.bin');

      const [senderDc1, receiverDc1] = createConnectedPair();
      const sender = new FileSender(senderDc1 as unknown as RTCDataChannel, [file], {
        transferId: 'tx-resume-1',
        ackTimeoutMs: 500,
        resumeTimeoutMs: 1000,
      });
      const receiver = new FileReceiver(receiverDc1 as unknown as RTCDataChannel, {
        expectedTransferId: 'tx-resume-1',
        stallTimeoutMs: 1000,
      });

      let chunksSent = 0;
      // Drop connection after 2 chunks
      const origSend = senderDc1.send.bind(senderDc1);
      senderDc1.send = (d: string | ArrayBuffer) => {
        origSend(d);
        if (typeof d !== 'string') {
          chunksSent++;
          if (chunksSent === 2) {
            // Close connection mid-transfer
            senderDc1.close();
            receiverDc1.close();
          }
        }
      };

      receiver.start();
      try {
        await sender.start();
      } catch {
        // Interrupted
      }

      // Reconnect with new DataChannels
      const [senderDc2, receiverDc2] = createConnectedPair();
      receiver.resume(receiverDc2 as unknown as RTCDataChannel);

      const completePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = async (files) => {
          try {
            expect(files.length).toBe(1);
            expect(files[0].verified).toBe(true);
            const receivedBuffer = await files[0].blob.arrayBuffer();
            expect(receivedBuffer.byteLength).toBe(200 * 1024);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (e) => reject(new Error(e));
      });

      await sender.resume(senderDc2 as unknown as RTCDataChannel);
      await completePromise;
    });

    it('multi-file resume: skips completed files and resumes partially transferred files', async () => {
      // File 1: small file (1 chunk), File 2: 200 KB (4 chunks), File 3: small file (1 chunk)
      const file1 = new File(['Completed File 1 Content'], 'file1.txt');
      const data2 = new Uint8Array(200 * 1024);
      for (let i = 0; i < data2.length; i++) data2[i] = i % 256;
      const file2 = new File([data2], 'file2.bin');
      const file3 = new File(['Remaining File 3 Content'], 'file3.txt');

      const [senderDc1, receiverDc1] = createConnectedPair();
      const sender = new FileSender(senderDc1 as unknown as RTCDataChannel, [file1, file2, file3], {
        transferId: 'tx-multi-resume',
        ackTimeoutMs: 500,
        resumeTimeoutMs: 1000,
      });
      const receiver = new FileReceiver(receiverDc1 as unknown as RTCDataChannel, {
        expectedTransferId: 'tx-multi-resume',
        stallTimeoutMs: 1000,
      });

      // Interrupt during file 2 after 1 chunk of file 2
      let file2ChunksSent = 0;
      const origSend = senderDc1.send.bind(senderDc1);
      senderDc1.send = (d: string | ArrayBuffer) => {
        origSend(d);
        if (typeof d === 'string' && d.includes('FILE_START') && d.includes('file2.bin')) {
          // File 2 started
        } else if (typeof d !== 'string' && receiver.getAssembledFiles().length === 1) {
          // Chunk of file 2
          file2ChunksSent++;
          if (file2ChunksSent === 1) {
            senderDc1.close();
            receiverDc1.close();
          }
        }
      };

      receiver.start();
      try {
        await sender.start();
      } catch {
        // Interrupted
      }

      expect(receiver.getAssembledFiles().length).toBe(1);
      expect(receiver.getAssembledFiles()[0].name).toBe('file1.txt');

      // Reconnect and resume
      const [senderDc2, receiverDc2] = createConnectedPair();
      receiver.resume(receiverDc2 as unknown as RTCDataChannel);

      const completePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = async (files) => {
          try {
            expect(files.length).toBe(3);
            expect(files[0].name).toBe('file1.txt');
            expect(files[1].name).toBe('file2.bin');
            expect(files[2].name).toBe('file3.txt');
            expect(files.every((f) => f.verified)).toBe(true);
            expect(await files[0].blob.text()).toBe('Completed File 1 Content');
            expect(await files[2].blob.text()).toBe('Remaining File 3 Content');
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (e) => reject(new Error(e));
      });

      await sender.resume(senderDc2 as unknown as RTCDataChannel);
      await completePromise;
    });

    it('rejects resume when transfer ID mismatches (Fail Closed)', async () => {
      const [senderDc1] = createConnectedPair();
      const file = new File(['Content'], 'test.txt');
      const sender = new FileSender(senderDc1 as unknown as RTCDataChannel, [file], {
        transferId: 'tx-legit',
        resumeTimeoutMs: 200,
      });

      // Start sender to compute manifest
      const [sDc1, rDc1] = createConnectedPair();
      const dummyReceiver = new FileReceiver(rDc1 as unknown as RTCDataChannel);
      dummyReceiver.start();
      sender.attachDataChannel(sDc1 as unknown as RTCDataChannel);
      // calculate hashes
      await sender.start();

      // Attempt resume against receiver expecting different transfer ID
      const [senderDc2, receiverDc2] = createConnectedPair();
      const receiverWithDiffId = new FileReceiver(receiverDc2 as unknown as RTCDataChannel, {
        expectedTransferId: 'tx-other-id',
      });
      receiverWithDiffId.start();

      let senderError = '';
      sender.onError = (e) => {
        senderError = e;
      };

      await sender.resume(senderDc2 as unknown as RTCDataChannel);
      expect(senderError).toContain('Resume rejected');
    });

    it('times out when resume response is never received', async () => {
      const file = new File(['Content'], 'test.txt');
      const [senderDc, receiverDc] = createConnectedPair();
      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file], {
        transferId: 'tx-timeout',
        resumeTimeoutMs: 100,
      });

      // Initialize manifest
      const dummyRec = new FileReceiver(receiverDc as unknown as RTCDataChannel);
      dummyRec.start();
      await sender.start();

      // Resume on silent channel that drops RESUME_REQUEST
      const [sDcSilent, rDcSilent] = createConnectedPair();
      rDcSilent.send = () => {}; // do not respond

      let senderError = '';
      sender.onError = (e) => {
        senderError = e;
      };

      await sender.resume(sDcSilent as unknown as RTCDataChannel);
      expect(senderError).toContain('Timeout waiting for RESUME_RESPONSE');
    });

    it('handles duplicate chunks during retransmission without errors', async () => {
      const data = new Uint8Array(150 * 1024); // 3 chunks
      const file = new File([data], 'dup-resume.bin');

      const [senderDc1, receiverDc1] = createConnectedPair();
      const sender = new FileSender(senderDc1 as unknown as RTCDataChannel, [file], {
        transferId: 'tx-dup-resume',
        ackTimeoutMs: 500,
        resumeTimeoutMs: 1000,
      });
      const receiver = new FileReceiver(receiverDc1 as unknown as RTCDataChannel, {
        expectedTransferId: 'tx-dup-resume',
        stallTimeoutMs: 1000,
      });

      let chunksSent = 0;
      const origSend1 = senderDc1.send.bind(senderDc1);
      senderDc1.send = (d: string | ArrayBuffer) => {
        origSend1(d);
        if (typeof d !== 'string') {
          chunksSent++;
          if (chunksSent === 1) {
            senderDc1.close();
            receiverDc1.close();
          }
        }
      };

      receiver.start();
      try {
        await sender.start();
      } catch {
        // expected interruption
      }

      // Intercept and duplicate retransmitted chunks on channel 2
      const [senderDc2, receiverDc2] = createConnectedPair();
      const origSend2 = senderDc2.send.bind(senderDc2);
      senderDc2.send = (d: string | ArrayBuffer) => {
        origSend2(d);
        if (typeof d !== 'string') {
          // Send duplicate chunk
          origSend2(d);
        }
      };

      const completePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = async (files) => {
          try {
            expect(files.length).toBe(1);
            expect(files[0].verified).toBe(true);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (e) => reject(new Error(e));
      });

      receiver.resume(receiverDc2 as unknown as RTCDataChannel);
      await sender.resume(senderDc2 as unknown as RTCDataChannel);
      await completePromise;
    });

    it('fails integrity check if corrupted data is received during resume', async () => {
      const file = new File(['Corrupted Resume Test Content with sufficient length for testing'], 'corrupt-resume.txt');
      const [senderDc1, receiverDc1] = createConnectedPair();
      const sender = new FileSender(senderDc1 as unknown as RTCDataChannel, [file], {
        transferId: 'tx-corrupt-resume',
        ackTimeoutMs: 500,
        resumeTimeoutMs: 1000,
      });
      const receiver = new FileReceiver(receiverDc1 as unknown as RTCDataChannel, {
        expectedTransferId: 'tx-corrupt-resume',
        stallTimeoutMs: 1000,
      });

      // Interrupt immediately on channel 1
      senderDc1.send = () => {
        senderDc1.close();
        receiverDc1.close();
      };

      receiver.start();
      try {
        await sender.start();
      } catch {
        // expected interruption
      }

      // Reconnect and corrupt binary chunks during resume
      const [senderDc2, receiverDc2] = createConnectedPair();
      receiver.resume(receiverDc2 as unknown as RTCDataChannel);

      const origSend = senderDc2.send.bind(senderDc2);
      senderDc2.send = (d: string | ArrayBuffer) => {
        if (typeof d !== 'string') {
          const u8 = new Uint8Array(d);
          u8[u8.length - 1] ^= 0xff; // corrupt byte
          origSend(u8.buffer);
        } else {
          origSend(d);
        }
      };

      let receiverErr = '';
      receiver.onError = (e) => {
        receiverErr = e;
      };

      let senderErr = '';
      sender.onError = (e) => {
        senderErr = e;
      };

      await sender.resume(senderDc2 as unknown as RTCDataChannel);

      expect(receiverErr).toContain('SHA-256 mismatch');
      expect(senderErr).toContain('SHA-256 mismatch');
    });

    it('handles storage write failure gracefully and enters failed state', async () => {
      const file = new File(['Storage Failure Test Content'], 'storage-fail.txt');
      const [senderDc, receiverDc] = createConnectedPair();

      const mockStorage = new MemoryTransferStorage();
      mockStorage.writeChunk = async () => {
        throw new Error('Disk quota exceeded (QuotaExceededError)');
      };

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file], {
        transferId: 'tx-storage-fail',
        ackTimeoutMs: 500,
      });
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel, {
        expectedTransferId: 'tx-storage-fail',
        storage: mockStorage,
      });

      let receiverErr = '';
      receiver.onError = (e) => {
        receiverErr = e;
      };

      let senderErr = '';
      sender.onError = (e) => {
        senderErr = e;
      };

      receiver.start();
      try {
        await sender.start();
      } catch {
        // expected failure
      }

      expect(receiverErr).toContain('Disk quota exceeded');
      expect(senderErr).toContain('Disk quota exceeded');
      expect(receiver.getAssembledFiles().length).toBe(0);
    });

    it('serializes async storage writes before FILE_END to prevent missing chunk race condition', async () => {
      // 5 chunks
      const data = new Uint8Array(5 * 65536);
      for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
      const file = new File([data], 'async-race.bin');

      const [senderDc, receiverDc] = createConnectedPair();

      const baseStorage = new MemoryTransferStorage();
      await baseStorage.init();

      // Wrap writeChunk with an async delay simulating real disk/IndexedDB transaction latency
      const originalWriteChunk = baseStorage.writeChunk.bind(baseStorage);
      baseStorage.writeChunk = async (transferId, fileId, index, chunkData) => {
        await new Promise((r) => setTimeout(r, 10));
        return originalWriteChunk(transferId, fileId, index, chunkData);
      };

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file], {
        transferId: 'tx-async-race',
        ackTimeoutMs: 2000,
      });
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel, {
        expectedTransferId: 'tx-async-race',
        storage: baseStorage,
      });

      const completePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = (files) => {
          try {
            expect(files.length).toBe(1);
            expect(files[0].verified).toBe(true);
            expect(files[0].size).toBe(5 * 65536);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (e) => reject(new Error(e));
      });

      receiver.start();
      await sender.start();
      await completePromise;
    });

    it('receiver does not time out while waiting for slow sender manifest calculation (manifestTimeout)', async () => {
      const file = new File(['Manifest wait content'], 'manifest-wait.txt');
      const [senderDc, receiverDc] = createConnectedPair();

      // Receiver configured with short data stall timeout (100ms) but longer manifest timeout (400ms)
      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel, {
        stallTimeoutMs: 100,
        manifestTimeoutMs: 400,
      });

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file], {
        ackTimeoutMs: 500,
      });

      let receiverError = '';
      receiver.onError = (e) => {
        receiverError = e;
      };

      receiver.start();
      expect(receiver.getState()).toBe('waiting_for_manifest');

      // Wait 150ms (longer than 100ms stallTimeoutMs, but less than 400ms manifestTimeoutMs)
      await new Promise((r) => setTimeout(r, 150));
      expect(receiverError).toBe('');
      expect(receiver.getState()).toBe('waiting_for_manifest');

      // Now start sender
      const completePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = (files) => {
          try {
            expect(files.length).toBe(1);
            expect(files[0].verified).toBe(true);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (e) => reject(new Error(e));
      });

      await sender.start();
      await completePromise;
      expect(receiver.getState()).toBe('completed');
    });

    it('receiver does not time out during slow/delayed verification and finalization', async () => {
      const file = new File(['Slow verification file'], 'slow-verify.txt');
      const [senderDc, receiverDc] = createConnectedPair();

      const customStorage = new MemoryTransferStorage();
      await customStorage.init();

      // Wrap verifyAndFinalizeFile with a simulated delay exceeding receiver stallTimeoutMs
      const origVerify = customStorage.verifyAndFinalizeFile.bind(customStorage);
      customStorage.verifyAndFinalizeFile = async (transferId, fileId, expectedSha256, onProgress) => {
        // Wait 200ms during verification (longer than 100ms stallTimeoutMs)
        await new Promise((r) => setTimeout(r, 200));
        return origVerify(transferId, fileId, expectedSha256, onProgress);
      };

      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel, {
        stallTimeoutMs: 100,
        storage: customStorage,
      });

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file], {
        ackTimeoutMs: 1000,
      });

      const completePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = (files) => {
          try {
            expect(files.length).toBe(1);
            expect(files[0].verified).toBe(true);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (e) => reject(new Error(e));
      });

      receiver.start();
      await sender.start();
      await completePromise;
      expect(receiver.getState()).toBe('completed');
    });

    it('receiver times out when sender genuinely stalls and disconnects during file reception', async () => {
      // 5 chunks
      const data = new Uint8Array(5 * 65536);
      const file = new File([data], 'stall-test.bin');
      const [senderDc, receiverDc] = createConnectedPair();

      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel, {
        stallTimeoutMs: 150,
      });

      let receiverErr = '';
      const errorPromise = new Promise<void>((resolve) => {
        receiver.onError = (e) => {
          receiverErr = e;
          resolve();
        };
      });

      // Override sender dc to send TRANSFER_START, FILE_START, and only 2 chunks, then stop/stall completely
      let chunkCount = 0;
      const origSend = senderDc.send.bind(senderDc);
      senderDc.send = (d: string | ArrayBuffer) => {
        if (typeof d !== 'string') {
          chunkCount++;
          if (chunkCount <= 2) {
            origSend(d);
          }
          // stall subsequent chunks and don't send anything else
        } else {
          try {
            const parsed = JSON.parse(d);
            if (parsed.type === 'TRANSFER_START' || parsed.type === 'FILE_START') {
              origSend(d);
            }
            // drop FILE_END / TRANSFER_END to simulate network stall during transmission
          } catch {
            origSend(d);
          }
        }
      };

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file], {
        ackTimeoutMs: 2000,
      });

      receiver.start();
      sender.start().catch(() => {});

      await errorPromise;
      expect(receiverErr).toContain('Transfer timed out due to inactivity');
      expect(receiver.getState()).toBe('failed');
    });

    it('successfully handles multi-file transfer with state transitions across each file', async () => {
      const file1 = new File(['File 1 contents'], 'f1.txt');
      const file2 = new File(['File 2 contents with more text'], 'f2.txt');
      const [senderDc, receiverDc] = createConnectedPair();

      const receiver = new FileReceiver(receiverDc as unknown as RTCDataChannel, {
        stallTimeoutMs: 500,
      });
      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file1, file2], {
        ackTimeoutMs: 1000,
      });

      const completePromise = new Promise<void>((resolve, reject) => {
        receiver.onComplete = (files) => {
          try {
            expect(files.length).toBe(2);
            expect(files[0].verified).toBe(true);
            expect(files[1].verified).toBe(true);
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        receiver.onError = (e) => reject(new Error(e));
      });

      receiver.start();
      await sender.start();
      await completePromise;
      expect(receiver.getState()).toBe('completed');
    });

    it('resets sender ACK timer upon receiving VERIFYING keepalive messages', async () => {
      const file = new File(['Keepalive test file'], 'keepalive.txt');
      const [senderDc, receiverDc] = createConnectedPair();

      // Sender has a 300ms ack timeout
      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file], {
        ackTimeoutMs: 300,
      });

      // Custom mock receiver to intercept FILE_END and send keepalives
      let fileId = '';
      let transferId = '';
      let receivedChunks = 0;

      receiverDc.addEventListener('message', async (e: unknown) => {
        const event = e as { data: string | ArrayBuffer };
        if (typeof event.data === 'string') {
          const msg = JSON.parse(event.data);
          if (msg.type === 'TRANSFER_START') {
            transferId = msg.manifest.transferId;
            fileId = msg.manifest.files[0].id;
          } else if (msg.type === 'FILE_END') {
            // Send 3 keepalives at 150ms intervals (total 450ms > 300ms ackTimeout)
            for (let k = 0; k < 3; k++) {
              await new Promise((r) => setTimeout(r, 150));
              receiverDc.send(
                JSON.stringify({
                  type: 'VERIFYING',
                  transferId,
                  fileId,
                  progress: (k + 1) * 10,
                })
              );
            }

            // Finally send FILE_ACK
            await new Promise((r) => setTimeout(r, 100));
            receiverDc.send(
              JSON.stringify({
                type: 'FILE_ACK',
                transferId,
                fileId,
                sha256Match: true,
              })
            );
          }
        } else {
          receivedChunks++;
        }
      });

      await expect(sender.start()).resolves.toBeUndefined();
    });

    it('ignores VERIFYING keepalive messages with mismatched transferId or fileId and times out', async () => {
      const file = new File(['Keepalive mismatch test file'], 'mismatch.txt');
      const [senderDc, receiverDc] = createConnectedPair();

      const sender = new FileSender(senderDc as unknown as RTCDataChannel, [file], {
        ackTimeoutMs: 250,
      });

      let senderError = '';
      sender.onError = (err) => {
        senderError = err;
      };

      receiverDc.addEventListener('message', async (e: unknown) => {
        const event = e as { data: string | ArrayBuffer };
        if (typeof event.data === 'string') {
          const msg = JSON.parse(event.data);
          if (msg.type === 'FILE_END') {
            // Send keepalives with wrong fileId
            for (let k = 0; k < 3; k++) {
              await new Promise((r) => setTimeout(r, 100));
              receiverDc.send(
                JSON.stringify({
                  type: 'VERIFYING',
                  transferId: 'wrong-tx-id',
                  fileId: 'wrong-file-id',
                })
              );
            }
          }
        }
      });

      await sender.start();
      expect(senderError).toContain('Timeout waiting for receiver ACK');
    });
  });
});
