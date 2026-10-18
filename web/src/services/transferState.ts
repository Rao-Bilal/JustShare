import { AppScreen } from '../types';

export type MainView = 'home' | 'transfer';

/**
 * Maps the application screen and transfer progress state to the top-level main view.
 * 
 * Rules:
 * - Home screen stays visible during: idle, creating session, showing code/QR,
 *   waiting for the other device, device connected, selecting files, waiting for the file list.
 * - Transfer screen replaces the whole page ONLY when an actual transfer starts:
 *   on the sender when sending begins, on the receiver when incoming file(s) begin to arrive.
 * - It stays through verifying, completed, failed, cancelled, and peer-left states.
 */
export function mapScreenToMainView(screen: AppScreen): MainView {
  switch (screen) {
    case 'home':
    case 'send':
    case 'receive':
      return 'home';
    case 'transfer':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return 'transfer';
    default:
      return 'home';
  }
}
