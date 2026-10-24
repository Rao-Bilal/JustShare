/**
 * Typed API Client for JustShare Mobile.
 *
 * Provides request timeout handling, typed error responses,
 * X-Request-ID tracking, and device registration.
 */
import { getConfig } from '../config';

export interface ApiErrorDetail {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  public status: number;
  public code: string;
  public details?: unknown;
  public requestId?: string;

  constructor(status: number, message: string, code = 'API_ERROR', details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export interface DeviceCreatePayload {
  display_name: string;
}

export interface DeviceResponse {
  device_id: string;
  display_name: string;
  token: string;
}

const DEFAULT_TIMEOUT_MS = 10000;

function generateRequestId(): string {
  return 'req_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

/**
 * Universal fetch wrapper with timeout, typed error handling, and X-Request-ID.
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<{ data: T; requestId: string }> {
  const { apiBaseUrl } = getConfig();
  const url = `${apiBaseUrl}${endpoint}`;
  const requestId = generateRequestId();

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-ID': requestId,
    ...(options.headers as Record<string, string> | undefined),
  };

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timer);

    let body: any = null;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      body = await response.json().catch(() => null);
    }

    if (!response.ok) {
      const errorMessage =
        body?.detail?.message ||
        body?.detail ||
        body?.message ||
        `Request failed with status ${response.status} (${response.statusText})`;
      const errorCode = body?.detail?.code || body?.code || `HTTP_${response.status}`;

      throw new ApiError(response.status, String(errorMessage), String(errorCode), body, requestId);
    }

    return { data: body as T, requestId };
  } catch (err) {
    clearTimeout(timer);

    if (err instanceof ApiError) {
      throw err;
    }

    if ((err as Error)?.name === 'AbortError') {
      throw new ApiError(
        408,
        `Network request timed out after ${timeoutMs}ms. Please check your backend connection and PC firewall.`,
        'REQUEST_TIMEOUT',
        undefined,
        requestId
      );
    }

    throw new ApiError(
      0,
      `Cannot connect to backend server at ${url}. Details: ${(err as Error).message}`,
      'NETWORK_FAILURE',
      err,
      requestId
    );
  }
}

/**
 * Registers a new device with the backend.
 * POST /api/v1/devices
 */
export async function registerDevice(
  displayName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<DeviceResponse> {
  const payload: DeviceCreatePayload = { display_name: displayName };
  const res = await request<DeviceResponse>(
    '/devices',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    timeoutMs
  );
  return res.data;
}

export interface SessionResponse {
  session_id: string;
  pairing_code: string;
  expires_at: string;
  state: string;
}

export interface JoinSessionResponse {
  session_id: string;
  state: string;
  sender: {
    device_id: string;
    display_name: string;
  };
}

/**
 * Creates a new transfer session and returns a 6-digit pairing code.
 * POST /api/v1/sessions
 */
export async function createSession(
  token: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<SessionResponse> {
  const res = await request<SessionResponse>(
    '/sessions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    },
    timeoutMs
  );
  return res.data;
}

/**
 * Joins an existing transfer session using a 6-digit pairing code.
 * POST /api/v1/sessions/join
 */
export async function joinSession(
  token: string,
  pairingCode: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<JoinSessionResponse> {
  const res = await request<JoinSessionResponse>(
    '/sessions/join',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pairing_code: pairingCode }),
    },
    timeoutMs
  );
  return res.data;
}

/**
 * Updates session state.
 * PATCH /api/v1/sessions/:id/state
 */
export async function updateSessionState(
  token: string,
  sessionId: string,
  state: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<{ session_id: string; state: string } | null> {
  try {
    const res = await request<{ session_id: string; state: string }>(
      `/sessions/${sessionId}/state`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ state }),
      },
      timeoutMs
    );
    return res.data;
  } catch (err) {
    console.warn('[API] updateSessionState failed:', err);
    return null;
  }
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Fetches short-lived TURN credentials from Cloudflare.
 * POST /api/v1/turn/credentials
 */
export async function getTurnCredentials(
  token: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<IceServerConfig[]> {
  try {
    const res = await request<{ iceServers: IceServerConfig[] }>(
      '/turn/credentials',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      timeoutMs
    );
    return res.data?.iceServers || [];
  } catch (err) {
    console.warn('[TURN] Failed to fetch TURN credentials, fallback to STUN-only:', err instanceof Error ? err.message : 'Unknown error');
    return [];
  }
}



