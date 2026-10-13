import { COPY } from '../copy';

export interface FriendlyError {
  headline: string;
  cause: string;
  nextStep: string;
  rawDetails?: string;
}

export function mapTechnicalError(rawError?: string | null): FriendlyError {
  if (!rawError) {
    return {
      ...COPY.errors.default,
    };
  }

  const err = rawError.toLowerCase();

  if (err.includes('disconnect') || err.includes('peer left') || err.includes('closed') || err.includes('connection lost')) {
    return {
      ...COPY.errors.peerDisconnected,
      rawDetails: rawError,
    };
  }

  if (err.includes('expired') || err.includes('expir')) {
    return {
      ...COPY.errors.sessionExpired,
      rawDetails: rawError,
    };
  }

  if (err.includes('not found') || err.includes('invalid') || err.includes('404')) {
    return {
      ...COPY.errors.sessionNotFound,
      rawDetails: rawError,
    };
  }

  if (err.includes('full') || err.includes('already in use') || err.includes('409')) {
    return {
      ...COPY.errors.sessionFull,
      rawDetails: rawError,
    };
  }

  if (err.includes('integrity') || err.includes('hash') || err.includes('mismatch') || err.includes('sha-256')) {
    return {
      ...COPY.errors.integrityFailed,
      rawDetails: rawError,
    };
  }

  if (err.includes('cancel')) {
    return {
      ...COPY.errors.transferCancelled,
      rawDetails: rawError,
    };
  }

  return {
    ...COPY.errors.default,
    rawDetails: rawError,
  };
}

export function truncateMiddle(str: string, maxLength: number = 32): string {
  if (!str || str.length <= maxLength) return str;
  const charsToShow = maxLength - 3;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return `${str.slice(0, frontChars)}...${str.slice(-backChars)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const remainingSecs = Math.round(seconds % 60);
  return `${mins}m ${remainingSecs}s`;
}
