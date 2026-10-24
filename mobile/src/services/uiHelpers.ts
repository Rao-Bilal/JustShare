/**
 * UI State & Role helpers for JustShare Mobile.
 * Pure utility functions with strict role guards and formatting.
 */
import { NativeFile } from '../types/transfer';

export type UserRole = 'sender' | 'receiver' | 'idle';

export interface VisibleControls {
  canPickFiles: boolean;
  canSendFiles: boolean;
  canAcceptTransfer: boolean;
  canDeclineTransfer: boolean;
  showPairingCodeGenerator: boolean;
  showPairingCodeInput: boolean;
  roleBadgeText: string;
}

/**
 * Enforces strict role-based control visibility.
 * Creator of code = sender; joiner = receiver.
 * Receiver NEVER renders file picking or send controls.
 */
export function getVisibleControlsForRole(role: UserRole, isPeerConnected: boolean): VisibleControls {
  if (role === 'sender') {
    return {
      canPickFiles: isPeerConnected,
      canSendFiles: isPeerConnected,
      canAcceptTransfer: false,
      canDeclineTransfer: false,
      showPairingCodeGenerator: !isPeerConnected,
      showPairingCodeInput: false,
      roleBadgeText: 'Sender',
    };
  }

  if (role === 'receiver') {
    return {
      canPickFiles: false,
      canSendFiles: false,
      canAcceptTransfer: true,
      canDeclineTransfer: true,
      showPairingCodeGenerator: false,
      showPairingCodeInput: !isPeerConnected,
      roleBadgeText: 'Receiver',
    };
  }

  return {
    canPickFiles: false,
    canSendFiles: false,
    canAcceptTransfer: false,
    canDeclineTransfer: false,
    showPairingCodeGenerator: true,
    showPairingCodeInput: true,
    roleBadgeText: 'Idle',
  };
}

/**
 * Truncates filename in the middle for clean display in cards and list rows.
 */
export function truncateFilename(name: string, maxLength: number = 24): string {
  if (!name || name.length <= maxLength) return name;
  const charsToShow = maxLength - 3;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return `${name.slice(0, frontChars)}...${name.slice(-backChars)}`;
}

/**
 * Formats bytes into human-readable strings (B, KB, MB, GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0 || !Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const clampedIndex = Math.min(i, units.length - 1);
  const formatted = (bytes / Math.pow(1024, clampedIndex)).toFixed(clampedIndex === 0 ? 0 : 1);
  return `${formatted} ${units[clampedIndex]}`;
}

/**
 * Computes progress percentage clamped between 0 and 100.
 */
export function calculateProgressPercentage(transferred: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((transferred / total) * 100)));
}

/**
 * Guard that ensures a send action cannot run unless the client is currently a Sender.
 */
export function assertCanSend(role: UserRole, files: NativeFile[]): { allowed: boolean; reason?: string } {
  if (role !== 'sender') {
    return { allowed: false, reason: 'Receivers cannot initiate file transfers' };
  }
  if (!files || files.length === 0) {
    return { allowed: false, reason: 'Choose files first' };
  }
  return { allowed: true };
}
