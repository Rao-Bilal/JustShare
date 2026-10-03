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

interface SessionStateUpdaterQueue {
  lastState: string | null;
  lastSentTime: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  pendingState: string | null;
  isTerminal: boolean;
}

const sessionStateQueues = new Map<string, SessionStateUpdaterQueue>();

const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED'];

export async function updateSessionState(token: string, sessionId: string, state: string): Promise<{ session_id: string; state: string } | null> {
  const queueKey = `${sessionId}:${token}`;
  let queue = sessionStateQueues.get(queueKey);
  if (!queue) {
    queue = {
      lastState: null,
      lastSentTime: 0,
      pendingTimer: null,
      pendingState: null,
      isTerminal: false,
    };
    sessionStateQueues.set(queueKey, queue);
  }

  const isTerminal = TERMINAL_STATES.includes(state);

  // If session is already in a terminal state, ignore late non-terminal updates
  if (queue.isTerminal && !isTerminal) {
    return null;
  }

  // If state is identical to last successfully dispatched state, no-op immediately
  if (queue.lastState === state) {
    return null;
  }

  const now = Date.now();
  const timeSinceLast = now - queue.lastSentTime;

  const performPatch = async (stateToSend: string) => {
    if (queue!.pendingTimer) {
      clearTimeout(queue!.pendingTimer);
      queue!.pendingTimer = null;
    }
    queue!.pendingState = null;
    queue!.lastSentTime = Date.now();

    const res = await request<{ session_id: string; state: string }>(
      `/api/v1/sessions/${sessionId}/state`,
      {
        method: 'PATCH',
        body: JSON.stringify({ state: stateToSend }),
      },
      token
    );
    queue!.lastState = stateToSend;
    if (TERMINAL_STATES.includes(stateToSend)) {
      queue!.isTerminal = true;
    }
    return res;
  };

  // Immediate send if:
  // 1. More than 1000ms elapsed since last send, OR
  // 2. Terminal state, OR
  // 3. State has transitioned and nothing is currently cooling down
  if (timeSinceLast >= 1000 || isTerminal) {
    return performPatch(state);
  }

  // Otherwise schedule a trailing flush at the end of the 1s window (at most 1/s)
  queue.pendingState = state;
  if (!queue.pendingTimer) {
    const delay = Math.max(50, 1000 - timeSinceLast);
    queue.pendingTimer = setTimeout(() => {
      if (queue && queue.pendingState) {
        const nextState = queue.pendingState;
        performPatch(nextState).catch((err) => {
          console.error('[API] Failed to update session state in trailing flush:', err);
        });
      }
    }, delay);
  }

  return null;
}
