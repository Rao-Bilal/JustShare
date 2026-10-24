/**
 * Persistent Transfer History Service for JustShare Mobile.
 * 
 * Persists history entries as a JSON file in FileSystem.documentDirectory
 * without requiring any new native dependencies.
 */
import * as FileSystem from 'expo-file-system/legacy';

export type HistoryDirection = 'sent' | 'received';
export type HistoryStatus = 'completed' | 'failed' | 'cancelled';

export interface HistoryItem {
  id: string;
  name: string;
  size: number;
  direction: HistoryDirection;
  peerName: string;
  timestamp: number;
  status: HistoryStatus;
  uri?: string; // Location in documentDirectory if received and kept
  savedToDevice?: boolean;
}

const HISTORY_FILE_URI = `${FileSystem.documentDirectory}justshare_history.json`;
const MAX_HISTORY_ITEMS = 100;

export function createHistoryItem(params: {
  name: string;
  size: number;
  direction: HistoryDirection;
  peerName: string;
  status: HistoryStatus;
  uri?: string;
  timestamp?: number;
}): HistoryItem {
  return {
    id: `hist_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    name: params.name,
    size: Math.max(0, params.size),
    direction: params.direction,
    peerName: params.peerName || (params.direction === 'sent' ? 'Receiver' : 'Sender'),
    timestamp: params.timestamp || Date.now(),
    status: params.status,
    uri: params.uri,
    savedToDevice: false,
  };
}

export async function loadHistory(): Promise<HistoryItem[]> {
  try {
    const info = await FileSystem.getInfoAsync(HISTORY_FILE_URI);
    if (!info.exists) {
      return [];
    }
    const content = await FileSystem.readAsStringAsync(HISTORY_FILE_URI);
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.sort((a, b) => b.timestamp - a.timestamp);
    }
    return [];
  } catch (err) {
    console.warn('[HISTORY] Failed to load history:', err);
    return [];
  }
}

export async function saveHistory(items: HistoryItem[]): Promise<void> {
  try {
    const trimmed = items.slice(0, MAX_HISTORY_ITEMS);
    await FileSystem.writeAsStringAsync(HISTORY_FILE_URI, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('[HISTORY] Failed to save history:', err);
  }
}

export async function addHistoryItems(newItems: HistoryItem[]): Promise<HistoryItem[]> {
  const current = await loadHistory();
  const updated = [...newItems, ...current];
  await saveHistory(updated);
  return updated;
}

export async function deleteHistoryItem(id: string): Promise<HistoryItem[]> {
  const current = await loadHistory();
  const updated = current.filter((item) => item.id !== id);
  await saveHistory(updated);
  return updated;
}

export async function markHistoryItemSaved(id: string): Promise<HistoryItem[]> {
  const current = await loadHistory();
  const updated = current.map((item) => {
    if (item.id === id) {
      return { ...item, savedToDevice: true };
    }
    return item;
  });
  await saveHistory(updated);
  return updated;
}

export async function clearHistory(): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(HISTORY_FILE_URI, JSON.stringify([]));
  } catch (err) {
    console.warn('[HISTORY] Failed to clear history:', err);
  }
}
