export type SignalCallback = (data: unknown) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private listeners: Map<string, SignalCallback[]> = new Map();

  connect(sessionId: string, token: string): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${protocol}//${host}/ws/v1/signal/${sessionId}?token=${encodeURIComponent(token)}`;

    this.ws = new WebSocket(url);

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const callbacks = this.listeners.get(msg.type) || [];
        callbacks.forEach((cb) => cb(msg));
      } catch {
        // Ignore malformed messages
      }
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

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners.clear();
  }
}
