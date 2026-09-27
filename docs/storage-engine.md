# JustShare Storage Engine & Large-File Streaming Specification (Phase 2C)

## Overview

The JustShare Storage Engine provides a high-throughput, bounded-memory storage and streaming layer for browser-to-browser P2P file transfers.

Prior to Phase 2C, chunk buffers were retained in JavaScript memory arrays, and cryptographic hashing computed SHA-256 over entire memory buffers. For multi-gigabyte files, this caused severe memory pressure and browser tab crashes. Phase 2C introduces:
1. **$O(1)$ Bounded Memory Footprint**: Streaming sender and receiver processing.
2. **Incremental Streaming SHA-256**: Pure TypeScript FIPS 180-4 compliant incremental hasher.
3. **Storage Engine Abstraction (`TransferStorage`)**: Decoupled persistent storage interface.
4. **Persistent IndexedDB & OPFS Backends**: Structured binary chunk persistence surviving page reloads.
5. **Durable Cross-Reload Resume**: Resuming transfers using persisted chunk caches across page reloads.
6. **Eviction and Resource Cleanup**: Automated stale transfer pruning and fail-closed integrity validation.

---

## 1. Storage Abstraction Architecture

```
                      +-----------------------------+
                      |   createTransferStorage()   |
                      +--------------+--------------+
                                     |
              +----------------------+----------------------+
              |                      |                      |
              v                      v                      v
    +-------------------+  +-------------------+  +-------------------+
    | IndexedDBTransfer |  |   OPFSTransfer    |  |   MemoryTransfer  |
    |      Storage      |  |      Storage      |  |  Storage (Test)   |
    +-------------------+  +-------------------+  +-------------------+
              |                      |                      |
              +----------------------+----------------------+
                                     |
                                     v
                        +--------------------------+
                        |  TransferStorage (IFace) |
                        +--------------------------+
                                     ^
                                     |
                        +------------+-------------+
                        |       FileReceiver       |
                        +--------------------------+
```

### 1.1 Interface Definition (`TransferStorage`)

```typescript
export interface TransferStorage {
  readonly type: 'indexeddb' | 'opfs' | 'memory';

  init(): Promise<void>;
  close(): Promise<void>;

  initTransfer(transferId: string, manifest: TransferManifest): Promise<void>;
  getTransfer(transferId: string): Promise<StoredTransferInfo | null>;
  listActiveTransfers(): Promise<string[]>;

  initFile(transferId: string, file: ManifestFileEntry): Promise<void>;
  writeChunk(transferId: string, fileId: string, index: number, data: Uint8Array): Promise<void>;
  hasChunk(transferId: string, fileId: string, index: number): Promise<boolean>;
  getReceivedChunks(transferId: string, fileId: string): Promise<number[]>;
  getMissingChunks(transferId: string, fileId: string, totalChunks: number): Promise<number[]>;

  verifyAndFinalizeFile(
    transferId: string,
    fileId: string,
    expectedSha256: string,
    onProgress?: (bytesProcessed: number, totalBytes: number) => void
  ): Promise<{ match: boolean; calculatedSha256: string; blob: Blob }>;

  getFinalizedBlob(transferId: string, fileId: string): Promise<Blob | null>;
  deleteTransfer(transferId: string): Promise<void>;
  cleanupStaleTransfers(maxAgeMs: number): Promise<void>;
}
```

---

## 2. Storage Implementations

### 2.1 `IndexedDBTransferStorage` (Primary Browser Default)
- **Object Stores**:
  - `transfers`: Keyed by `transferId`. Stores metadata, manifest, state (`in_progress`, `completed`, `failed`), and timestamps.
  - `files`: Keyed by compound key `[transferId, fileId]`. Stores file status, received chunk counts, size, and manifest hash.
  - `chunks`: Keyed by compound key `[transferId, fileId, index]`. Stores raw `Uint8Array` binary payloads. Indexed by `[transferId, fileId]` for fast streaming cursors.
  - `blobs`: Keyed by `[transferId, fileId]`. Stores assembled, verified browser `Blob` objects for user download.
- **Key Streaming Advantage**: Chunk verification uses an IndexedDB IDBKeyRange cursor on index `by_file`. Individual chunk payloads are read one at a time, fed into `IncrementalSha256`, appended to Blob builder parts, and immediately eligible for garbage collection.

### 2.2 `OPFSTransferStorage` (Origin Private File System)
- Uses `navigator.storage.getDirectory()` when available.
- Structure:
  - `/{transferId}/manifest.json`
  - `/{transferId}/files/{fileId}/meta.json`
  - `/{transferId}/files/{fileId}/chunk_{index}.bin`
  - `/{transferId}/files/{fileId}/final.bin`
- Streams chunks directly from private filesystem handles.

### 2.3 `MemoryTransferStorage` (Testing & Non-Persistent Fallback)
- In-memory `Map` storage conforming strictly to `TransferStorage`.
- Used in headless test suites and environments where storage APIs are unavailable.

---

## 3. Incremental Streaming Hashing

`IncrementalSha256` implements the standard FIPS PUB 180-4 SHA-256 algorithm with a stateful 64-byte block buffer:
- **Constant Memory**: Allocates exactly 64-byte message block buffer, 64-word schedule array, and 8 32-bit state registers ($O(1)$ memory).
- **Streaming Ingestion**: `hasher.update(chunkData)` processes 64-byte blocks progressively as chunks arrive from WebRTC.
- **Zero RAM Spike**: Eliminates `crypto.subtle.digest` whole-file array buffer allocation.

```typescript
const hasher = new IncrementalSha256();
// Process chunks incrementally
hasher.update(chunk1);
hasher.update(chunk2);
const finalDigest = hasher.digest(); // 64-char lowercase hex string
```

---

## 4. Bounded Memory Streaming Flow

```
Sender (File Slice -> DataChannel)
  | 
  |-- Chunk 0 (64 KB) ---------> Receiver -> TransferStorage.writeChunk() -> IndexedDB/OPFS
  |-- Chunk 1 (64 KB) ---------> Receiver -> TransferStorage.writeChunk() -> IndexedDB/OPFS
  | ...
  |-- FILE_END ----------------> Receiver
                                  |
                                  |-> TransferStorage.verifyAndFinalizeFile()
                                        | (Cursor streams chunks 0..N incrementally)
                                        | (IncrementalSha256 updates per chunk)
                                        | (Blob constructed without buffer duplicate)
                                  |
  |<-- FILE_ACK (match: true) ---+
```

---

## 5. Persistence, Reload Recovery & Eviction

1. **Cross-Reload Resume**:
   - `createTransferStorage()` opens the persistent IndexedDB / OPFS store.
   - On peer reconnect or page reload, `storage.getMissingChunks()` inspects persisted records and reports exact un-received chunk indices in `RESUME_RESPONSE`.
   - Sender only transmits missing chunks; existing valid chunks are preserved on disk.
2. **Fail-Closed Validation**:
   - If a file's calculated SHA-256 does not match the manifest, the file is marked unverified, no valid download Blob is stored, and `FILE_ACK` reports `sha256Match: false`.
3. **Stale Transfer Eviction**:
   - `storage.cleanupStaleTransfers(maxAgeMs)` prunes incomplete or older transfers, deleting chunk records and freeing browser storage quotas.
