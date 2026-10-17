/**
 * Device identity service for JustShare Mobile.
 *
 * Responsibilities:
 * 1. Generating friendly default display names (Adjective + Animal).
 * 2. Checking JWT validity and expiration.
 * 3. Loading existing credentials from secure storage or registering a new device.
 * 4. Deduplicating concurrent in-flight registration attempts.
 */
import { registerDevice, DeviceResponse } from './api';
import { getStoredDevice, saveStoredDevice, StoredDevice, clearStoredDevice } from './storage';

const ADJECTIVES = [
  'Swift', 'Brave', 'Calm', 'Clever', 'Eager',
  'Gentle', 'Happy', 'Jolly', 'Lively', 'Proud',
  'Quick', 'Silent', 'Witty', 'Bright', 'Bold',
];

const ANIMALS = [
  'Falcon', 'Otter', 'Panda', 'Fox', 'Hawk',
  'Koala', 'Lion', 'Wolf', 'Tiger', 'Bear',
  'Eagle', 'Dolphin', 'Lynx', 'Raven', 'Seal',
];

/**
 * Generates a human-friendly device name (e.g., "Swift Falcon 42").
 */
export function generateFriendlyName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const num = Math.floor(Math.random() * 90 + 10);
  return `${adj} ${animal} ${num}`;
}

/**
 * Checks if a JWT token is valid and not expired.
 * Buffers by 60 seconds to prevent edge-of-expiry race conditions.
 */
export function isJwtValid(token: string): boolean {
  if (!token) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    // Decode base64url payload
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }

    // Standard base64 decode for React Native / Hermes
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    let output = '';
    base64 = base64.replace(/[^A-Za-z0-9\+\/\=]/g, '');
    for (let bc = 0, bs = 0, buffer, idx = 0; (buffer = base64.charAt(idx++)); ) {
      const charIndex = chars.indexOf(buffer);
      if (~charIndex) {
        bs = bc % 4 ? bs * 64 + charIndex : charIndex;
        if (bc++ % 4) {
          output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
        }
      }
    }

    const payload = JSON.parse(output);
    if (!payload.exp) return false;

    // Check expiration with 60-second safety buffer
    const nowInSeconds = Math.floor(Date.now() / 1000);
    return payload.exp > nowInSeconds + 60;
  } catch {
    return false;
  }
}

// In-flight registration promise deduplication
let inFlightRegistration: Promise<StoredDevice> | null = null;

/**
 * Retrieves the stored device if its token is valid, or registers a new device with the backend.
 * Ensures concurrent calls share the exact same in-flight registration promise.
 */
export async function getOrCreateDevice(forceNew = false): Promise<StoredDevice> {
  if (!forceNew) {
    const stored = await getStoredDevice();
    if (stored && isJwtValid(stored.token)) {
      return stored;
    }
  }

  // Deduplicate concurrent registration attempts
  if (inFlightRegistration) {
    return inFlightRegistration;
  }

  inFlightRegistration = (async () => {
    try {
      const displayName = generateFriendlyName();
      const response: DeviceResponse = await registerDevice(displayName);

      const stored = await saveStoredDevice({
        deviceId: response.device_id,
        displayName: response.display_name,
        token: response.token,
      });

      return stored;
    } catch (err) {
      // Clear stored credentials if registration fails so we don't hold invalid state
      await clearStoredDevice().catch(() => {});
      throw err;
    } finally {
      inFlightRegistration = null;
    }
  })();

  return inFlightRegistration;
}
