# JustShare Transfer Protocol (Phase 2A Specification)

## Overview

The JustShare Transfer Protocol is a binary-and-JSON framing protocol designed for secure, verifiable, high-throughput peer-to-peer file transfer over WebRTC `RTCDataChannel`.

---

## 1. Protocol Message Framing

The protocol utilizes two types of transmissions over the data channel:
1. **Control Messages (JSON UTF-8 strings)**: Used for transfer orchestration, manifests, per-file handshakes, acknowledgments, errors, and cancellation.
2. **Chunk Packets (Binary ArrayBuffer)**: Used for streaming raw payload data with framing metadata.

### Chunk Packet Binary Layout

```
+---------------------------+----------------------------+-----------------------+
|  4 Bytes (Uint32 Big-End) |   Variable UTF-8 JSON      |   Variable Binary     |
|   Header Length (N bytes) |   ChunkHeader (N bytes)    |   Chunk Data (bytes)  |
+---------------------------+----------------------------+-----------------------+
```

#### Chunk Header Structure (`ChunkHeader`)
```json
{
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "fileId": "file_0_1790535152388_0ifw0",
  "index": 0,
  "totalChunks": 16,
  "byteLength": 65536
}
```

---

## 2. Control Messages

### 2.1 `TRANSFER_START`
Sent by the Sender to initialize a transfer session and deliver the validated `TransferManifest`.

```json
{
  "type": "TRANSFER_START",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "manifest": {
    "transferId": "550e8400-e29b-41d4-a716-446655440000",
    "totalFiles": 2,
    "totalSize": 1048576,
    "files": [
      {
        "id": "file_0_1790535152388_0ifw0",
        "name": "photo.jpg",
        "size": 1048576,
        "mimeType": "image/jpeg",
        "totalChunks": 16,
        "sha256": "c1152b50d8568012df2b9820b0c774d8291a491f8d6d0fa655569bdc6a7bf11a"
      }
    ]
  }
}
```

### 2.2 `FILE_START`
Sent by the Sender prior to streaming chunks for a specific file.

```json
{
  "type": "FILE_START",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "fileId": "file_0_1790535152388_0ifw0",
  "name": "photo.jpg",
  "size": 1048576,
  "chunkSize": 65536,
  "totalChunks": 16,
  "sha256": "c1152b50d8568012df2b9820b0c774d8291a491f8d6d0fa655569bdc6a7bf11a"
}
```

### 2.3 `FILE_END`
Sent by the Sender after all chunks for the file have been transmitted.

```json
{
  "type": "FILE_END",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "fileId": "file_0_1790535152388_0ifw0"
}
```

### 2.4 `FILE_ACK`
Sent by the Receiver after computing SHA-256 over all received chunks and validating against the manifest hash.

```json
{
  "type": "FILE_ACK",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "fileId": "file_0_1790535152388_0ifw0",
  "sha256Match": true
}
```

### 2.5 `TRANSFER_END`
Sent by the Sender once all files in the manifest have been acknowledged by the Receiver.

```json
{
  "type": "TRANSFER_END",
  "transferId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### 2.6 `CANCEL`
Sent by either peer to immediately abort the transfer.

```json
{
  "type": "CANCEL",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "reason": "User cancelled"
}
```

### 2.7 `ERROR`
Sent by either peer upon encountering a protocol, manifest, or chunk error.

```json
{
  "type": "ERROR",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "code": "CHUNK_ERROR",
  "message": "Chunk index out of bounds"
}
```

---

## 3. Validation Rules

### 3.1 Filename & Path Traversal Protection
- Filenames cannot exceed 255 characters.
- Must not contain `..`, `/`, `\`, null bytes `\0`, or control characters.

### 3.2 Manifest Validation
- `transferId`: Non-empty string.
- `totalFiles`: Matches `files.length` and must be between 1 and 10,000.
- `totalSize`: Exactly matches the sum of all `file.size` values.
- `file.id`: Unique across all files in the manifest.
- `file.totalChunks`: Must match $\lceil \text{size} / 65536 \rceil$ (0 for 0-byte files).
- `file.sha256`: 64-character hexadecimal SHA-256 string.

### 3.3 Chunk Validation
- `transferId` must match the active session.
- `fileId` must exist in the active manifest.
- `index` must satisfy $0 \le \text{index} < \text{totalChunks}$.
- Payload bytes must not exceed 65,536 bytes.

---

## 4. Reliability & Edge Cases

1. **Duplicate Chunks**: Idempotently ignored without double-counting received bytes.
2. **Out-of-Order Chunks**: Placed in indexed slots in a pre-allocated chunk array bounded by `totalChunks`.
3. **Empty (0-Byte) Files**: Handled with `totalChunks: 0`, expected SHA-256 hash `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
4. **Backpressure**: Monitored with `bufferedAmountLowThreshold` (256 KB) and high watermark (1 MB) to prevent browser memory exhaustion.
5. **Timeouts**: 30-second ACK timeout on `FILE_ACK` and 30-second stall timeout between chunk activity.
6. **Cancellation**: Deterministic state teardown, timer clearing, and peer notification.
