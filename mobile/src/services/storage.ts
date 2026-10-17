/**
 * Secure storage service for device credentials using expo-secure-store.
 * Falls back gracefully to in-memory storage if SecureStore is unavailable
 * (e.g. web preview or unit testing environment).
 */
import * as SecureStore from 'expo-secure-store';

export interface StoredDevice {
  deviceId: string;
  displayName: string;
  token: string;
  savedAt: number;
}

const STORAGE_KEYS = {
  DEVICE_ID: 'justshare_device_id',
  DISPLAY_NAME: 'justshare_display_name',
  AUTH_TOKEN: 'justshare_auth_token',
  SAVED_AT: 'justshare_saved_at',
} as const;

// In-memory fallback cache when SecureStore is not available
const inMemoryFallback = new Map<string, string>();

async function isSecureStoreAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

async function setItem(key: string, value: string): Promise<void> {
  const available = await isSecureStoreAvailable();
  if (available) {
    await SecureStore.setItemAsync(key, value);
  } else {
    inMemoryFallback.set(key, value);
  }
}

async function getItem(key: string): Promise<string | null> {
  const available = await isSecureStoreAvailable();
  if (available) {
    return await SecureStore.getItemAsync(key);
  } else {
    return inMemoryFallback.get(key) ?? null;
  }
}

async function deleteItem(key: string): Promise<void> {
  const available = await isSecureStoreAvailable();
  if (available) {
    await SecureStore.deleteItemAsync(key);
  } else {
    inMemoryFallback.delete(key);
  }
}

/**
 * Persists device identity credentials into secure storage.
 */
export async function saveStoredDevice(device: {
  deviceId: string;
  displayName: string;
  token: string;
}): Promise<StoredDevice> {
  const savedAt = Date.now();
  await Promise.all([
    setItem(STORAGE_KEYS.DEVICE_ID, device.deviceId),
    setItem(STORAGE_KEYS.DISPLAY_NAME, device.displayName),
    setItem(STORAGE_KEYS.AUTH_TOKEN, device.token),
    setItem(STORAGE_KEYS.SAVED_AT, String(savedAt)),
  ]);

  return {
    deviceId: device.deviceId,
    displayName: device.displayName,
    token: device.token,
    savedAt,
  };
}

/**
 * Retrieves the stored device identity credentials. Returns null if any required field is missing.
 */
export async function getStoredDevice(): Promise<StoredDevice | null> {
  const [deviceId, displayName, token, savedAtStr] = await Promise.all([
    getItem(STORAGE_KEYS.DEVICE_ID),
    getItem(STORAGE_KEYS.DISPLAY_NAME),
    getItem(STORAGE_KEYS.AUTH_TOKEN),
    getItem(STORAGE_KEYS.SAVED_AT),
  ]);

  if (!deviceId || !displayName || !token) {
    return null;
  }

  return {
    deviceId,
    displayName,
    token,
    savedAt: savedAtStr ? parseInt(savedAtStr, 10) : 0,
  };
}

/**
 * Removes the stored device credentials from secure storage.
 */
export async function clearStoredDevice(): Promise<void> {
  await Promise.all([
    deleteItem(STORAGE_KEYS.DEVICE_ID),
    deleteItem(STORAGE_KEYS.DISPLAY_NAME),
    deleteItem(STORAGE_KEYS.AUTH_TOKEN),
    deleteItem(STORAGE_KEYS.SAVED_AT),
  ]);
}
