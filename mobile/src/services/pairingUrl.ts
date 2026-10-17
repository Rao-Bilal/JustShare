/**
 * Universal Pairing URL parser and builder for mobile and web cross-platform compatibility.
 * 
 * Supports:
 * 1. Web format: <origin>/#code=123456
 * 2. Query param format: <origin>/?code=123456
 * 3. Deep link format: justshare://pair?code=123456 or justshare://123456
 * 4. Raw 6-digit string: 123456
 */

/**
 * Extracts and validates a 6-digit numeric pairing code from any scanned string or URL.
 * Returns the sanitized 6-digit code, or null if the payload is invalid.
 */
export function extractPairingCode(data: string): string | null {
  if (!data || typeof data !== 'string') return null;
  const trimmed = data.trim();

  // Case 1: Raw 6 digits
  if (/^\d{6}$/.test(trimmed)) {
    return trimmed;
  }

  // Case 2: URL with hash fragment (#code=123456 or #123456)
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex !== -1) {
    const hash = trimmed.slice(hashIndex + 1);
    const hashParams = new URLSearchParams(hash);
    const codeFromHash = hashParams.get('code');
    if (codeFromHash && /^\d{6}$/.test(codeFromHash.trim())) {
      return codeFromHash.trim();
    }
    if (/^\d{6}$/.test(hash.trim())) {
      return hash.trim();
    }
  }

  // Case 3: URL with query parameter (?code=123456 or &code=123456)
  const queryMatch = trimmed.match(/[?&]code=(\d{6})(?:[&#]|$)/i);
  if (queryMatch) {
    return queryMatch[1];
  }

  // Case 4: General regex search for 6-digit code parameter
  const fallbackMatch = trimmed.match(/code[=:](\d{6})/i);
  if (fallbackMatch) {
    return fallbackMatch[1];
  }

  return null;
}

/**
 * Builds the canonical pairing URL for QR code generation.
 * Uses the hash fragment format (<origin>/#code=<6-digit-code>) which matches
 * the web client's pairingUrl.ts parser.
 */
export function buildMobilePairingUrl(baseUrl: string, pairingCode: string): string {
  const cleanBase = (baseUrl || '').trim().replace(/\/+$/, '');
  const cleanCode = pairingCode.trim();
  return `${cleanBase}/#code=${cleanCode}`;
}
