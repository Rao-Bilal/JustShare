
import { wsBase } from './backend';

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

export type NearbyCallback = (payload: unknown) => void;

export class NearbySignalingClient {
  private ws: WebSocket | null = null;
  private listeners: Map<string, NearbyCallback[]> = new Map();
  private token: string = '';
  private isExplicitlyClosed: boolean = false;
  private pingInterval: number | null = null;

  connect(token: string): void {
    this.token = token;
    this.isExplicitlyClosed = false;

    const url = `${wsBase()}/ws/v1/nearby?token=${encodeURIComponent(token)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.emit('open', {});

      // Start 20-second keep-alive ping.
      if (typeof window !== 'undefined') {
        this.pingInterval = window.setInterval(() => {
          this.send('ping', {});
        }, 20000);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const callbacks = this.listeners.get(msg.type) || [];
        callbacks.forEach((cb) => cb(msg.payload || {}));
      } catch (err) {
        console.error('[NEARBY_SIGNAL] Failed to parse message', err);
      }
    };

    this.ws.onclose = () => {
      if (this.pingInterval !== null) {
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

  announce(displayName: string, deviceType: string): void {
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
    const callbacks = this.listeners.get(type);

    if (callbacks) {
      this.listeners.set(
        type,
        callbacks.filter((cb) => cb !== callback)
      );
    }
  }

  private emit(type: string, payload: unknown): void {
    const callbacks = this.listeners.get(type) || [];
    callbacks.forEach((cb) => cb(payload));
  }

  disconnect(): void {
    this.isExplicitlyClosed = true;

    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.listeners.clear();
  }
}
