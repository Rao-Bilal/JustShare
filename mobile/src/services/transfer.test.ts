// @ts-nocheck
const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const ts = require('typescript');

// Recreate Mock FileSystem to simulate slow async writes and disk state
class MockFileSystem {
  constructor() {
    this.files = new Map();
    this.documentDirectory = 'file:///mock_docs/';
    this.EncodingType = { Base64: 'base64' };
    this.writeDelayMs = 0;
  }

  writeAsStringAsync = async (uri, content, options) => {
    if (this.writeDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.writeDelayMs));
    }
    const existing = this.files.get(uri);
    if (options?.append && existing) {
      // Decode base64 to measure raw byte size
      const prevBuf = Buffer.from(existing.content, 'base64');
      const newBuf = Buffer.from(content, 'base64');
      const combined = Buffer.concat([prevBuf, newBuf]);
      this.files.set(uri, { content: combined.toString('base64'), size: combined.length });
    } else {
      const buf = Buffer.from(content, 'base64');
      this.files.set(uri, { content, size: buf.length });
    }
  };

  getInfoAsync = async (uri) => {
    const f = this.files.get(uri);
    if (!f) return { exists: false, size: 0 };
    return { exists: true, size: f.size };
  };

  readAsStringAsync = async (uri, options) => {
    const f = this.files.get(uri);
    if (!f) throw new Error('File not found: ' + uri);
    const rawBuf = Buffer.from(f.content, 'base64');
    const pos = options?.position || 0;
    const len = options?.length !== undefined ? options.length : rawBuf.length - pos;
    const slice = rawBuf.subarray(pos, pos + len);
    return slice.toString('base64');
  };
}

// Mock DataChannel
class MockDataChannel {
  constructor() {
    this.readyState = 'open';
    this.sentMessages = [];
    this.listeners = new Map();
  }

  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
  }

  removeEventListener(type, cb) {
    const arr = this.listeners.get(type);
    if (arr) this.listeners.set(type, arr.filter((x) => x !== cb));
  }

  send(data) {
    this.sentMessages.push(data);
  }

  emitMessage(data) {
    const arr = this.listeners.get('message') || [];
    for (const cb of arr) {
      cb({ data });
    }
  }
}

// Wire-format packer: [4B len][JSON header][raw payload]
const packChunk = (index, totalChunks, data, transferId = 'tx_test_1', fileId = 'f1') => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = JSON.stringify({
    transferId,
    fileId,
    index,
    totalChunks,
    byteLength: buf.length,
  });
  const headerBuf = Buffer.from(header, 'utf8');
  const payload = Buffer.alloc(4 + headerBuf.length + buf.length);
  payload.writeUInt32BE(headerBuf.length, 0);
  headerBuf.copy(payload, 4);
  buf.copy(payload, 4 + headerBuf.length);
  return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
};

