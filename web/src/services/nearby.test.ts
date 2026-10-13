import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from './api';
import {
  NearbyDiscoveryManager,
  detectDeviceType,
} from './nearby';

// In-memory localStorage mock
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, String(value));
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
};
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

function createMockJwt(expSecondsFromNow: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  const payload = btoa(JSON.stringify({ device_id: 'dev-123', exp }));
  const signature = 'mock_signature';
  return `${header}.${payload}.${signature}`;
}

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState: number = WebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 0);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }

  simulateServerMessage(msg: object) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(msg) });
    }
  }
}

describe('Nearby Discovery Service (WebSocket-based)', () => {
  beforeEach(() => {
    localStorageMock.clear();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.restoreAllMocks();
  });

  it('detects device type accurately', () => {
    const type = detectDeviceType();
    expect(['computer', 'phone', 'tablet']).toContain(type);
  });

  it('initializes with idle status and empty devices list', () => {
    const manager = new NearbyDiscoveryManager();
    expect(manager.getStatus()).toBe('idle');
    expect(manager.getDiscoveredDevices()).toEqual([]);
  });

  it('starts discovery and announces presence with valid token', async () => {
    const validToken = createMockJwt(3600);
    const manager = new NearbyDiscoveryManager();
    await manager.startDiscovery(validToken, 'My Device');

    expect(manager.getStatus()).toBe('searching');
    expect(MockWebSocket.instances.length).toBe(1);
    const ws = MockWebSocket.instances[0];

    // Wait for ws open event
    await new Promise((r) => setTimeout(r, 10));

    expect(ws.sentMessages.length).toBe(1);
    const parsed = JSON.parse(ws.sentMessages[0]);
    expect(parsed.type).toBe('nearby_announce');
    expect(parsed.payload.display_name).toBe('My Device');
  });

  it('transparently replaces expired token before connecting', async () => {
    const expiredToken = createMockJwt(-100);
    const freshToken = createMockJwt(3600);

    const createDeviceSpy = vi.spyOn(api, 'createDevice').mockResolvedValue({
      device_id: 'fresh-dev',
      display_name: 'Bilal-Phone',
      token: freshToken,
    });

    let notifiedToken: string | null = null;
    const manager = new NearbyDiscoveryManager({
      onTokenRefreshed: (tok) => {
        notifiedToken = tok;
      },
    });

    await manager.startDiscovery(expiredToken, 'Bilal-Phone');

    expect(createDeviceSpy).toHaveBeenCalledWith('Bilal-Phone');
    expect(notifiedToken).toBe(freshToken);
    expect(MockWebSocket.instances.length).toBe(1);
    expect(MockWebSocket.instances[0].url).toContain(encodeURIComponent(freshToken));
  });

  it('handles UNAUTHORIZED websocket error by refreshing and reconnecting once (bounded retry)', async () => {
    const initiallyValidToken = createMockJwt(3600);
    const freshToken = createMockJwt(7200);

    const createDeviceSpy = vi.spyOn(api, 'createDevice').mockResolvedValue({
      device_id: 'reauthed-dev',
      display_name: 'Test-Device',
      token: freshToken,
    });

    let refreshedToken: string | null = null;
    const manager = new NearbyDiscoveryManager({
      onTokenRefreshed: (tok) => {
        refreshedToken = tok;
      },
    });

    await manager.startDiscovery(initiallyValidToken, 'Test-Device');
    expect(MockWebSocket.instances.length).toBe(1);
    const ws1 = MockWebSocket.instances[0];

    // Simulate backend sending 403 / UNAUTHORIZED error
    ws1.simulateServerMessage({
      type: 'error',
      payload: {
        code: 'UNAUTHORIZED',
        message: 'Invalid token',
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(createDeviceSpy).toHaveBeenCalledWith('Test-Device');
    expect(refreshedToken).toBe(freshToken);
    // Verified it reconnected with new token
    expect(MockWebSocket.instances.length).toBe(2);
    expect(MockWebSocket.instances[1].url).toContain(encodeURIComponent(freshToken));
  });

  it('updates device list when receiving nearby_peer_list', async () => {
    let updatedDevices: unknown[] = [];
    const manager = new NearbyDiscoveryManager({
      onDeviceListUpdate: (devs) => {
        updatedDevices = devs;
      },
    });

    const validToken = createMockJwt(3600);
    await manager.startDiscovery(validToken, 'My Laptop');
    const ws = MockWebSocket.instances[0];
    await new Promise((r) => setTimeout(r, 10));

    // Simulate server peer list
    ws.simulateServerMessage({
      type: 'nearby_peer_list',
      payload: {
        peers: [
          {
            ephemeral_id: 'peer_abc123',
            display_name: "Bilal's Phone",
            device_type: 'phone',
          },
        ],
      },
    });

    expect(manager.getStatus()).toBe('found');
    expect(manager.getDiscoveredDevices().length).toBe(1);
    expect(updatedDevices.length).toBe(1);
    expect(manager.getDiscoveredDevices()[0].name).toBe("Bilal's Phone");
  });

  it('handles incoming pair requests and accept flow', async () => {
    let incomingReq: unknown = null;
    const manager = new NearbyDiscoveryManager({
      onIncomingRequest: (req) => {
        incomingReq = req;
      },
    });

    const validToken = createMockJwt(3600);
    await manager.startDiscovery(validToken, 'My Device');
    const ws = MockWebSocket.instances[0];
    await new Promise((r) => setTimeout(r, 10));

    // Simulate incoming pair request from peer
    ws.simulateServerMessage({
      type: 'nearby_incoming_request',
      payload: {
        request_id: 'req_xyz789',
        from_device: {
          ephemeral_id: 'peer_def456',
          display_name: 'Sender Phone',
          device_type: 'phone',
        },
      },
    });

    expect(manager.getStatus()).toBe('incoming_request');
    expect(incomingReq).not.toBeNull();

    // Accept request
    manager.acceptIncomingRequest();
    const lastSent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(lastSent.type).toBe('nearby_response');
    expect(lastSent.payload.request_id).toBe('req_xyz789');
    expect(lastSent.payload.accepted).toBe(true);
  });

  it('handles pair request rejection', async () => {
    const manager = new NearbyDiscoveryManager();
    const validToken = createMockJwt(3600);
    await manager.startDiscovery(validToken, 'My Device');
    const ws = MockWebSocket.instances[0];
    await new Promise((r) => setTimeout(r, 10));

    // Peer declines connection
    ws.simulateServerMessage({
      type: 'nearby_rejected',
      payload: {
        request_id: 'req_123',
      },
    });

    expect(manager.getStatus()).toBe('rejected');
  });

  it('handles nearby_paired event', async () => {
    let pairedData: unknown = null;
    const manager = new NearbyDiscoveryManager({
      onPaired: (data) => {
        pairedData = data;
      },
    });

    const validToken = createMockJwt(3600);
    await manager.startDiscovery(validToken, 'My Device');
    const ws = MockWebSocket.instances[0];
    await new Promise((r) => setTimeout(r, 10));

    ws.simulateServerMessage({
      type: 'nearby_paired',
      payload: {
        session_id: 'sess_12345',
        pairing_code: '123456',
        role: 'receiver',
        peer_ephemeral_id: 'peer_abc',
      },
    });

    expect(manager.getStatus()).toBe('paired');
    expect(pairedData).not.toBeNull();
  });
});
