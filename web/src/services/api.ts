const API_BASE = '';

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let errorMessage = 'API request failed';
    try {
      const errData = await res.json();
      errorMessage = errData.error?.message || errData.detail || errorMessage;
    } catch {
      // Ignore JSON parse errors for error responses
    }
    throw new Error(errorMessage);
  }

  return res.json();
}

export async function createDevice(displayName: string) {
  return request<{ device_id: string; display_name: string; token: string }>(
    '/api/v1/devices',
    {
      method: 'POST',
      body: JSON.stringify({ display_name: displayName }),
    }
  );
}

export async function createSession(token: string) {
  return request<{ session_id: string; pairing_code: string; expires_at: string; state: string }>(
    '/api/v1/sessions',
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
    token
  );
}

export async function joinSession(token: string, pairingCode: string) {
  return request<{ session_id: string; state: string; sender: { device_id: string; display_name: string } }>(
    '/api/v1/sessions/join',
    {
      method: 'POST',
      body: JSON.stringify({ pairing_code: pairingCode }),
    },
    token
  );
}

export async function getSession(token: string, sessionId: string) {
  return request<{
    session_id: string;
    state: string;
    sender: { device_id: string; display_name: string };
    receiver: { device_id: string; display_name: string } | null;
    created_at: string;
    expires_at: string;
  }>(`/api/v1/sessions/${sessionId}`, { method: 'GET' }, token);
}

export async function updateSessionState(token: string, sessionId: string, state: string) {
  return request<{ session_id: string; state: string }>(
    `/api/v1/sessions/${sessionId}/state`,
    {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    },
    token
  );
}
