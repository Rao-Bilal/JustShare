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

export interface ChunkHeader {
  transferId: string;
  fileId: string;
  index: number;
  totalChunks: number;
  byteLength: number;
}

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

export interface FileAckMessage {
  type: 'FILE_ACK';
  transferId: string;
  fileId: string;
}

export interface FileVerifyingMessage {
  type: 'VERIFYING';
  transferId: string;
  fileId: string;
  progress?: number;
}

export interface TransferEndMessage {
  type: 'TRANSFER_END';
  transferId: string;
}

export interface TransferCancelMessage {
  type: 'CANCEL';
  transferId: string;
  reason?: string;
}

export interface TransferErrorMessage {
  type: 'ERROR';
  code: string;
  message: string;
  transferId?: string;
}

export interface TransferProgress {
  fileIndex: number;
  fileName: string;
  fileBytesTransferred: number;
  fileTotalBytes: number;
  totalBytesTransferred: number;
  totalBytes: number;
  percent: number;
  speedBps: number;
  status: 'idle' | 'preparing' | 'sending' | 'receiving' | 'verifying' | 'completed' | 'paused' | 'resuming';
}

export interface NativeFile {
  id: string;
  name: string;
  size: number;
  uri: string;
  mimeType: string;
}
