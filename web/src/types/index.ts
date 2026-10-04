export type AppScreen = 'home' | 'send' | 'receive' | 'transfer' | 'completed' | 'failed' | 'cancelled';

export type SessionState =
  | 'WAITING_FOR_PEER'
  | 'PAIRED'
  | 'AWAITING_APPROVAL'
  | 'CONNECTING'
  | 'TRANSFERRING'
  | 'PAUSED'
  | 'RESUMING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'FAILED'
  | 'EXPIRED';

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

export interface ManifestFileEntry {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  relativePath?: string;
  totalChunks: number;
  sha256: string;
}

export interface TransferManifest {
  transferId: string;
  totalFiles: number;
  totalSize: number;
  files: ManifestFileEntry[];
}

export type TransferMessageType =
  | 'TRANSFER_START'
  | 'FILE_START'
  | 'FILE_END'
  | 'FILE_ACK'
  | 'TRANSFER_END'
  | 'CANCEL'
  | 'ERROR'
  | 'RESUME_REQUEST'
  | 'RESUME_RESPONSE'
  | 'PREPARING';

export interface TransferStartMessage {
  type: 'TRANSFER_START';
  transferId: string;
  manifest: TransferManifest;
}

export interface FileStartMessage {
  type: 'FILE_START';
  transferId: string;
  fileId: string;
  name: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  sha256: string;
}

export interface FileEndMessage {
  type: 'FILE_END';
  transferId: string;
  fileId: string;
}

export interface FileVerifyingMessage {
  type: 'VERIFYING';
  transferId: string;
  fileId: string;
  progress?: number;
}

export interface PreparingMessage {
  type: 'PREPARING';
  transferId: string;
  progress?: number;
}

export interface FileAckMessage {
  type: 'FILE_ACK';
  transferId: string;
  fileId: string;
  sha256Match: boolean;
  error?: string;
}

export interface TransferEndMessage {
  type: 'TRANSFER_END';
  transferId: string;
}

export interface TransferCancelMessage {
  type: 'CANCEL';
  transferId?: string;
  reason: string;
}

export interface TransferErrorMessage {
  type: 'ERROR';
  transferId?: string;
  code: string;
  message: string;
}

export interface ResumeFileStatus {
  fileId: string;
  completed: boolean;
  missingChunks: number[];
}

export interface ResumeRequestMessage {
  type: 'RESUME_REQUEST';
  transferId: string;
  manifest?: TransferManifest;
}

export interface ResumeResponseMessage {
  type: 'RESUME_RESPONSE';
  transferId: string;
  accepted: boolean;
  error?: string;
  files?: ResumeFileStatus[];
}

export interface ChunkHeader {
  transferId: string;
  fileId: string;
  index: number;
  totalChunks: number;
  byteLength: number;
}

export interface AssembledFile {
  id: string;
  name: string;
  size: number;
  blob: Blob;
  verified: boolean;
  sha256: string;
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
  state: 'preparing' | 'sending' | 'receiving' | 'paused' | 'reconnecting' | 'resuming' | 'verifying' | 'completed' | 'failed' | 'cancelled';
}
