import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from './api';
import { clearDevice, getOrCreateDevice, resetDevice } from './device';

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

describe('device service', () => {
  beforeEach(() => {
    localStorageMock.clear();
    clearDevice();
    vi.restoreAllMocks();
  });

  it('shares in-flight registration so concurrent calls produce exactly one POST /devices', async () => {
    const mockDevice = {
      device_id: 'dev-123',
      display_name: 'Browser-a1b2',
      token: 'jwt-token-xyz',
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
      token: 'jwt-token-456',
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

  it('returns saved device from localStorage without calling createDevice', async () => {
    const savedDevice = {
      device_id: 'saved-dev-789',
      display_name: 'Browser-saved',
      token: 'saved-jwt-token',
    };
    localStorageMock.setItem('justshare_device', JSON.stringify(savedDevice));

    const createDeviceSpy = vi.spyOn(api, 'createDevice');

    const dev = await getOrCreateDevice();
    expect(dev).toEqual(savedDevice);
    expect(createDeviceSpy).not.toHaveBeenCalled();
  });

  it('resetDevice forces new registration and stores new device', async () => {
    const oldDevice = {
      device_id: 'old-dev',
      display_name: 'Old-Browser',
      token: 'old-token',
    };
    localStorageMock.setItem('justshare_device', JSON.stringify(oldDevice));

    const newDevice = {
      device_id: 'new-dev',
      display_name: 'New-Browser',
      token: 'new-token',
    };
    vi.spyOn(api, 'createDevice').mockResolvedValue(newDevice);

    const dev = await resetDevice();
    expect(dev).toEqual(newDevice);
    expect(localStorageMock.getItem('justshare_device')).toBe(JSON.stringify(newDevice));
  });
});
