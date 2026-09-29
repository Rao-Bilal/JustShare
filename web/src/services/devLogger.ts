/**
 * Development-Only Remote Logging Service for JustShare
 *
 * Transports sanitized, development-only sender milestones across the existing
 * authenticated signaling channel to the receiver (laptop) and logs to the
 * backend server terminal via standard logger.
 *
 * Strictly omits: file contents, raw byte data, auth tokens, pairing codes, private keys.
 */

export type RemoteLogMilestone =
  | 'file_selected'
  | 'hash_started'
  | 'hash_progress'
  | 'hash_completed'
  | 'manifest_created'
  | 'transfer_start_sent'
  | 'file_start_sent'
  | 'first_chunk_sent'
  | 'chunk_progress'
  | 'file_end_sent'
  | 'file_ack_received'
  | 'transfer_end_sent'
  | 'sender_completed'
  | 'sender_error';

export interface RemoteLogPayload {
  milestone: RemoteLogMilestone;
  timestamp: string;
  senderDeviceIdRedacted: string;
  transferId?: string;
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  totalChunks?: number;
  chunkIndex?: number;
  percent?: number;
  elapsedMs?: number;
  message?: string;
}

export interface RemoteLoggerTransport {
  send(msg: object): void;
}

export function redactDeviceId(deviceId?: string | null): string {
  if (!deviceId || typeof deviceId !== 'string') return 'anon';
  if (deviceId.length <= 8) return deviceId;
  return `${deviceId.substring(0, 4)}...${deviceId.substring(deviceId.length - 4)}`;
}

export class RemoteDevLogger {
  private transport: RemoteLoggerTransport | null = null;
  private senderDeviceIdRedacted: string;

  constructor(transport?: RemoteLoggerTransport | null, deviceId?: string | null) {
    this.transport = transport || null;
    this.senderDeviceIdRedacted = redactDeviceId(deviceId);
  }

  setTransport(transport: RemoteLoggerTransport | null): void {
    this.transport = transport;
  }

  setDeviceId(deviceId: string | null): void {
    this.senderDeviceIdRedacted = redactDeviceId(deviceId);
  }

  log(milestone: RemoteLogMilestone, details?: Omit<RemoteLogPayload, 'milestone' | 'timestamp' | 'senderDeviceIdRedacted'>): void {
    const timestamp = new Date().toISOString();
    const payload: RemoteLogPayload = {
      milestone,
      timestamp,
      senderDeviceIdRedacted: this.senderDeviceIdRedacted,
      ...details,
    };

    // Always log locally to console
    const formatted = formatRemoteLog(payload);
    console.log(formatted);

    // Send across signaling transport fail-safely
    if (this.transport) {
      try {
        this.transport.send({
          type: 'dev_log',
          payload,
        });
      } catch (err) {
        // Fail-safe: remote logging failure must NEVER disrupt transfer
        console.warn('[DEV-LOG] Failed to send remote log:', err);
      }
    }
  }
}

export function formatRemoteLog(payload: RemoteLogPayload): string {
  const parts = [`[REMOTE-DEV-LOG][${payload.senderDeviceIdRedacted}][${payload.milestone}]`];

  if (payload.transferId) parts.push(`tx=${payload.transferId}`);
  if (payload.fileId) parts.push(`fileId=${payload.fileId}`);
  if (payload.fileName) parts.push(`file='${payload.fileName}'`);
  if (payload.fileSize !== undefined) parts.push(`size=${payload.fileSize}B`);
  if (payload.totalChunks !== undefined) parts.push(`totalChunks=${payload.totalChunks}`);
  if (payload.chunkIndex !== undefined) parts.push(`chunk=${payload.chunkIndex}`);
  if (payload.percent !== undefined) parts.push(`progress=${payload.percent}%`);
  if (payload.elapsedMs !== undefined) parts.push(`elapsed=${payload.elapsedMs}ms`);
  if (payload.message) parts.push(`msg="${payload.message}"`);

  return parts.join(' ');
}
