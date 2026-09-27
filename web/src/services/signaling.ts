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
        if (msg.type === 'signal' && msg.payload && msg.payload.signal_type) {
          console.log(`[SIGNAL] Received message type: ${msg.type} (${msg.payload.signal_type})`);
        } else {
          console.log(`[SIGNAL] Received message type: ${msg.type}`);
        }
        const callbacks = this.listeners.get(msg.type) || [];
        callbacks.forEach((cb) => cb(msg));
      } catch (err) {
        console.error('[SIGNAL] Failed to parse WebSocket message', err);
      }
    };
  }

  send(message: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msgObj = message as { type?: string; payload?: { signal_type?: string } };
      if (msgObj.type === 'signal' && msgObj.payload && msgObj.payload.signal_type) {
        console.log(`[SIGNAL] Sending message type: ${msgObj.type} (${msgObj.payload.signal_type})`);
      } else {
        console.log(`[SIGNAL] Sending message type: ${msgObj.type}`);
      }
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
