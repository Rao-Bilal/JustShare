import { createDevice } from './api';

const DEVICE_KEY = 'justshare_device';

export interface StoredDevice {
  device_id: string;
  display_name: string;
  token: string;
}

export async function getOrCreateDevice(): Promise<StoredDevice> {
  const stored = localStorage.getItem(DEVICE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored) as StoredDevice;
    } catch {
      localStorage.removeItem(DEVICE_KEY);
    }
  }

  return resetDevice();
}

export async function resetDevice(): Promise<StoredDevice> {
  localStorage.removeItem(DEVICE_KEY);
  const randomSuffix = Math.floor(Math.random() * 65536)
    .toString(16)
    .padStart(4, '0');
  const displayName = `Browser-${randomSuffix}`;

  const device = await createDevice(displayName);
  localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
  return device;
}

export function clearDevice(): void {
  localStorage.removeItem(DEVICE_KEY);
}
