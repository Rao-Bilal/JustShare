import { describe, it, expect, vi } from 'vitest';
import { decidePeerLeftAction } from './peerLeft';
import { FileReceiver, FileSender } from './transfer';
import { MemoryTransferStorage } from './storage/memory';

class MockDataChannel {
  public readyState: RTCDataChannelState = 'open';
  public bufferedAmount = 0;
  public bufferedAmountLowThreshold = 0;
  public binaryType: BinaryType = 'arraybuffer';
  private listeners: Map<string, ((event: unknown) => void)[]> = new Map();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type);
    if (list) {
      this.listeners.set(
        type,
        list.filter((cb) => cb !== listener)
      );
    }
  }

  listenerCount(type?: string): number {
    if (type) {
      return this.listeners.get(type)?.length || 0;
    }
    let count = 0;
    for (const list of this.listeners.values()) {
      count += list.length;
    }
    return count;
  }

  dispatchEvent(type: string, eventData: unknown): void {
    const list = this.listeners.get(type);
    if (list) {
      list.forEach((cb) => cb(eventData));
    }
  }

  send(): void {
    // mock send
  }

  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent('close', {});
  }
}

describe('decidePeerLeftAction', () => {
  it('returns fail during active transfer on transfer screen', () => {
    const result = decidePeerLeftAction({
      screen: 'transfer',
      isSenderCompleted: false,
      assembledFilesCount: 0,
      totalFilesCount: 1,
    });
    expect(result).toEqual({
      action: 'fail',
      error: 'Peer disconnected - transfer interrupted',
    });
  });

  it('returns go_home for pre-transfer screens (home, send, receive)', () => {
    expect(decidePeerLeftAction({ screen: 'home' })).toEqual({
      action: 'go_home',
      error: 'Peer disconnected',
    });
    expect(decidePeerLeftAction({ screen: 'send' })).toEqual({
      action: 'go_home',
      error: 'Peer disconnected',
    });
    expect(decidePeerLeftAction({ screen: 'receive' })).toEqual({
      action: 'go_home',
      error: 'Peer disconnected',
    });
  });

  it('returns ignore when screen is completed', () => {
    const result = decidePeerLeftAction({
      screen: 'completed',
      assembledFilesCount: 1,
      totalFilesCount: 1,
    });
    expect(result).toEqual({ action: 'ignore' });
  });

  it('returns ignore when sender is already completed', () => {
    const result = decidePeerLeftAction({
      screen: 'transfer',
      isSenderCompleted: true,
    });
    expect(result).toEqual({ action: 'ignore' });
  });

  it('returns ignore when receiver has assembled all files before TRANSFER_END is processed', () => {
    const result = decidePeerLeftAction({
      screen: 'transfer',
      receiverState: 'receiving_file',
      assembledFilesCount: 3,
      totalFilesCount: 3,
    });
    expect(result).toEqual({ action: 'ignore' });
  });

  it('returns ignore when receiverState is completed', () => {
    const result = decidePeerLeftAction({
      screen: 'transfer',
      receiverState: 'completed',
      assembledFilesCount: 1,
      totalFilesCount: 1,
    });
    expect(result).toEqual({ action: 'ignore' });
  });

  it('returns fail when receiver only partially assembled files', () => {
    const result = decidePeerLeftAction({
      screen: 'transfer',
      receiverState: 'receiving_file',
      assembledFilesCount: 1,
      totalFilesCount: 2,
    });
    expect(result).toEqual({
      action: 'fail',
      error: 'Peer disconnected - transfer interrupted',
    });
  });

  it('returns ignore when already in failed or cancelled terminal state (first failure wins)', () => {
    expect(decidePeerLeftAction({ screen: 'failed' })).toEqual({ action: 'ignore' });
    expect(decidePeerLeftAction({ screen: 'cancelled' })).toEqual({ action: 'ignore' });
  });
});

describe('peer_left cleanup and error deduplication', () => {
  it('clears receiver stall timer and cancels receiver on peer_left without leaked timers or late onError', () => {
    vi.useFakeTimers();
    try {
      const dc = new MockDataChannel() as unknown as RTCDataChannel;
      const storage = new MemoryTransferStorage();
      const receiver = new FileReceiver(dc, { storage, stallTimeoutMs: 5000 });
      let errorCalled = false;
      receiver.onError = () => {
        errorCalled = true;
      };

      receiver.start();
      expect(receiver.getState()).toBe('waiting_for_manifest');

      // Peer disconnects: decision is 'fail', cancel receiver
      const decision = decidePeerLeftAction({ screen: 'transfer', receiverState: receiver.getState() });
      expect(decision.action).toBe('fail');
      receiver.cancel('Peer disconnected');
      expect(receiver.getState()).toBe('cancelled');

      // Advance clock past stall timeout limit
      vi.advanceTimersByTime(10000);

      // Stall timer must not have fired onError
      expect(errorCalled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears sender control and ACK timers on peer_left without duplicate error callbacks', async () => {
    const dc = new MockDataChannel() as unknown as RTCDataChannel;
    const file = new File(['test data'], 'test.txt', { type: 'text/plain' });
    const sender = new FileSender(dc, [file], { ackTimeoutMs: 5000 });

    const errors: string[] = [];
    sender.onError = (e) => {
      errors.push(e);
    };

    // Simulate active transfer cancelled due to peer_left
    sender.cancel('Peer disconnected');

    // Subsequent DataChannel close or events must not trigger late errors
    (dc as unknown as MockDataChannel).close();

    expect(errors.length).toBe(0);
  });

  it('first failure wins: late onError or DataChannel close does not overwrite peer_left interruption error', () => {
    let currentScreen = 'transfer';
    let currentError: string | null = null;

    const setError = (err: string | null) => {
      currentError = err;
    };
    const setScreen = (s: string) => {
      currentScreen = s;
    };

    // 1. peer_left arrives during active transfer
    const decision = decidePeerLeftAction({ screen: 'transfer' });
    expect(decision.action).toBe('fail');
    if (decision.action === 'fail') {
      setError(decision.error);
      setScreen('failed');
    }

    expect(currentScreen).toBe('failed');
    expect(currentError).toBe('Peer disconnected - transfer interrupted');

    // 2. Later, DataChannel close fires onError handler
    const onLaterError = (e: string) => {
      if (currentScreen === 'failed' || currentScreen === 'cancelled' || currentScreen === 'completed') {
        return;
      }
      setError(e);
      setScreen('failed');
    };

    onLaterError('DataChannel closed unexpectedly');
    onLaterError('Transfer timed out due to inactivity');

    // Error message must remain the original peer_left interruption message
    expect(currentScreen).toBe('failed');
    expect(currentError).toBe('Peer disconnected - transfer interrupted');
  });
});
