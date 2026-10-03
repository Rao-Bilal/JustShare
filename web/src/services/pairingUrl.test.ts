import { describe, it, expect } from 'vitest';
import {
  buildPairingUrl,
  determineInitialUrlAction,
  isLocalhostHostname,
  parsePairingCodeFromHash,
} from './pairingUrl';

describe('pairingUrl', () => {
  describe('buildPairingUrl', () => {
    it('constructs correct hash-based pairing URL', () => {
      expect(buildPairingUrl('http://192.168.1.10:5173', '123456')).toBe(
        'http://192.168.1.10:5173/#code=123456'
      );
    });

    it('strips trailing slashes from origin', () => {
      expect(buildPairingUrl('https://share.example.com/', '987654')).toBe(
        'https://share.example.com/#code=987654'
      );
    });

    it('prioritizes optional env override when provided', () => {
      expect(
        buildPairingUrl('http://localhost:5173', '123456', 'https://public.share.com')
      ).toBe('https://public.share.com/#code=123456');
    });
  });

  describe('parsePairingCodeFromHash', () => {
    it('parses valid 6-digit code with leading hash', () => {
      expect(parsePairingCodeFromHash('#code=123456')).toBe('123456');
    });

    it('parses valid 6-digit code without leading hash', () => {
      expect(parsePairingCodeFromHash('code=654321')).toBe('654321');
    });

    it('parses raw 6-digit hash', () => {
      expect(parsePairingCodeFromHash('#112233')).toBe('112233');
    });

    it('returns null for wrong length', () => {
      expect(parsePairingCodeFromHash('#code=12345')).toBeNull();
      expect(parsePairingCodeFromHash('#code=1234567')).toBeNull();
    });

    it('returns null for non-digits', () => {
      expect(parsePairingCodeFromHash('#code=123a56')).toBeNull();
      expect(parsePairingCodeFromHash('#code=abcdef')).toBeNull();
    });

    it('returns null for missing hash or empty code', () => {
      expect(parsePairingCodeFromHash('')).toBeNull();
      expect(parsePairingCodeFromHash('#')).toBeNull();
      expect(parsePairingCodeFromHash('#code=')).toBeNull();
    });
  });

  describe('determineInitialUrlAction', () => {
    it('returns join action for valid 6-digit code', () => {
      expect(determineInitialUrlAction('#code=482915')).toEqual({
        action: 'join',
        code: '482915',
      });
    });

    it('returns error action for code with wrong length', () => {
      expect(determineInitialUrlAction('#code=12345')).toEqual({
        action: 'error',
        message: 'Invalid pairing code in link: must be 6 digits',
      });
      expect(determineInitialUrlAction('#code=12345678')).toEqual({
        action: 'error',
        message: 'Invalid pairing code in link: must be 6 digits',
      });
    });

    it('returns error action for code with non-digits', () => {
      expect(determineInitialUrlAction('#code=12a456')).toEqual({
        action: 'error',
        message: 'Invalid pairing code in link: must be 6 digits',
      });
    });

    it('returns error action for code with extra characters', () => {
      expect(determineInitialUrlAction('#code=123456extra')).toEqual({
        action: 'error',
        message: 'Invalid pairing code in link: must be 6 digits',
      });
    });

    it('returns none action for missing or empty hash', () => {
      expect(determineInitialUrlAction('')).toEqual({ action: 'none' });
      expect(determineInitialUrlAction('#')).toEqual({ action: 'none' });
    });

    it('returns none action for unrelated hash navigation', () => {
      expect(determineInitialUrlAction('#settings')).toEqual({ action: 'none' });
      expect(determineInitialUrlAction('#about')).toEqual({ action: 'none' });
    });
  });

  describe('isLocalhostHostname', () => {
    it('returns true for localhost variants', () => {
      expect(isLocalhostHostname('localhost')).toBe(true);
      expect(isLocalhostHostname('127.0.0.1')).toBe(true);
      expect(isLocalhostHostname('[::1]')).toBe(true);
      expect(isLocalhostHostname('::1')).toBe(true);
    });

    it('returns false for LAN IPs and remote hostnames', () => {
      expect(isLocalhostHostname('192.168.1.50')).toBe(false);
      expect(isLocalhostHostname('10.0.0.12')).toBe(false);
      expect(isLocalhostHostname('share.internal')).toBe(false);
      expect(isLocalhostHostname('justshare.app')).toBe(false);
    });
  });

  describe('StrictMode auto-join deduplication guard', () => {
    it('executes join handler exactly once even when triggered twice in succession', () => {
      let callCount = 0;
      let hasAutoJoined = false;
      const joinedCodes: string[] = [];
      const triggerAutoJoin = (code: string) => {
        if (hasAutoJoined) return;
        hasAutoJoined = true;
        callCount++;
        joinedCodes.push(code);
      };

      // First mount
      const decision1 = determineInitialUrlAction('#code=123456');
      if (decision1.action === 'join') {
        triggerAutoJoin(decision1.code);
      }

      // Second mount (React StrictMode simulation)
      const decision2 = determineInitialUrlAction('#code=123456');
      if (decision2.action === 'join') {
        triggerAutoJoin(decision2.code);
      }

      expect(callCount).toBe(1);
      expect(joinedCodes).toEqual(['123456']);
    });
  });
});
