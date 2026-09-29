import { describe, expect, it, vi } from 'vitest';
import { formatRemoteLog, redactDeviceId, RemoteDevLogger, RemoteLogPayload } from './devLogger';

describe('RemoteDevLogger (Development-Only Logging)', () => {
  it('redacts device IDs appropriately for safe dev output', () => {
    expect(redactDeviceId(null)).toBe('anon');
    expect(redactDeviceId('')).toBe('anon');
    expect(redactDeviceId('12345678')).toBe('12345678');
    expect(redactDeviceId('9e4f16b2-019a-4c22-9218-d70c4faef74c')).toBe('9e4f...f74c');
  });

  it('formats remote log payloads cleanly without exposing sensitive data', () => {
    const payload: RemoteLogPayload = {
      milestone: 'hash_completed',
      timestamp: '2026-09-28T23:30:00.000Z',
      senderDeviceIdRedacted: '9e4f...f74c',
      transferId: 'tx-1234',
      fileName: 'video.mp4',
      fileSize: 41943040,
      elapsedMs: 250,
    };

    const formatted = formatRemoteLog(payload);
    expect(formatted).toBe(
      "[REMOTE-DEV-LOG][9e4f...f74c][hash_completed] tx=tx-1234 file='video.mp4' size=41943040B elapsed=250ms"
    );
  });

  it('sends sanitized log payload across transport fail-safely', () => {
    const mockTransport = {
      send: vi.fn(),
    };

    const logger = new RemoteDevLogger(mockTransport, '9e4f16b2-019a-4c22-9218-d70c4faef74c');

    logger.log('transfer_start_sent', {
      transferId: 'tx-1234',
      fileSize: 1024,
    });

    expect(mockTransport.send).toHaveBeenCalledTimes(1);
    const sentMsg = mockTransport.send.mock.calls[0][0] as { type: string; payload: RemoteLogPayload };
    expect(sentMsg.type).toBe('dev_log');
    expect(sentMsg.payload.milestone).toBe('transfer_start_sent');
    expect(sentMsg.payload.senderDeviceIdRedacted).toBe('9e4f...f74c');
    expect(sentMsg.payload.transferId).toBe('tx-1234');
    expect(sentMsg.payload.fileSize).toBe(1024);
  });

  it('swallows transport errors fail-safely without throwing', () => {
    const throwingTransport = {
      send: vi.fn(() => {
        throw new Error('WebSocket network crash');
      }),
    };

    const logger = new RemoteDevLogger(throwingTransport, 'test-device');

    expect(() => {
      logger.log('first_chunk_sent', {
        transferId: 'tx-fail-safe',
        chunkIndex: 0,
      });
    }).not.toThrow();
  });
});
