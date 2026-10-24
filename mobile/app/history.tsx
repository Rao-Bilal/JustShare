import React, { useEffect, useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Alert,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { theme } from '../src/theme';
import {
  HistoryItem,
  loadHistory,
  deleteHistoryItem,
  clearHistory,
  markHistoryItemSaved,
} from '../src/services/history';
import { saveFileToDevice } from '../src/services/fileSaver';
import { truncateFilename, formatBytes } from '../src/services/uiHelpers';

export default function HistoryScreen() {
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedItem, setSelectedItem] = useState<HistoryItem | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    try {
      const items = await loadHistory();
      setHistoryItems(items);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchHistory();
  }, [fetchHistory]);

  const handleDelete = (item: HistoryItem) => {
    Alert.alert('Delete Record', `Remove "${item.name}" from transfer history?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const updated = await deleteHistoryItem(item.id);
          setHistoryItems(updated);
          if (selectedItem?.id === item.id) {
            setSelectedItem(null);
          }
        },
      },
    ]);
  };

  const handleClearAll = () => {
    if (historyItems.length === 0) return;
    Alert.alert('Clear History', 'Are you sure you want to clear all transfer history?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear All',
        style: 'destructive',
        onPress: async () => {
          await clearHistory();
          setHistoryItems([]);
        },
      },
    ]);
  };

  const handleSaveToDevice = async (item: HistoryItem) => {
    if (!item.uri) {
      Alert.alert('Save Error', 'The file location is unavailable.');
      return;
    }
    setSavingId(item.id);
    try {
      const res = await saveFileToDevice(item.uri, item.name);
      if (res.success) {
        const updated = await markHistoryItemSaved(item.id);
        setHistoryItems(updated);
        if (selectedItem?.id === item.id) {
          setSelectedItem((prev) => (prev ? { ...prev, savedToDevice: true } : null));
        }
        Alert.alert('Saved!', `File saved to device successfully.`);
      } else if (!res.cancelled) {
        Alert.alert('Save Failed', res.error || 'Failed to save file.');
      }
    } finally {
      setSavingId(null);
    }
  };

  const formatDate = (timestamp: number) => {
    const d = new Date(timestamp);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View>
          <Text style={styles.screenTitle}>Transfer History</Text>
          <Text style={styles.screenSubtitle}>
            {historyItems.length} {historyItems.length === 1 ? 'record' : 'records'} stored locally
          </Text>
        </View>
        {historyItems.length > 0 && (
          <TouchableOpacity style={styles.clearButton} onPress={handleClearAll}>
            <Text style={styles.clearButtonText}>Clear All</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[theme.colors.primary]}
            tintColor={theme.colors.primary}
          />
        }
      >
        {historyItems.length === 0 ? (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconCircle}>
              <Text style={{ fontSize: 32 }}>📁</Text>
            </View>
            <Text style={styles.emptyTitle}>No transfer history yet</Text>
            <Text style={styles.emptySubtitle}>
              Files sent or received will appear here automatically with verified details.
            </Text>
          </View>
        ) : (
          historyItems.map((item) => {
            const isCompleted = item.status === 'completed';
            const isSent = item.direction === 'sent';

            return (
              <TouchableOpacity
                key={item.id}
                style={styles.card}
                activeOpacity={0.7}
                onPress={() => setSelectedItem(item)}
                onLongPress={() => handleDelete(item)}
              >
                <View style={styles.row}>
                  <View
                    style={[
                      styles.iconCircle,
                      isCompleted ? styles.iconCircleGreen : styles.iconCircleRed,
                    ]}
                  >
                    <Text style={{ fontSize: 18 }}>{isSent ? '↗' : '↙'}</Text>
                  </View>

                  <View style={styles.fileDetails}>
                    <Text style={styles.fileName} numberOfLines={1}>
                      {truncateFilename(item.name, 26)}
                    </Text>
                    <Text style={styles.fileMeta}>
                      {formatBytes(item.size)} • {isSent ? `To ${item.peerName}` : `From ${item.peerName}`}
                    </Text>
                  </View>

                  <View style={styles.statusCol}>
                    <View
                      style={[
                        styles.badge,
                        isCompleted ? styles.badgeGreen : styles.badgeRed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.badgeText,
                          isCompleted ? styles.badgeTextGreen : styles.badgeTextRed,
                        ]}
                      >
                        {isCompleted ? '✓ Done' : item.status}
                      </Text>
                    </View>
                    <Text style={styles.timeText}>
                      {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                </View>

                {/* Save button inline for received completed files */}
                {!isSent && isCompleted && item.uri && (
                  <View style={styles.cardActionRow}>
                    <TouchableOpacity
                      style={[
                        styles.saveButton,
                        item.savedToDevice && styles.savedButton,
                      ]}
                      onPress={() => handleSaveToDevice(item)}
                      disabled={savingId === item.id || item.savedToDevice}
                    >
                      <Text
                        style={[
                          styles.saveButtonText,
                          item.savedToDevice && styles.savedButtonText,
                        ]}
                      >
                        {item.savedToDevice ? '✓ Saved to Device' : savingId === item.id ? 'Saving...' : '💾 Save to Device'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* Details Modal */}
      {selectedItem && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setSelectedItem(null)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Transfer Details</Text>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>File Name:</Text>
                <Text style={styles.detailValue} numberOfLines={2}>
                  {selectedItem.name}
                </Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Size:</Text>
                <Text style={styles.detailValue}>{formatBytes(selectedItem.size)}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Direction:</Text>
                <Text style={styles.detailValue}>
                  {selectedItem.direction === 'sent' ? 'Outgoing (Sent)' : 'Incoming (Received)'}
                </Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Peer:</Text>
                <Text style={styles.detailValue}>{selectedItem.peerName}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Date & Time:</Text>
                <Text style={styles.detailValue}>{formatDate(selectedItem.timestamp)}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Integrity:</Text>
                <Text style={[styles.detailValue, { color: theme.colors.accentGreen, fontWeight: '700' }]}>
                  {selectedItem.status === 'completed' ? 'SHA-256 Verified ✓' : selectedItem.status}
                </Text>
              </View>

              <View style={styles.modalButtons}>
                {selectedItem.direction === 'received' && selectedItem.uri && (
                  <TouchableOpacity
                    style={[
                      styles.modalActionButton,
                      { backgroundColor: theme.colors.primary, marginBottom: 8 },
                      selectedItem.savedToDevice && { backgroundColor: theme.colors.accentGreen },
                    ]}
                    onPress={() => handleSaveToDevice(selectedItem)}
                    disabled={selectedItem.savedToDevice}
                  >
                    <Text style={styles.modalActionText}>
                      {selectedItem.savedToDevice ? '✓ File Saved' : 'Save to Device'}
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={[styles.modalActionButton, { backgroundColor: theme.colors.surfaceAlt }]}
                  onPress={() => setSelectedItem(null)}
                >
                  <Text style={[styles.modalActionText, { color: theme.colors.textPrimary }]}>
                    Close
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.xl,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  screenTitle: {
    ...theme.typography.titleLarge,
    color: theme.colors.textPrimary,
  },
  screenSubtitle: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  clearButton: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.surfaceAlt,
    minHeight: 36,
    justifyContent: 'center',
  },
  clearButtonText: {
    ...theme.typography.labelSmall,
    color: theme.colors.accentRed,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.xl,
    paddingBottom: theme.spacing.xxxl,
    paddingTop: theme.spacing.md,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadows.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: theme.radii.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.md,
  },
  iconCircleGreen: {
    backgroundColor: theme.colors.accentGreenLight,
  },
  iconCircleRed: {
    backgroundColor: theme.colors.accentRedLight,
  },
  fileDetails: {
    flex: 1,
    marginRight: theme.spacing.sm,
  },
  fileName: {
    ...theme.typography.titleSmall,
    color: theme.colors.textPrimary,
  },
  fileMeta: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  statusCol: {
    alignItems: 'flex-end',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radii.full,
  },
  badgeGreen: {
    backgroundColor: theme.colors.accentGreenLight,
  },
  badgeRed: {
    backgroundColor: theme.colors.accentRedLight,
  },
  badgeText: {
    ...theme.typography.labelSmall,
  },
  badgeTextGreen: {
    color: theme.colors.accentGreen,
  },
  badgeTextRed: {
    color: theme.colors.accentRed,
  },
  timeText: {
    ...theme.typography.bodySmall,
    color: theme.colors.textTertiary,
    marginTop: 4,
  },
  cardActionRow: {
    marginTop: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  saveButton: {
    minHeight: 44,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  savedButton: {
    backgroundColor: theme.colors.accentGreenLight,
  },
  saveButtonText: {
    ...theme.typography.labelMedium,
    color: theme.colors.primary,
  },
  savedButtonText: {
    color: theme.colors.accentGreen,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 80,
    paddingHorizontal: theme.spacing.xl,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
  },
  emptyTitle: {
    ...theme.typography.titleMedium,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.xs,
  },
  emptySubtitle: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.xl,
  },
  modalCard: {
    width: '100%',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.xl,
    padding: theme.spacing.xl,
    ...theme.shadows.sheet,
  },
  modalTitle: {
    ...theme.typography.titleMedium,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.lg,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: theme.spacing.xs,
  },
  detailLabel: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textSecondary,
    width: 90,
  },
  detailValue: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textPrimary,
    flex: 1,
    textAlign: 'right',
    fontWeight: '500',
  },
  modalButtons: {
    marginTop: theme.spacing.xl,
  },
  modalActionButton: {
    minHeight: 48,
    borderRadius: theme.radii.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalActionText: {
    ...theme.typography.labelMedium,
    color: theme.colors.textInverse,
  },
});
