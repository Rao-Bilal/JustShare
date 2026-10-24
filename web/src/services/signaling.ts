export type SignalCallback = (data: unknown) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private listeners: Map<string, SignalCallback[]> = new Map();
  private sendQueue: object[] = [];

  connect(sessionId: string, token: string): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${protocol}//${host}/ws/v1/signal/${sessionId}?token=${encodeURIComponent(token)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[SIGNAL] WebSocket connected');
      // Flush any queued messages
      while (this.sendQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
        const message = this.sendQueue.shift()!;
        this.send(message);
      }
      const callbacks = this.listeners.get('open') || [];
      callbacks.forEach((cb) => cb({}));
    };

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

    this.ws.onclose = (event) => {
      console.log(`[SIGNAL] WebSocket closed (code=${event.code})`);
      const callbacks = this.listeners.get('close') || [];
      callbacks.forEach((cb) => cb(event));
    };

    this.ws.onerror = (err) => {
      console.error('[SIGNAL] WebSocket error', err);
      const callbacks = this.listeners.get('error') || [];
      callbacks.forEach((cb) => cb(err));
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
    } else {
      console.log('[SIGNAL] WebSocket not open yet. Queuing message to send on open.');
      this.sendQueue.push(message);
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async waitForOpen(timeoutMs: number = 10000): Promise<void> {
    if (this.isOpen()) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Signaling WebSocket connection timed out'));
      }, timeoutMs);

      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error('Signaling WebSocket connection failed'));
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.off('open', onOpen);
        this.off('error', onError);
      };

      this.on('open', onOpen);
      this.on('error', onError);
    });
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
    this.sendQueue = [];
    this.listeners.clear();
  }
}
