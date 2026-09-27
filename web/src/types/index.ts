export type AppScreen = 'home' | 'send' | 'receive' | 'transfer' | 'completed' | 'failed' | 'cancelled';

export type SessionState = 'WAITING_FOR_PEER' | 'PAIRED' | 'AWAITING_APPROVAL' | 'CONNECTING' | 'TRANSFERRING' | 'VERIFYING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'FAILED' | 'EXPIRED';

export interface DeviceInfo {
  device_id: string;
  display_name: string;
}

export interface FileInfo {
  id: string;
  name: string;
  size: number;
  type: string;
}

export interface SessionInfo {
  session_id: string;
  pairing_code: string;
  expires_at: string;
  state: SessionState;
  sender?: DeviceInfo;
  receiver?: DeviceInfo;
}

export interface TransferProgress {
  currentFile: string;
  currentFileIndex: number;
  totalFiles: number;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speed: number; // bytes per second
  eta: number; // seconds remaining
  state: 'sending' | 'receiving' | 'verifying' | 'completed' | 'failed' | 'cancelled';
}
