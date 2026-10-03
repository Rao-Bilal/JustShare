import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateSessionState } from './api';

describe('updateSessionState Throttling and Deduplication', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('sends the first state update immediately and deduplicates identical calls', async () => {
    const fetchCalls: { path: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, options?: unknown) => {
      const opt = options as RequestInit;
      fetchCalls.push({ path: String(url), body: String(opt?.body) });
      return {
        ok: true,
        json: async () => ({ session_id: 'sess-1', state: JSON.parse(String(opt?.body)).state }),
      } as Response;
    });

    const token = 'token-123';
    const sessionId = 'session-123';

    // Call 1: Immediate send
    await updateSessionState(token, sessionId, 'TRANSFERRING');
    expect(fetchCalls.length).toBe(1);
    expect(JSON.parse(fetchCalls[0].body)).toEqual({ state: 'TRANSFERRING' });

    // Call 2: Identical state immediately after -> deduplicated / no-op
    await updateSessionState(token, sessionId, 'TRANSFERRING');
    expect(fetchCalls.length).toBe(1);

    // Advance 5 seconds
    vi.advanceTimersByTime(5000);
    expect(fetchCalls.length).toBe(1);
  });

  it('throttles intermediate rapid state updates to at most 1/s and executes trailing flush', async () => {
    const fetchCalls: { path: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, options?: unknown) => {
      const opt = options as RequestInit;
      fetchCalls.push({ path: String(url), body: String(opt?.body) });
      return {
        ok: true,
        json: async () => ({ session_id: 'sess-2', state: JSON.parse(String(opt?.body)).state }),
      } as Response;
    });

    const token = 'token-456';
    const sessionId = 'session-456';

    // 1st update: Immediate
    await updateSessionState(token, sessionId, 'CONNECTING');
    expect(fetchCalls.length).toBe(1);
    expect(JSON.parse(fetchCalls[0].body)).toEqual({ state: 'CONNECTING' });

    // 2nd update 100ms later: Throttled, scheduled as trailing flush
    vi.advanceTimersByTime(100);
    await updateSessionState(token, sessionId, 'TRANSFERRING');
    expect(fetchCalls.length).toBe(1); // Still 1

    // Advance past 1000ms window: Trailing flush fires
    vi.advanceTimersByTime(1000);
    expect(fetchCalls.length).toBe(2);
    expect(JSON.parse(fetchCalls[1].body)).toEqual({ state: 'TRANSFERRING' });
  });

  it('always sends terminal / final state (COMPLETED, FAILED, CANCELLED) immediately without dropping', async () => {
    const fetchCalls: { path: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, options?: unknown) => {
      const opt = options as RequestInit;
      fetchCalls.push({ path: String(url), body: String(opt?.body) });
      return {
        ok: true,
        json: async () => ({ session_id: 'sess-3', state: JSON.parse(String(opt?.body)).state }),
      } as Response;
    });

    const token = 'token-789';
    const sessionId = 'session-789';

    // 1st update: VERIFYING
    await updateSessionState(token, sessionId, 'VERIFYING');
    expect(fetchCalls.length).toBe(1);

    // 200ms later: Terminal state COMPLETED arrives -> must flush immediately without waiting 1s
    vi.advanceTimersByTime(200);
    await updateSessionState(token, sessionId, 'COMPLETED');
    expect(fetchCalls.length).toBe(2);
    expect(JSON.parse(fetchCalls[1].body)).toEqual({ state: 'COMPLETED' });
  });

  it('cancels pending trailing flush and ignores subsequent late non-terminal updates after terminal state', async () => {
    const fetchCalls: { path: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, options?: unknown) => {
      const opt = options as RequestInit;
      fetchCalls.push({ path: String(url), body: String(opt?.body) });
      return {
        ok: true,
        json: async () => ({ session_id: 'sess-term', state: JSON.parse(String(opt?.body)).state }),
      } as Response;
    });

    const token = 'token-term';
    const sessionId = 'session-term';

    // 1st update: Immediate CONNECTING
    await updateSessionState(token, sessionId, 'CONNECTING');
    expect(fetchCalls.length).toBe(1);

    // 2nd update 100ms later: TRANSFERRING (scheduled in trailing flush)
    vi.advanceTimersByTime(100);
    await updateSessionState(token, sessionId, 'TRANSFERRING');
    expect(fetchCalls.length).toBe(1);

    // 3rd update 100ms later: FAILED (terminal state)
    vi.advanceTimersByTime(100);
    await updateSessionState(token, sessionId, 'FAILED');
    expect(fetchCalls.length).toBe(2);
    expect(JSON.parse(fetchCalls[1].body)).toEqual({ state: 'FAILED' });

    // Late non-terminal update arrives after terminal state (e.g. late progress tick)
    vi.advanceTimersByTime(100);
    await updateSessionState(token, sessionId, 'TRANSFERRING');

    // Advance 5 seconds to ensure trailing timer was cancelled and no new calls fire
    vi.advanceTimersByTime(5000);
    expect(fetchCalls.length).toBe(2);
    expect(JSON.parse(fetchCalls[fetchCalls.length - 1].body)).toEqual({ state: 'FAILED' });
  });

  it('does not suppress retry if PATCH fails', async () => {
    let shouldFail = true;
    const fetchCalls: { path: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, options?: unknown) => {
      const opt = options as RequestInit;
      fetchCalls.push({ path: String(url), body: String(opt?.body) });
      if (shouldFail) {
        throw new Error('Network error');
      }
      return {
        ok: true,
        json: async () => ({ session_id: 'sess-fail', state: JSON.parse(String(opt?.body)).state }),
      } as Response;
    });

    const token = 'token-fail';
    const sessionId = 'session-fail';

    // 1st attempt: fails with error
    await expect(updateSessionState(token, sessionId, 'TRANSFERRING')).rejects.toThrow('Network error');
    expect(fetchCalls.length).toBe(1);

    // Allow second attempt to succeed
    shouldFail = false;
    vi.advanceTimersByTime(1100);

    // Retry sending same state 'TRANSFERRING' - must NOT be deduplicated / suppressed
    await updateSessionState(token, sessionId, 'TRANSFERRING');
    expect(fetchCalls.length).toBe(2);
    expect(JSON.parse(fetchCalls[1].body)).toEqual({ state: 'TRANSFERRING' });
  });
});
