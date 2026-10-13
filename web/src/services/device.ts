import { createDevice } from './api';

const DEVICE_KEY = 'justshare_device';

export interface StoredDevice {
  device_id: string;
  display_name: string;
  token: string;
}

let inFlightRegistration: Promise<StoredDevice> | null = null;

const ADJECTIVES = [
  'Swift', 'Solar', 'Cosmic', 'Amber', 'Brave', 'Golden', 'Emerald', 'Ruby',
  'Silver', 'Lunar', 'Mystic', 'Vivid', 'Cedar', 'Coral', 'Ocean', 'Frost',
  'Pine', 'Noble', 'Calm', 'Bold', 'Bright', 'Silent', 'Wise', 'Warm'
];

const NOUNS = [
  'Falcon', 'Lynx', 'Otter', 'Fox', 'Dolphin', 'Hawk', 'Eagle', 'Wolf',
  'Panda', 'Bear', 'Raven', 'Owl', 'Stag', 'Tiger', 'Seal', 'Finch',
  'Badger', 'Heron', 'Robin', 'Deer', 'Koala', 'Puma', 'Bison', 'Crane'
];

export function generateFriendlyName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
}

const AVATAR_COLORS = [
  { bg: '#3b82f6', text: '#ffffff' }, // Blue
  { bg: '#10b981', text: '#ffffff' }, // Emerald
  { bg: '#8b5cf6', text: '#ffffff' }, // Violet
  { bg: '#f59e0b', text: '#ffffff' }, // Amber
  { bg: '#ec4899', text: '#ffffff' }, // Pink
  { bg: '#06b6d4', text: '#ffffff' }, // Cyan
  { bg: '#f97316', text: '#ffffff' }, // Orange
  { bg: '#6366f1', text: '#ffffff' }, // Indigo
];

export function getAvatarColor(name: string): { bg: string; text: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

export function getInitials(name: string): string {
  if (!name) return 'JS';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * Checks whether a JWT token string is structurally valid and unexpired.
 * Returns true if valid with at least 30s before exp timestamp.
 */
export function isJwtValid(token?: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  try {
    // Base64Url decode payload
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const payload = JSON.parse(jsonPayload) as { exp?: number; device_id?: string };
    if (!payload || typeof payload.exp !== 'number') return false;

    // Give a 30s buffer before exp
    const nowSeconds = Math.floor(Date.now() / 1000);
    return payload.exp > nowSeconds + 30;
  } catch {
    return false;
  }
}

/**
 * Loads the stored device or creates/refreshes a valid device token.
 * If the stored token is expired or invalid, it re-registers using the same display name.
 */
export async function getOrCreateDevice(): Promise<StoredDevice> {
  const stored = localStorage.getItem(DEVICE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as StoredDevice;
      if (parsed.device_id && parsed.token && isJwtValid(parsed.token)) {
        // Migrate legacy "Browser-xxxx" names to friendly names
        if (/^Browser-/i.test(parsed.display_name)) {
          return resetDevice(generateFriendlyName());
        }
        return parsed;
      }
      // Stored token is expired or invalid: preserve display name if available
      return resetDevice(parsed.display_name);
    } catch {
      localStorage.removeItem(DEVICE_KEY);
    }
  }

  return resetDevice();
}

/**
 * Creates a new device registration. If preferredDisplayName is provided, it preserves the existing name.
 */
export async function resetDevice(preferredDisplayName?: string): Promise<StoredDevice> {
  if (inFlightRegistration) {
    return inFlightRegistration;
  }

  localStorage.removeItem(DEVICE_KEY);
  const displayName = preferredDisplayName || generateFriendlyName();

  inFlightRegistration = createDevice(displayName)
    .then((device) => {
      localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
      return device;
    })
    .finally(() => {
      inFlightRegistration = null;
    });

  return inFlightRegistration;
}

export async function renameDevice(newDisplayName: string): Promise<StoredDevice> {
  return resetDevice(newDisplayName.trim());
}

export function clearDevice(): void {
  localStorage.removeItem(DEVICE_KEY);
  inFlightRegistration = null;
}

/**
 * Checks whether the current runtime environment supports native directory/folder selection.
 * Mobile platforms (Android, iOS) do not provide a native folder picker via `<input webkitdirectory>`.
 */
export function supportsDirectoryUpload(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return true;
  }
  const ua = navigator.userAgent || '';
  const isMobilePlatform = /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua));
  return !isMobilePlatform;
}
