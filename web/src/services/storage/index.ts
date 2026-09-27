import { IndexedDBTransferStorage } from './indexeddb';
import { MemoryTransferStorage } from './memory';
import { OPFSTransferStorage } from './opfs';
import { TransferStorage } from './types';

export * from './indexeddb';
export * from './memory';
export * from './opfs';
export * from './types';

export type StorageType = 'indexeddb' | 'opfs' | 'memory';

export async function createTransferStorage(preferredType?: StorageType): Promise<TransferStorage> {
  // If explicitly requested:
  if (preferredType === 'opfs') {
    try {
      const opfs = new OPFSTransferStorage();
      await opfs.init();
      return opfs;
    } catch {
      console.warn('[STORAGE] OPFS requested but unavailable, falling back to IndexedDB');
    }
  }

  if (preferredType === 'memory') {
    const mem = new MemoryTransferStorage();
    await mem.init();
    return mem;
  }

  // Default priority: IndexedDB (fast, cross-browser, persistent structured clone) -> OPFS -> Memory
  try {
    if (typeof indexedDB !== 'undefined') {
      const idb = new IndexedDBTransferStorage();
      await idb.init();
      console.log('[STORAGE] Using persistent IndexedDBTransferStorage');
      return idb;
    }
  } catch (err) {
    console.warn('[STORAGE] IndexedDB init failed:', err);
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
      const opfs = new OPFSTransferStorage();
      await opfs.init();
      console.log('[STORAGE] Using persistent OPFSTransferStorage');
      return opfs;
    }
  } catch (err) {
    console.warn('[STORAGE] OPFS init failed:', err);
  }

  console.log('[STORAGE] Falling back to MemoryTransferStorage');
  const memory = new MemoryTransferStorage();
  await memory.init();
  return memory;
}