describe('MobileFileReceiver Queue & Ordering Tests', () => {
  it('processes FILE_END only after slow chunk write completes and correctly validates SHA-256', async () => {
    // Dynamically load MobileFileReceiver with mocked FileSystem
    const fsMock = new MockFileSystem();
    fsMock.writeDelayMs = 50; // Each chunk write takes 50ms

    // Transpile transfer.ts module with mocked FileSystem
    const ts = require('typescript');
    const fs = require('fs');
    let code = fs.readFileSync('src/services/transfer.ts', 'utf8');
    
    // Transpile transfer.ts and crypto.ts dynamically
    const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const mod = { exports: {} };
    const cryptoCode = fs.readFileSync('src/services/crypto.ts', 'utf8');
    const cryptoJs = ts.transpileModule(cryptoCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const cryptoMod = { exports: {} };
    const cryptoFn = new Function('exports', 'module', 'require', cryptoJs);
    cryptoFn(cryptoMod.exports, cryptoMod, require);
    const { MobileIncrementalSha256 } = cryptoMod.exports;

    const requireMock = (id) => {
      if (id === 'expo-file-system/legacy') return { ...fsMock, default: fsMock };
      if (id === './crypto') return { MobileIncrementalSha256 };
      return require(id);
    };
    const fn = new Function('exports', 'module', 'require', js);
    fn(mod.exports, mod, requireMock);

    const { MobileFileReceiver } = mod.exports;
    const dc = new MockDataChannel();
    const receiver = new MobileFileReceiver(dc);

    let completed = false;
    let completedFiles = [];
    receiver.onComplete = (files) => {
      completed = true;
      completedFiles = files;
    };

    let errorReported = null;
    receiver.onError = (err) => {
      errorReported = err;
    };

    // Prepare 101,297 bytes payload (same as user report)
    const totalSize = 101297;
    const chunk1Size = 65536;
    const chunk2Size = 35761;
    const chunk1Data = Buffer.alloc(chunk1Size, 'A');
    const chunk2Data = Buffer.alloc(chunk2Size, 'B');
    const fullData = Buffer.concat([chunk1Data, chunk2Data]);
    const expectedSha256 = crypto.createHash('sha256').update(fullData).digest('hex');

    const manifest = {
      transferId: 'tx_test_1',
      totalFiles: 1,
      totalSize,
      files: [
        {
          id: 'f1',
          name: 'test_photo.jpg',
          size: totalSize,
          mimeType: 'image/jpeg',
          totalChunks: 2,
          sha256: expectedSha256,
        },
      ],
    };

    // Send TRANSFER_START
    dc.emitMessage(JSON.stringify({ type: 'TRANSFER_START', transferId: 'tx_test_1', manifest }));
    // Send FILE_START
    dc.emitMessage(JSON.stringify({ type: 'FILE_START', transferId: 'tx_test_1', fileId: 'f1' }));

    // Send Chunk 0 and Chunk 1 immediately without waiting
    dc.emitMessage(packChunk(0, 2, chunk1Data));
    dc.emitMessage(packChunk(1, 2, chunk2Data));

    // Send FILE_END immediately while chunk writes are still in flight!
    dc.emitMessage(JSON.stringify({ type: 'FILE_END', transferId: 'tx_test_1', fileId: 'f1' }));
    // Send TRANSFER_END
    dc.emitMessage(JSON.stringify({ type: 'TRANSFER_END', transferId: 'tx_test_1' }));

    // Wait for async queue to drain (2 chunks * 50ms write + disk read = ~150ms)
    await new Promise((r) => setTimeout(r, 400));

    assert.strictEqual(errorReported, null, `Expected no error, got: ${errorReported}`);
    assert.strictEqual(completed, true, 'Expected transfer to complete successfully');
    assert.strictEqual(completedFiles.length, 1);
    assert.strictEqual(completedFiles[0].size, totalSize);

    // Verify FILE_ACK was sent back to sender
    const ack = dc.sentMessages.find((m) => m.includes('FILE_ACK'));
    assert.ok(ack, 'Expected FILE_ACK sent');
  });

  it('an error in one message does not deadlock the queue', async () => {
    const fsMock = new MockFileSystem();
    const ts = require('typescript');
    const fs = require('fs');
    let code = fs.readFileSync('src/services/transfer.ts', 'utf8');
    const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const mod = { exports: {} };
    const cryptoCode = fs.readFileSync('src/services/crypto.ts', 'utf8');
    const cryptoJs = ts.transpileModule(cryptoCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const cryptoMod = { exports: {} };
    new Function('exports', 'module', 'require', cryptoJs)(cryptoMod.exports, cryptoMod, require);
    const { MobileIncrementalSha256 } = cryptoMod.exports;

    const requireMock = (id) => {
      if (id === 'expo-file-system/legacy') return { ...fsMock, default: fsMock };
      if (id === './crypto') return { MobileIncrementalSha256 };
      return require(id);
    };
    new Function('exports', 'module', 'require', js)(mod.exports, mod, requireMock);

    const { MobileFileReceiver } = mod.exports;
    const dc = new MockDataChannel();
    const receiver = new MobileFileReceiver(dc);

    let errorReported = null;
    receiver.onError = (err) => {
      errorReported = err;
    };

    // Send malformed JSON message
    dc.emitMessage('INVALID_JSON_MESSAGE{{{');

    // Wait short tick
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(errorReported, 'Error reported for malformed message');
    // Ensure queue is not permanently hanging/deadlocked
    assert.doesNotReject(receiver.messageQueue);
  });

  it('files picked after pairing are included in the manifest when read via ref', async () => {
    const fsMock = new MockFileSystem();
    const ts = require('typescript');
    const fs = require('fs');
    let code = fs.readFileSync('src/services/transfer.ts', 'utf8');
    const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const mod = { exports: {} };
    const cryptoCode = fs.readFileSync('src/services/crypto.ts', 'utf8');
    const cryptoJs = ts.transpileModule(cryptoCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const cryptoMod = { exports: {} };
    new Function('exports', 'module', 'require', cryptoJs)(cryptoMod.exports, cryptoMod, require);
    const { MobileIncrementalSha256 } = cryptoMod.exports;

    const requireMock = (id) => {
      if (id === 'expo-file-system/legacy') return { ...fsMock, default: fsMock };
      if (id === './crypto') return { MobileIncrementalSha256 };
      return require(id);
    };
    new Function('exports', 'module', 'require', js)(mod.exports, mod, requireMock);

    const { MobileFileSender } = mod.exports;

    // Simulate pairing time: selectedFilesRef is initially empty
    const selectedFilesRef = { current: [] };

    // Pairing listener is set up (simulating setupSignaling)
    let dispatchedSender = null;
    const onTransferResponse = (accepted) => {
      if (accepted) {
        const filesToSend = selectedFilesRef.current;
        if (!filesToSend || filesToSend.length === 0) {
          return 'Choose files first';
        }
        const dc = new MockDataChannel();
        const sender = new MobileFileSender(dc, filesToSend);
        dispatchedSender = { sender, dc };
        return sender;
      }
    };

    // User picks files AFTER pairing
    const fileContent = 'Hello JustShare World';
    const fileBase64 = Buffer.from(fileContent).toString('base64');
    await fsMock.writeAsStringAsync('file:///test_doc.txt', fileBase64);

    selectedFilesRef.current = [
      {
        id: 'file_picked_later_1',
        name: 'test_doc.txt',
        size: Buffer.from(fileContent).length,
        uri: 'file:///test_doc.txt',
        mimeType: 'text/plain',
      },
    ];

    onTransferResponse(true);

    assert.ok(dispatchedSender, 'Sender created successfully');
    
    // Automatically reply with FILE_ACK when sender sends FILE_END so waitForAck succeeds immediately
    const origSend = dispatchedSender.dc.send.bind(dispatchedSender.dc);
    dispatchedSender.dc.send = (msg) => {
      origSend(msg);
      if (typeof msg === 'string' && msg.includes('FILE_END')) {
        const parsed = JSON.parse(msg);
        setTimeout(() => {
          dispatchedSender.dc.emitMessage(JSON.stringify({
            type: 'FILE_ACK',
            transferId: parsed.transferId,
            fileId: parsed.fileId,
          }));
        }, 5);
      }
    };

    await dispatchedSender.sender.start();

    // Check manifest sent via DataChannel
    const startMsgStr = dispatchedSender.dc.sentMessages.find((m) => m.includes('TRANSFER_START'));
    assert.ok(startMsgStr, 'TRANSFER_START was sent');
    const startMsg = JSON.parse(startMsgStr);

    assert.strictEqual(startMsg.manifest.totalFiles, 1);
    assert.strictEqual(startMsg.manifest.files.length, 1);
    assert.strictEqual(startMsg.manifest.files[0].id, 'file_picked_later_1');
    assert.strictEqual(startMsg.manifest.files[0].name, 'test_doc.txt');
    assert.strictEqual(startMsg.manifest.files[0].size, Buffer.from(fileContent).length);
  });

  it('refuses to send and emits error when file list is empty', async () => {
    const fsMock = new MockFileSystem();
    const ts = require('typescript');
    const fs = require('fs');
    let code = fs.readFileSync('src/services/transfer.ts', 'utf8');
    const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const mod = { exports: {} };
    const cryptoCode = fs.readFileSync('src/services/crypto.ts', 'utf8');
    const cryptoJs = ts.transpileModule(cryptoCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const cryptoMod = { exports: {} };
    new Function('exports', 'module', 'require', cryptoJs)(cryptoMod.exports, cryptoMod, require);
    const { MobileIncrementalSha256 } = cryptoMod.exports;

    const requireMock = (id) => {
      if (id === 'expo-file-system/legacy') return { ...fsMock, default: fsMock };
      if (id === './crypto') return { MobileIncrementalSha256 };
      return require(id);
    };
    new Function('exports', 'module', 'require', js)(mod.exports, mod, requireMock);

    const { MobileFileSender } = mod.exports;
    const dc = new MockDataChannel();
    const sender = new MobileFileSender(dc, []);

    let errorReceived = null;
    sender.onError = (err) => {
      errorReceived = err;
    };

    await sender.start();

    assert.strictEqual(errorReceived, 'Choose files first');
    assert.strictEqual(dc.sentMessages.length, 0, 'No DataChannel messages sent when files list is empty');
  });

  it('sends FILE_ACK with sha256Match true on success and false on mismatch', async () => {
    const fsMock = new MockFileSystem();
    const ts = require('typescript');
    const fs = require('fs');
    let code = fs.readFileSync('src/services/transfer.ts', 'utf8');
    const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const mod = { exports: {} };
    const cryptoCode = fs.readFileSync('src/services/crypto.ts', 'utf8');
    const cryptoJs = ts.transpileModule(cryptoCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const cryptoMod = { exports: {} };
    new Function('exports', 'module', 'require', cryptoJs)(cryptoMod.exports, cryptoMod, require);
    const { MobileIncrementalSha256 } = cryptoMod.exports;

    const requireMock = (id) => {
      if (id === 'expo-file-system/legacy') return { ...fsMock, default: fsMock };
      if (id === './crypto') return { MobileIncrementalSha256 };
      return require(id);
    };
    new Function('exports', 'module', 'require', js)(mod.exports, mod, requireMock);

    const { MobileFileReceiver } = mod.exports;

    // Test 1: Successful transfer sends sha256Match: true
    const dcSuccess = new MockDataChannel();
    const receiverSuccess = new MobileFileReceiver(dcSuccess);

    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    const hasher = new MobileIncrementalSha256();
    hasher.update(testData);
    const validSha = hasher.digest();

    const manifestSuccess = {
      transferId: 'tx_ack_test_1',
      totalFiles: 1,
      totalSize: 5,
      files: [
        {
          id: 'f_ack_1',
          name: 'valid.bin',
          size: 5,
          mimeType: 'application/octet-stream',
          totalChunks: 1,
          sha256: validSha,
        },
      ],
    };

    dcSuccess.emitMessage(JSON.stringify({ type: 'TRANSFER_START', transferId: 'tx_ack_test_1', manifest: manifestSuccess }));
    dcSuccess.emitMessage(JSON.stringify({ type: 'FILE_START', transferId: 'tx_ack_test_1', fileId: 'f_ack_1' }));
    dcSuccess.emitMessage(packChunk(0, 1, testData));
    dcSuccess.emitMessage(JSON.stringify({ type: 'FILE_END', transferId: 'tx_ack_test_1', fileId: 'f_ack_1' }));

    await new Promise((r) => setTimeout(r, 60));

    const successAckStr = dcSuccess.sentMessages.find((m) => m.includes('FILE_ACK'));
    assert.ok(successAckStr, 'FILE_ACK sent on success');
    const successAck = JSON.parse(successAckStr);
    assert.strictEqual(successAck.sha256Match, true, 'sha256Match must be true on success');
    assert.strictEqual(successAck.fileId, 'f_ack_1');

    // Test 2: Hash mismatch sends sha256Match: false and error message
    const dcMismatch = new MockDataChannel();
    const receiverMismatch = new MobileFileReceiver(dcMismatch);

    const manifestMismatch = {
      transferId: 'tx_ack_test_2',
      totalFiles: 1,
      totalSize: 5,
      files: [
        {
          id: 'f_ack_2',
          name: 'corrupted.bin',
          size: 5,
          mimeType: 'application/octet-stream',
          totalChunks: 1,
          sha256: '0000000000000000000000000000000000000000000000000000000000000000', // Intentional mismatch
        },
      ],
    };

    let reportedError = null;
    receiverMismatch.onError = (err) => {
      reportedError = err;
    };

    dcMismatch.emitMessage(JSON.stringify({ type: 'TRANSFER_START', transferId: 'tx_ack_test_2', manifest: manifestMismatch }));
    dcMismatch.emitMessage(JSON.stringify({ type: 'FILE_START', transferId: 'tx_ack_test_2', fileId: 'f_ack_2' }));
    dcMismatch.emitMessage(packChunk(0, 1, testData));
    dcMismatch.emitMessage(JSON.stringify({ type: 'FILE_END', transferId: 'tx_ack_test_2', fileId: 'f_ack_2' }));

    await new Promise((r) => setTimeout(r, 60));

    const mismatchAckStr = dcMismatch.sentMessages.find((m) => m.includes('FILE_ACK'));
    assert.ok(mismatchAckStr, 'FILE_ACK sent on checksum failure');
    const mismatchAck = JSON.parse(mismatchAckStr);
    assert.ok(mismatchAck.error && mismatchAck.error.includes('Checksum mismatch'), 'error field populated on mismatch');
    assert.ok(reportedError, 'Receiver onError called');
  });

  it('mobile sender starts immediately with placeholder hash and sends computed hash in FILE_END', async () => {
    const fsMock = new MockFileSystem();
    const ts = require('typescript');
    const fs = require('fs');
    let code = fs.readFileSync('src/services/transfer.ts', 'utf8');
    const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const mod = { exports: {} };
    const cryptoCode = fs.readFileSync('src/services/crypto.ts', 'utf8');
    const cryptoJs = ts.transpileModule(cryptoCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const cryptoMod = { exports: {} };
    new Function('exports', 'module', 'require', cryptoJs)(cryptoMod.exports, cryptoMod, require);
    const { MobileIncrementalSha256 } = cryptoMod.exports;

    const requireMock = (id) => {
      if (id === 'expo-file-system/legacy') return { ...fsMock, default: fsMock };
      if (id === './crypto') return { MobileIncrementalSha256 };
      return require(id);
    };
    new Function('exports', 'module', 'require', js)(mod.exports, mod, requireMock);

    const { MobileFileSender } = mod.exports;

    const payload = Buffer.from('Testing immediate mobile streaming and hashing');
    await fsMock.writeAsStringAsync('file:///immediate.txt', payload.toString('base64'));

    const dc = new MockDataChannel();
    const sentEvents = [];
    const origSend = dc.send.bind(dc);
    dc.send = (msg) => {
      if (typeof msg === 'string') {
        const parsed = JSON.parse(msg);
        sentEvents.push(parsed.type);
        if (parsed.type === 'FILE_END') {
          setTimeout(() => {
            dc.emitMessage(JSON.stringify({
              type: 'FILE_ACK',
              transferId: parsed.transferId,
              fileId: parsed.fileId,
              sha256Match: true,
            }));
          }, 5);
        }
      } else {
        sentEvents.push('CHUNK');
      }
      origSend(msg);
    };

    const files = [
      {
        id: 'f_immediate_1',
        name: 'immediate.txt',
        size: payload.length,
        uri: 'file:///immediate.txt',
        mimeType: 'text/plain',
      },
    ];

    const sender = new MobileFileSender(dc, files, 'tx_immediate');
    await sender.start();

    // Verify ordering: TRANSFER_START -> FILE_START -> CHUNK -> FILE_END
    assert.strictEqual(sentEvents[0], 'TRANSFER_START');
    assert.strictEqual(sentEvents[1], 'FILE_START');
    assert.strictEqual(sentEvents[2], 'CHUNK');
    assert.strictEqual(sentEvents[3], 'FILE_END');

    // Verify manifest had deferred/placeholder hash
    const startMsg = JSON.parse(dc.sentMessages.find((m) => typeof m === 'string' && m.includes('TRANSFER_START')));
    assert.strictEqual(startMsg.manifest.files[0].sha256, '0'.repeat(64));

    // Verify FILE_END carried the correct dynamically computed SHA-256
    const endMsg = JSON.parse(dc.sentMessages.find((m) => typeof m === 'string' && m.includes('FILE_END')));
    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');
    assert.strictEqual(endMsg.sha256, expectedHash);
  });
});
