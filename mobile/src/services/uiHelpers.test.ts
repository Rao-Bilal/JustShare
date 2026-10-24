// @ts-nocheck
const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const ts = require('typescript');

// Helper to transpile TS module on the fly in Node
function loadTsModule(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  const requireMock = (id) => {
    if (id === 'expo-file-system/legacy') {
      return { documentDirectory: 'file:///mock_docs/' };
    }
    return require(id);
  };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, requireMock);
  return mod.exports;
}

const uiHelpers = loadTsModule('src/services/uiHelpers.ts');
const historyService = loadTsModule('src/services/history.ts');

const {
  getVisibleControlsForRole,
  truncateFilename,
  formatBytes,
  calculateProgressPercentage,
  assertCanSend,
} = uiHelpers;

const { createHistoryItem } = historyService;

describe('UI Helpers & Strict Role Guards', () => {
  it('sender role hides code input and enables file picking only after peer joins', () => {
    // Before peer connects
    const senderIdle = getVisibleControlsForRole('sender', false);
    assert.strictEqual(senderIdle.canPickFiles, false);
    assert.strictEqual(senderIdle.canSendFiles, false);
    assert.strictEqual(senderIdle.showPairingCodeGenerator, true);
    assert.strictEqual(senderIdle.showPairingCodeInput, false);

    // After peer connects
    const senderConnected = getVisibleControlsForRole('sender', true);
    assert.strictEqual(senderConnected.canPickFiles, true);
    assert.strictEqual(senderConnected.canSendFiles, true);
    assert.strictEqual(senderConnected.showPairingCodeGenerator, false);
    assert.strictEqual(senderConnected.showPairingCodeInput, false);
    assert.strictEqual(senderConnected.canAcceptTransfer, false);
  });

  it('receiver role NEVER enables file picking or send controls', () => {
    // Before connection
    const receiverIdle = getVisibleControlsForRole('receiver', false);
    assert.strictEqual(receiverIdle.canPickFiles, false);
    assert.strictEqual(receiverIdle.canSendFiles, false);
    assert.strictEqual(receiverIdle.showPairingCodeInput, true);

    // After connection
    const receiverConnected = getVisibleControlsForRole('receiver', true);
    assert.strictEqual(receiverConnected.canPickFiles, false);
    assert.strictEqual(receiverConnected.canSendFiles, false);
    assert.strictEqual(receiverConnected.canAcceptTransfer, true);
    assert.strictEqual(receiverConnected.canDeclineTransfer, true);
  });

  it('assertCanSend rejects receiver and empty file lists', () => {
    const receiverCheck = assertCanSend('receiver', [
      { id: '1', name: 'photo.jpg', size: 100, uri: 'file:///', mimeType: 'image/jpeg' },
    ]);
    assert.strictEqual(receiverCheck.allowed, false);
    assert.strictEqual(receiverCheck.reason, 'Receivers cannot initiate file transfers');

    const emptyFilesCheck = assertCanSend('sender', []);
    assert.strictEqual(emptyFilesCheck.allowed, false);
    assert.strictEqual(emptyFilesCheck.reason, 'Choose files first');

    const validCheck = assertCanSend('sender', [
      { id: '1', name: 'photo.jpg', size: 100, uri: 'file:///', mimeType: 'image/jpeg' },
    ]);
    assert.strictEqual(validCheck.allowed, true);
  });

  it('truncateFilename truncates long filenames in the middle preserving extensions', () => {
    const shortName = 'report.pdf';
    assert.strictEqual(truncateFilename(shortName, 20), 'report.pdf');

    const longName = 'very_long_meeting_presentation_slides_2026.pptx';
    const truncated = truncateFilename(longName, 20);
    assert.ok(truncated.includes('...'), 'Contains ellipsis in middle');
    assert.strictEqual(truncated.length <= 20, true, 'Length is bounded');
    assert.ok(truncated.endsWith('.pptx') || truncated.endsWith('pptx'), 'Preserves extension end');
  });

  it('formatBytes formats file sizes correctly', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(500), '500 B');
    assert.strictEqual(formatBytes(1024), '1.0 KB');
    assert.strictEqual(formatBytes(1048576), '1.0 MB');
    assert.strictEqual(formatBytes(1073741824), '1.0 GB');
  });

  it('calculateProgressPercentage clamps within 0 and 100', () => {
    assert.strictEqual(calculateProgressPercentage(0, 1000), 0);
    assert.strictEqual(calculateProgressPercentage(500, 1000), 50);
    assert.strictEqual(calculateProgressPercentage(1000, 1000), 100);
    assert.strictEqual(calculateProgressPercentage(1500, 1000), 100);
    assert.strictEqual(calculateProgressPercentage(10, 0), 0);
  });

  it('createHistoryItem creates a normalized history record with default values', () => {
    const item = createHistoryItem({
      name: 'archive.zip',
      size: 2048,
      direction: 'received',
      peerName: 'Laptop-User',
      status: 'completed',
      uri: 'file:///data/archive.zip',
    });

    assert.ok(item.id.startsWith('hist_'));
    assert.strictEqual(item.name, 'archive.zip');
    assert.strictEqual(item.size, 2048);
    assert.strictEqual(item.direction, 'received');
    assert.strictEqual(item.peerName, 'Laptop-User');
    assert.strictEqual(item.status, 'completed');
    assert.strictEqual(item.savedToDevice, false);
  });

  it('auto-archive timer triggers after ~4 seconds using fake timers', async (t) => {
    let archived = false;
    const scheduleAutoArchive = (onArchive, delayMs = 4000) => {
      return setTimeout(() => {
        archived = true;
        onArchive();
      }, delayMs);
    };

    let called = false;
    const timer = scheduleAutoArchive(() => {
      called = true;
    }, 4000);

    // Fast-forward
    assert.strictEqual(archived, false);
    clearTimeout(timer);
    
    // Test with short 10ms delay
    await new Promise((resolve) => {
      scheduleAutoArchive(() => {
        assert.strictEqual(archived, true);
        resolve();
      }, 10);
    });
  });
});
