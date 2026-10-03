import { AppScreen } from '../types';

export interface PeerLeftContext {
  screen: AppScreen;
  isSenderCompleted?: boolean;
  receiverState?: string;
  assembledFilesCount?: number;
  totalFilesCount?: number;
}

export type PeerLeftDecision =
  | { action: 'fail'; error: string }
  | { action: 'ignore' }
  | { action: 'go_home'; error: string };

/**
 * Pure decision helper for peer_left events.
 * Determines whether a peer disconnection should transition to 'failed' (interrupted transfer),
 * be ignored (transfer already completed or terminal), or return to 'home' (pre-transfer pairing/idle).
 */
export function decidePeerLeftAction(ctx: PeerLeftContext): PeerLeftDecision {
  const { screen, isSenderCompleted, receiverState, assembledFilesCount, totalFilesCount } = ctx;

  // 1. If already on completed screen or sender has completed successfully, ignore peer_left
  if (screen === 'completed' || isSenderCompleted) {
    return { action: 'ignore' };
  }

  // 2. If receiver has finished verifying all files (e.g. before TRANSFER_END arrived) or is completed
  if (
    receiverState === 'completed' ||
    (typeof totalFilesCount === 'number' &&
      totalFilesCount > 0 &&
      typeof assembledFilesCount === 'number' &&
      assembledFilesCount >= totalFilesCount)
  ) {
    return { action: 'ignore' };
  }

  // 3. If already in a terminal failure/cancelled state, ignore subsequent peer_left
  if (screen === 'failed' || screen === 'cancelled') {
    return { action: 'ignore' };
  }

  // 4. If an active transfer is in progress, fail with a clear interruption message
  if (screen === 'transfer') {
    return { action: 'fail', error: 'Peer disconnected - transfer interrupted' };
  }

  // 5. Pre-transfer states ('home', 'send', 'receive')
  return { action: 'go_home', error: 'Peer disconnected' };
}
