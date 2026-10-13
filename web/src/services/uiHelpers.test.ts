import { describe, it, expect } from 'vitest';
import { mapTechnicalError, truncateMiddle, formatDuration } from './errorMapper';
import { formatBytes, formatEta, formatSpeed } from './format';
import { COPY } from '../copy';

describe('errorMapper helper', () => {
  it('maps disconnect errors to friendly copy', () => {
    const res = mapTechnicalError('WebRTC peer disconnected unexpectedly');
    expect(res.headline).toBe(COPY.errors.peerDisconnected.headline);
    expect(res.rawDetails).toBe('WebRTC peer disconnected unexpectedly');
  });

  it('maps session expired errors to friendly copy', () => {
    const res = mapTechnicalError('Session pairing code expired');
    expect(res.headline).toBe(COPY.errors.sessionExpired.headline);
  });

  it('maps session not found / 404 to friendly copy', () => {
    const res = mapTechnicalError('Session not found (404)');
    expect(res.headline).toBe(COPY.errors.sessionNotFound.headline);
  });

  it('maps hash integrity failure to friendly copy', () => {
    const res = mapTechnicalError('SHA-256 hash mismatch during verification');
    expect(res.headline).toBe(COPY.errors.integrityFailed.headline);
  });

  it('maps cancellation to friendly copy', () => {
    const res = mapTechnicalError('Transfer cancelled by receiver');
    expect(res.headline).toBe(COPY.errors.transferCancelled.headline);
  });

  it('falls back to friendly default error for unknown errors', () => {
    const res = mapTechnicalError('Random network timeout socket 123');
    expect(res.headline).toBe(COPY.errors.default.headline);
  });
});

describe('truncateMiddle helper', () => {
  it('leaves short strings untouched', () => {
    expect(truncateMiddle('file.txt', 20)).toBe('file.txt');
  });

  it('truncates longer strings in the middle preserving extension', () => {
    const longName = 'this-is-a-very-long-document-name-2026.pdf';
    const truncated = truncateMiddle(longName, 20);
    expect(truncated.length).toBeLessThanOrEqual(20);
    expect(truncated).toContain('...');
    expect(truncated.endsWith('.pdf')).toBe(true);
  });
});

describe('formatDuration helper', () => {
  it('formats seconds', () => {
    expect(formatDuration(45)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125)).toBe('2m 5s');
  });
});

describe('formatting helpers', () => {
  it('formats bytes properly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
  });

  it('formats speed and eta without errors', () => {
    expect(formatSpeed(1048576)).toBe('1 MB/s');
    expect(formatEta(120)).toBe('2m 00s');
  });
});
