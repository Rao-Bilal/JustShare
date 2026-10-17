/**
 * Nearby WebSocket Signaling Client for JustShare Mobile.
 * Connects to /ws/v1/nearby?token={token} to discover and pair with nearby devices.
 */
import { getConfig } from '../config';

export interface NearbyPeerInfo {
  ephemeral_id: string;
  display_name: string;
  device_type: string;
}

export interface NearbyIncomingRequestPayload {
  request_id: string;
  from_device: NearbyPeerInfo;
}

export interface NearbyPairedPayload {
  session_id: string;
  pairing_code: string;
  role: 'sender' | 'receiver';
  peer_ephemeral_id: string;
}

export type NearbyCallback = (payload: any) => void;

export class NearbySignalingClient {
  private ws: WebSocket | null = null;
  private listeners: Map<string, NearbyCallback[]> = new Map();
  private token: string = '';
  private isExplicitlyClosed: boolean = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  connect(token: string): void {
    this.token = token;
    this.isExplicitlyClosed = false;

    const { backendUrl } = getConfig();
    const wsBaseUrl = backendUrl.replace(/^http/, 'ws');
    const url = `${wsBaseUrl}/ws/v1/nearby?token=${encodeURIComponent(token)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.emit('open', {});
      // 20s keep-alive ping
      this.pingInterval = setInterval(() => {
        this.send('ping', {});
      }, 20000);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const callbacks = this.listeners.get(msg.type) || [];
        callbacks.forEach((cb) => cb(msg.payload || {}));
      } catch (err) {
        console.warn('[NEARBY_SIGNAL] Failed to parse message', err);
      }
    };

    this.ws.onclose = () => {
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      this.emit('close', {});
    };

    this.ws.onerror = (err) => {
      this.emit('error', err);
    };
  }

  send(type: string, payload: unknown = {}): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  announce(displayName: string, deviceType: string = 'phone'): void {
    this.send('nearby_announce', {
      display_name: displayName,
      device_type: deviceType,
    });
  }

  requestPair(targetEphemeralId: string): void {
    this.send('nearby_request', {
      target_id: targetEphemeralId,
    });
  }

  respondToRequest(requestId: string, accepted: boolean): void {
    this.send('nearby_response', {
      request_id: requestId,
      accepted,
    });
  }

  on(type: string, callback: NearbyCallback): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(callback);
  }

  off(type: string, callback: NearbyCallback): void {
    const list = this.listeners.get(type);
    if (list) {
      this.listeners.set(
        type,
        list.filter((cb) => cb !== callback)
      );
    }
  }

  emit(type: string, payload: unknown): void {
    const list = this.listeners.get(type) || [];
    list.forEach((cb) => cb(payload));
  }

  disconnect(): void {
    this.isExplicitlyClosed = true;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
