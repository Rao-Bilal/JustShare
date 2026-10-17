/**
 * WebRTC Signaling Client for JustShare Mobile.
 * Connects to /ws/v1/signal/{sessionId}?token={token}.
 */
import { getConfig } from '../config';

export type SignalCallback = (data: any) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private listeners: Map<string, SignalCallback[]> = new Map();

  connect(sessionId: string, token: string): void {
    const { backendUrl } = getConfig();
    const wsBaseUrl = backendUrl.replace(/^http/, 'ws');
    const url = `${wsBaseUrl}/ws/v1/signal/${sessionId}?token=${encodeURIComponent(token)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.emit('open', {});
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const callbacks = this.listeners.get(msg.type) || [];
        callbacks.forEach((cb) => cb(msg));
      } catch (err) {
        console.warn('[SIGNAL] Failed to parse WebSocket message', err);
      }
    };

    this.ws.onclose = () => {
      this.emit('close', {});
    };

    this.ws.onerror = (err) => {
      this.emit('error', err);
    };
  }

  send(message: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  on(type: string, callback: SignalCallback): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(callback);
  }

  off(type: string, callback: SignalCallback): void {
    const callbacks = this.listeners.get(type);
    if (callbacks) {
      this.listeners.set(
        type,
        callbacks.filter((cb) => cb !== callback)
      );
    }
  }

  emit(type: string, payload: unknown): void {
    const callbacks = this.listeners.get(type) || [];
    callbacks.forEach((cb) => cb(payload));
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners.clear();
  }
}
