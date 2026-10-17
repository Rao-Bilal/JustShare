/**
 * Application configuration module.
 *
 * Reads backend URL from EXPO_PUBLIC_BACKEND_URL with validation,
 * normalization, and descriptive error guidance for LAN setup on physical devices.
 */

const DEFAULT_DEV_FALLBACK_URL = 'http://localhost:8000';

export interface AppConfig {
  backendUrl: string;
  apiBaseUrl: string;
}

/**
 * Normalizes a base URL by trimming whitespace and removing trailing slashes.
 */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.replace(/\/+$/, '');
}

/**
 * Validates that the provided URL has a valid protocol and hostname.
 */
export function validateBackendUrl(url: string): { valid: boolean; error?: string } {
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    return {
      valid: false,
      error: 'Backend URL is missing. Set EXPO_PUBLIC_BACKEND_URL in your mobile/.env file (e.g. http://192.168.1.50:8000).'
    };
  }

  const normalized = normalizeBaseUrl(url);

  try {
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        valid: false,
        error: `Invalid protocol "${parsed.protocol}". Backend URL must start with http:// or https://.`
      };
    }
    if (!parsed.hostname) {
      return {
        valid: false,
        error: 'Backend URL must include a valid host or IP address.'
      };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Malformed backend URL "${url}": ${(err as Error).message}`
    };
  }
}

/**
 * Resolves the backend base URL.
 * In development, if EXPO_PUBLIC_BACKEND_URL is not provided, defaults to http://localhost:8000
 * but warns if running on a native device where localhost is unreachable.
 */
export function getBackendUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
  const rawUrl = envUrl || DEFAULT_DEV_FALLBACK_URL;
  const validation = validateBackendUrl(rawUrl);

  if (!validation.valid) {
    throw new Error(`[JustShare Config] ${validation.error}`);
  }

  return normalizeBaseUrl(rawUrl);
}

export function getConfig(): AppConfig {
  const backendUrl = getBackendUrl();
  return {
    backendUrl,
    apiBaseUrl: `${backendUrl}/api/v1`,
  };
}
