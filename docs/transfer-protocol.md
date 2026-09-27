# JustShare Transfer Protocol (Phase 2A & 2B Specification)

## Overview

The JustShare Transfer Protocol is a binary-and-JSON framing protocol designed for secure, verifiable, high-throughput, and interrupt-resilient peer-to-peer file transfer over WebRTC `RTCDataChannel`.

---

## 1. Protocol Message Framing

The protocol utilizes two types of transmissions over the data channel:
1. **Control Messages (JSON UTF-8 strings)**: Used for transfer orchestration, manifests, per-file handshakes, acknowledgments, errors, cancellation, and resume negotiation.
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
Sent by the Sender prior to streaming chunks for a specific file (both in initial transfer and during resume).

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
Sent by the Sender after all planned chunks for the file have been transmitted.

```json
{
  "type": "FILE_END",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "fileId": "file_0_1790535152388_0ifw0"
}
```

### 2.4 `FILE_ACK`
Sent by the Receiver after computing SHA-256 over all assembled chunks and validating against the manifest hash.

```json
{
  "type": "FILE_ACK",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "fileId": "file_0_1790535152388_0ifw0",
  "sha256Match": true
}
```

### 2.5 `RESUME_REQUEST` (Phase 2B)
Sent by the Sender across a re-established DataChannel to initiate the resume handshake.

```json
{
  "type": "RESUME_REQUEST",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "manifest": {
    "transferId": "550e8400-e29b-41d4-a716-446655440000",
    "totalFiles": 2,
    "totalSize": 1048576,
    "files": [...]
  }
}
```

### 2.6 `RESUME_RESPONSE` (Phase 2B)
Sent by the Receiver in response to `RESUME_REQUEST`, authoritatively reporting the verification status and missing chunk indexes for every file in the manifest.

```json
{
  "type": "RESUME_RESPONSE",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "accepted": true,
  "files": [
    {
      "fileId": "file_0_1790535152388_0ifw0",
      "completed": true,
      "missingChunks": []
    },
    {
      "fileId": "file_1_1790535152388_1abc0",
      "completed": false,
      "missingChunks": [10, 11, 15]
    }
  ]
}
```

### 2.7 `TRANSFER_END`
Sent by the Sender once all files in the manifest have been acknowledged by the Receiver.

```json
{
  "type": "TRANSFER_END",
  "transferId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### 2.8 `CANCEL`
Sent by either peer to immediately abort the transfer.

```json
{
  "type": "CANCEL",
  "transferId": "550e8400-e29b-41d4-a716-446655440000",
  "reason": "User cancelled"
}
```

### 2.9 `ERROR`
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

## 3. Resume & Interruption Protocol (Phase 2B)

### 3.1 Resume Handshake Lifecycle

```
Sender                                              Receiver
  |                                                     |
  |--- [Connection Dropped / WebRTC Reconnected] ------>|
  |                                                     |
  |--- RESUME_REQUEST (transferId, manifest) ---------->|
  |                                                     |
  |                                        [Receiver Checks Status]
  |                                        - completed files: verified
  |                                        - in-progress: inspect chunks[]
  |                                        - not started: all missing
  |                                                     |
  |<-- RESUME_RESPONSE (accepted, files: missingChunks)-|
  |                                                     |
  |[Sender Skips Completed Files]                       |
  |[Sender Iterates Incomplete Files]                   |
  |--- FILE_START (file metadata) --------------------->|
  |--- Chunk Packets (ONLY missing chunks) ------------>|
  |--- FILE_END --------------------------------------->|
  |                                                     |
  |                                        [Receiver Validates All Chunks]
  |                                        [Receiver Computes SHA-256 Hash]
  |<-- FILE_ACK (sha256Match: true) --------------------|
  |                                                     |
  |--- TRANSFER_END ----------------------------------->|
  |                                                     |
```

### 3.2 Authoritative Receiver Progress
The Receiver is the sole authority regarding what data it possesses:
- **Completed Files**: Files already verified with SHA-256 are stored in `assembledFiles` and reported as `completed: true, missingChunks: []`.
- **In-Progress Files**: The receiver iterates the pre-allocated `chunks` array (`chunks[idx] instanceof Uint8Array`), collecting all unset indices into `missingChunks: number[]`.
- **Unstarted Files**: All chunk indices `0 .. totalChunks - 1` are marked missing.

### 3.3 Missing Chunk Retransmission
- The Sender skips any file with `completed: true`.
- For incomplete files, the Sender only slices and transmits chunks whose indices appear in `missingChunks`.
- The Receiver places retransmitted chunks directly into their indexed slots.
- Duplicate chunks received during retransmission are safely and idempotently ignored.

### 3.4 Strict Integrity Enforcement
- No file is acknowledged or assembled without passing full cryptographic SHA-256 verification over all assembled chunks.
- If corrupted data is received during resume, verification fails (`FILE_ACK` with `sha256Match: false`), the transfer fails closed, and no unverified data is presented to the user.

---

## 4. Reconnect & Timeout Policies

1. **Reconnection Limits**: Up to 5 consecutive reconnection attempts are permitted before failing permanently.
2. **Resume Handshake Timeout**: `DEFAULT_RESUME_TIMEOUT_MS = 15000` (15s). If unacknowledged, the attempt is aborted.
3. **ACK Timeout**: `DEFAULT_ACK_TIMEOUT_MS = 30000` (30s) per file.
4. **Stall Timeout**: `DEFAULT_STALL_TIMEOUT_MS = 30000` (30s) of silence on the Receiver triggers timeout error.
5. **Fail-Closed Authorization**: If a peer presents an unknown `transferId` or mismatched manifest during resume, the request is immediately rejected (`accepted: false`) without leaking existing session data.

---

## 5. Storage & Persistence Guarantees

- **In-Session Resume Guarantee**: Recovers seamlessly from temporary network drops, ICE restarts, WebRTC DataChannel re-connections, and peer reconnects as long as the browser tab remains open.
- **Browser Reload Limitation**: In-memory chunk arrays exist in RAM. Closing or hard-refreshing the browser tab discards active memory buffers. Durable multi-gigabyte cross-session persistence across browser restarts will be provided in a future storage engine phase (using OPFS / IndexedDB).

