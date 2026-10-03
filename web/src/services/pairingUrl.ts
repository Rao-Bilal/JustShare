/**
 * Pairing URL builder, parser, and localhost detection utilities.
 * Encodes pairing codes in URL hash fragments (#code=123456) to enable instant QR auto-joining.
 */

export function isLocalhostHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().trim();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

/**
 * Builds the join URL for QR code generation.
 * Format: <origin>/#code=<6-digit-code>
 * Prioritizes optional env override VITE_PUBLIC_ORIGIN if set.
 */
export function buildPairingUrl(origin: string, pairingCode: string, envOrigin?: string): string {
  const baseOrigin = (envOrigin || origin || '').replace(/\/+$/, '');
  const cleanCode = pairingCode.trim();
  return `${baseOrigin}/#code=${cleanCode}`;
}

/**
 * Parses and validates a 6-digit numeric pairing code from a hash string.
 * Returns the 6-digit string if valid, or null otherwise.
 */
export function parsePairingCodeFromHash(hash: string): string | null {
  if (!hash) return null;
  const cleanHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(cleanHash);
  const codeParam = params.get('code');

  if (!codeParam) {
    // If raw hash is exactly 6 digits
    if (/^\d{6}$/.test(cleanHash)) {
      return cleanHash;
    }
    return null;
  }

  const trimmed = codeParam.trim();
  if (/^\d{6}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export type InitialUrlDecision =
  | { action: 'join'; code: string }
  | { action: 'error'; message: string }
  | { action: 'none' };

/**
 * Pure decision helper for evaluating initial URL hash on app mount.
 */
export function determineInitialUrlAction(hash: string): InitialUrlDecision {
  if (!hash || hash === '#' || hash === '') {
    return { action: 'none' };
  }

  const cleanHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(cleanHash);

  if (params.has('code')) {
    const rawVal = params.get('code');
    if (rawVal && /^\d{6}$/.test(rawVal.trim())) {
      return { action: 'join', code: rawVal.trim() };
    }
    return { action: 'error', message: 'Invalid pairing code in link: must be 6 digits' };
  }

  // Check if raw hash without param name is digits or attempted code
  if (/^\d{6}$/.test(cleanHash.trim())) {
    return { action: 'join', code: cleanHash.trim() };
  }

  if (cleanHash.startsWith('code=')) {
    return { action: 'error', message: 'Invalid pairing code in link: must be 6 digits' };
  }

  return { action: 'none' };
}
