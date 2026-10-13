import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from './api';
import { clearDevice, getOrCreateDevice, isJwtValid, resetDevice } from './device';

// In-memory localStorage mock for node environment
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, String(value));
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
};
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

function createMockJwt(expSecondsFromNow: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  const payload = btoa(JSON.stringify({ device_id: 'dev-123', exp }));
  const signature = 'mock_signature';
  return `${header}.${payload}.${signature}`;
}

describe('device service', () => {
  beforeEach(() => {
    localStorageMock.clear();
    clearDevice();
    vi.restoreAllMocks();
  });

  describe('isJwtValid', () => {
    it('returns true for future unexpired token', () => {
      const validToken = createMockJwt(3600); // 1 hour future
      expect(isJwtValid(validToken)).toBe(true);
    });

    it('returns false for past expired token', () => {
      const expiredToken = createMockJwt(-3600); // 1 hour in past
      expect(isJwtValid(expiredToken)).toBe(false);
    });

    it('returns false for token expiring in < 30 seconds', () => {
      const soonExpiring = createMockJwt(10);
      expect(isJwtValid(soonExpiring)).toBe(false);
    });

    it('returns false for malformed token string', () => {
      expect(isJwtValid('not.a.jwt')).toBe(false);
      expect(isJwtValid('')).toBe(false);
      expect(isJwtValid(undefined)).toBe(false);
    });
  });

  it('shares in-flight registration so concurrent calls produce exactly one POST /devices', async () => {
    const mockDevice = {
      device_id: 'dev-123',
      display_name: 'Browser-a1b2',
      token: createMockJwt(3600),
    };

    let callCount = 0;
    vi.spyOn(api, 'createDevice').mockImplementation(async () => {
      callCount++;
      // Simulate network delay
      await new Promise((resolve) => setTimeout(resolve, 20));
      return mockDevice;
    });

    const [dev1, dev2] = await Promise.all([getOrCreateDevice(), getOrCreateDevice()]);

    expect(callCount).toBe(1);
    expect(dev1).toEqual(mockDevice);
    expect(dev2).toEqual(mockDevice);
    expect(dev1).toBe(dev2);
  });

  it('clears in-flight promise on failure so registration can be retried', async () => {
    const mockDevice = {
      device_id: 'dev-456',
      display_name: 'Browser-c3d4',
      token: createMockJwt(3600),
    };

    let attempt = 0;
    vi.spyOn(api, 'createDevice').mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error('Network error on registration');
      }
      return mockDevice;
    });

    // First attempt fails
    await expect(getOrCreateDevice()).rejects.toThrow('Network error on registration');

    // Second attempt retries and succeeds
    const dev = await getOrCreateDevice();
    expect(dev).toEqual(mockDevice);
    expect(attempt).toBe(2);
  });

  it('returns saved device from localStorage when token is valid', async () => {
    const validToken = createMockJwt(7200);
    const savedDevice = {
      device_id: 'saved-dev-789',
      display_name: 'Browser-saved',
      token: validToken,
    };
    localStorageMock.setItem('justshare_device', JSON.stringify(savedDevice));

    const createDeviceSpy = vi.spyOn(api, 'createDevice');

    const dev = await getOrCreateDevice();
    expect(dev).toEqual(savedDevice);
    expect(createDeviceSpy).not.toHaveBeenCalled();
  });

  it('automatically replaces expired token while preserving display name', async () => {
    const expiredToken = createMockJwt(-100);
    const staleDevice = {
      device_id: 'stale-dev-old',
      display_name: 'Bilal-Laptop',
      token: expiredToken,
    };
    localStorageMock.setItem('justshare_device', JSON.stringify(staleDevice));

    const freshDevice = {
      device_id: 'fresh-dev-new',
      display_name: 'Bilal-Laptop',
      token: createMockJwt(3600),
    };

    const createDeviceSpy = vi.spyOn(api, 'createDevice').mockResolvedValue(freshDevice);

    const dev = await getOrCreateDevice();
    expect(createDeviceSpy).toHaveBeenCalledWith('Bilal-Laptop');
    expect(dev).toEqual(freshDevice);
    expect(localStorageMock.getItem('justshare_device')).toBe(JSON.stringify(freshDevice));
  });

  it('resetDevice forces new registration and stores new device', async () => {
    const oldDevice = {
      device_id: 'old-dev',
      display_name: 'Old-Browser',
      token: createMockJwt(3600),
    };
    localStorageMock.setItem('justshare_device', JSON.stringify(oldDevice));

    const newDevice = {
      device_id: 'new-dev',
      display_name: 'New-Browser',
      token: createMockJwt(3600),
    };
    vi.spyOn(api, 'createDevice').mockResolvedValue(newDevice);

    const dev = await resetDevice('New-Browser');
    expect(dev).toEqual(newDevice);
    expect(localStorageMock.getItem('justshare_device')).toBe(JSON.stringify(newDevice));
  });
});
