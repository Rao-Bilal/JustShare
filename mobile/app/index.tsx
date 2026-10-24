import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Modal,
  Alert,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';

import { theme } from '../src/theme';
import { getOrCreateDevice } from '../src/services/device';
import { StoredDevice } from '../src/services/storage';
import { getConfig } from '../src/config';
import { createSession, getTurnCredentials, joinSession, SessionResponse } from '../src/services/api';
import { SignalingClient } from '../src/services/signaling';
import { MobileWebRTCConnection } from '../src/services/webrtc';
import { MobileFileSender, MobileFileReceiver } from '../src/services/transfer';
import { NativeFile, TransferProgress } from '../src/types/transfer';
import { extractPairingCode, buildMobilePairingUrl } from '../src/services/pairingUrl';
import {
  HistoryItem,
  loadHistory,
  createHistoryItem,
  addHistoryItems,
  markHistoryItemSaved,
} from '../src/services/history';
import { saveFileToDevice } from '../src/services/fileSaver';
import {
  UserRole,
  getVisibleControlsForRole,
  truncateFilename,
  formatBytes,
  calculateProgressPercentage,
  assertCanSend,
} from '../src/services/uiHelpers';

export default function HomeScreen() {
  const [device, setDevice] = useState<StoredDevice | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Active Flow State: 'idle' | 'send' | 'receive'
  const [activeFlow, setActiveFlow] = useState<'idle' | 'send' | 'receive'>('idle');
  const [activeRole, setActiveRole] = useState<UserRole>('idle');

  // Session & Connection state
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [createdSession, setCreatedSession] = useState<SessionResponse | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isJoiningSession, setIsJoiningSession] = useState(false);
  const [pairedSessionId, setPairedSessionId] = useState<string | null>(null);
  const [peerDevice, setPeerDevice] = useState<{ device_id: string; display_name: string } | null>(null);

  // WebRTC & Transfer state
  const [webrtcConn, setWebrtcConn] = useState<MobileWebRTCConnection | null>(null);
  const [signaling, setSignaling] = useState<SignalingClient | null>(null);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<Array<{ name: string; uri: string; size: number }>>([]);
  const [selectedFiles, setSelectedFiles] = useState<NativeFile[]>([]);
  const selectedFilesRef = useRef<NativeFile[]>([]);
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferStatusText, setTransferStatusText] = useState<string>('');

  // Transfer Completion Banner / Result
  const [completionResult, setCompletionResult] = useState<{
    success: boolean;
    message: string;
    filesCount: number;
  } | null>(null);

  // Incoming transfer metadata approval state (Receiver only)
  const [incomingTransferRequest, setIncomingTransferRequest] = useState<{
    files: Array<{ id: string; name: string; size: number; type: string }>;
    totalSize: number;
  } | null>(null);
  const [isWaitingForApproval, setIsWaitingForApproval] = useState(false);

  // Active sender/receiver instances & guards
  const activeSenderRef = useRef<MobileFileSender | null>(null);
  const activeReceiverRef = useRef<MobileFileReceiver | null>(null);
  const isAcceptingRef = useRef(false);
  const isJoiningRef = useRef(false);
  const autoArchiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Camera QR Scanner state
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const isProcessingScanRef = useRef(false);

  // Recent transfers history (last 3 for Home)
  const [recentTransfers, setRecentTransfers] = useState<HistoryItem[]>([]);
  const [savingHistoryId, setSavingHistoryId] = useState<string | null>(null);

  // Initialize device identity
  const initDevice = useCallback(async () => {
    try {
      const dev = await getOrCreateDevice();
      setDevice(dev);
    } catch (err: any) {
      Alert.alert('Initialization Error', err?.message || 'Failed to initialize device');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshRecentHistory = useCallback(async () => {
    const all = await loadHistory();
    setRecentTransfers(all.slice(0, 3));
  }, []);

  useEffect(() => {
    initDevice();
    refreshRecentHistory();
  }, [initDevice, refreshRecentHistory]);

  // Clean up auto-archive timer on unmount
  useEffect(() => {
    return () => {
      if (autoArchiveTimerRef.current) {
        clearTimeout(autoArchiveTimerRef.current);
      }
    };
  }, []);

  // Reset Session & Return to Idle
  const handleResetSession = useCallback(() => {
    if (activeSenderRef.current) {
      activeSenderRef.current.cancel();
      activeSenderRef.current = null;
    }
    if (activeReceiverRef.current) {
      activeReceiverRef.current.cancel();
      activeReceiverRef.current = null;
    }
    if (webrtcConn) {
      webrtcConn.close();
      setWebrtcConn(null);
    }
    if (signaling) {
      signaling.disconnect();
      setSignaling(null);
    }

    setActiveFlow('idle');
    setActiveRole('idle');
    setPairedSessionId(null);
    setCreatedSession(null);
    setPeerDevice(null);
    setPairingCodeInput('');
    setSelectedFiles([]);
    selectedFilesRef.current = [];
    setReceivedFiles([]);
    setIsTransferring(false);
    setIsWaitingForApproval(false);
    setIncomingTransferRequest(null);
    setTransferProgress(null);
    setTransferStatusText('');
    setCompletionResult(null);
    isAcceptingRef.current = false;
    isJoiningRef.current = false;
    isProcessingScanRef.current = false;
  }, [webrtcConn, signaling]);

  // Schedule moving completed transfer to history and return to idle after ~4 seconds
  const scheduleAutoArchive = useCallback(
    (result: { success: boolean; message: string; filesCount: number }) => {
      setCompletionResult(result);
      if (autoArchiveTimerRef.current) {
        clearTimeout(autoArchiveTimerRef.current);
      }
      autoArchiveTimerRef.current = setTimeout(() => {
        handleResetSession();
        refreshRecentHistory();
      }, 4000);
    },
    [handleResetSession, refreshRecentHistory]
  );

  // Pull-to-refresh on Home: resets stale UI state without interrupting active transfers
  const handlePullToRefresh = useCallback(async () => {
    if (isTransferring) return; // Guard: Never interrupt an ongoing transfer
    setRefreshing(true);
    handleResetSession();
    await initDevice();
    await refreshRecentHistory();
  }, [isTransferring, handleResetSession, initDevice, refreshRecentHistory]);

  // Start WebRTC DataChannel file sender upon peer approval
  const startWebRTCSender = useCallback(
    async (sig: SignalingClient, sessionId: string, filesToSend: NativeFile[]) => {
      if (!device) return;
      if (webrtcConn) {
        webrtcConn.close();
      }
      setTransferStatusText('Connecting WebRTC...');
      const turnServers = await getTurnCredentials(device.token);
      const conn = new MobileWebRTCConnection(sig, true, device.deviceId, turnServers);

      conn.onConnectionStateChange = (state) => {
        setTransferStatusText(`P2P: ${state}`);
      };

      const dc = conn.getDataChannel();
      if (dc) {
        let senderStarted = false;
        const runSender = () => {
          if (senderStarted) return;
          senderStarted = true;
          setIsTransferring(true);
          setTransferStatusText('Transferring...');
          const sender = new MobileFileSender(dc, filesToSend);
          activeSenderRef.current = sender;

          sender.onProgress = (prog) => {
            setTransferProgress(prog);
          };

          sender.onComplete = async () => {
            setIsTransferring(false);
            activeSenderRef.current = null;
            setTransferStatusText('Transfer Complete');

            // Persist sent items to history
            const historyEntries: HistoryItem[] = filesToSend.map((f) =>
              createHistoryItem({
                name: f.name,
                size: f.size,
                direction: 'sent',
                peerName: peerDevice?.display_name || 'Receiver',
                status: 'completed',
              })
            );
            await addHistoryItems(historyEntries);

            scheduleAutoArchive({
              success: true,
              message: `Sent ${filesToSend.length} file(s) successfully!`,
              filesCount: filesToSend.length,
            });
          };

          sender.onError = async (err) => {
            setIsTransferring(false);
            activeSenderRef.current = null;
            setTransferStatusText('Transfer Failed');

            // Persist failed attempt to history
            if (filesToSend.length > 0) {
              const failedEntries: HistoryItem[] = filesToSend.map((f) =>
                createHistoryItem({
                  name: f.name,
                  size: f.size,
                  direction: 'sent',
                  peerName: peerDevice?.display_name || 'Receiver',
                  status: 'failed',
                })
              );
              await addHistoryItems(failedEntries);
            }

            Alert.alert('Transfer Error', err);
          };

          sender.start();
        };

        if (dc.readyState === 'open') {
          runSender();
        } else {
          if (dc.addEventListener) {
            dc.addEventListener('open', runSender, { once: true });
          } else {
            dc.onopen = runSender;
          }
        }
      }

      conn.createOffer();
      setWebrtcConn(conn);
    },
    [device, webrtcConn, peerDevice, scheduleAutoArchive]
  );

  // Setup Signaling Connection for Session
  const setupSignaling = useCallback(
    (sessionId: string, isSender: boolean, initialPeer?: { device_id: string; display_name: string }) => {
      if (!device) return;

      if (signaling) {
        signaling.disconnect();
      }
      if (webrtcConn) {
        webrtcConn.close();
      }

      if (initialPeer) {
        setPeerDevice(initialPeer);
      }

      const sig = new SignalingClient();

      sig.on('peer_joined', (msg: any) => {
        if (msg.payload) {
          setPeerDevice(msg.payload);
        }
      });

      sig.on('peer_left', () => {
        setTransferStatusText('Peer disconnected');
        Alert.alert('Peer Left', 'The remote peer has disconnected.');
        handleResetSession();
      });

      if (isSender) {
        // SENDER: Listen for receiver's accept/decline response
        sig.on('transfer_response', (msg: any) => {
          setIsWaitingForApproval(false);
          const payload = msg?.payload;
          if (payload?.accepted) {
            const filesToSend = selectedFilesRef.current;
            if (!filesToSend || filesToSend.length === 0) {
              setTransferStatusText('Choose files first');
              Alert.alert('No Files', 'Choose files first');
              return;
            }
            setTransferStatusText('Transfer Accepted! Initializing P2P...');
            startWebRTCSender(sig, sessionId, filesToSend);
          } else {
            setIsTransferring(false);
            setTransferStatusText('Transfer Declined');
            Alert.alert('Transfer Declined', 'The receiver declined the file transfer request.');
          }
        });
      } else {
        // RECEIVER: Listen for sender's file_metadata
        sig.on('file_metadata', (msg: any) => {
          if (msg.payload) {
            setIncomingTransferRequest({
              files: msg.payload.files || [],
              totalSize: msg.payload.total_size || 0,
            });
          }
        });
      }

      sig.on('error', (err: any) => {
        setTransferStatusText('Signaling Error');
        Alert.alert('Signaling Error', err?.message || 'WebSocket signaling error');
      });

      sig.connect(sessionId, device.token);
      setSignaling(sig);
    },
    [device, signaling, webrtcConn, startWebRTCSender, handleResetSession]
  );

  // Sender starts: generates 6-digit code / QR session
  const handleStartSenderFlow = async () => {
    if (!device) return;
    setIsCreatingSession(true);
    setActiveFlow('send');
    setActiveRole('sender');
    try {
      const session = await createSession(device.token);
      setCreatedSession(session);
      setPairedSessionId(session.session_id);
      setTransferStatusText('Waiting for peer to join...');
      setupSignaling(session.session_id, true);
    } catch (err: any) {
      Alert.alert('Session Error', err?.message || 'Failed to create session');
      handleResetSession();
    } finally {
      setIsCreatingSession(false);
    }
  };

  // Receiver starts: shows code input & QR scanner trigger
  const handleStartReceiverFlow = () => {
    setActiveFlow('receive');
    setActiveRole('receiver');
  };

  // Receiver joins session via 6-digit code
  const handleJoinSession = async (codeToJoin?: string) => {
    if (!device) return;
    if (isJoiningRef.current) return;

    const code = (codeToJoin || pairingCodeInput).trim();
    if (code.length !== 6) {
      Alert.alert('Invalid Code', 'Please enter a 6-digit pairing code.');
      return;
    }

    isJoiningRef.current = true;
    setIsJoiningSession(true);
    try {
      const res = await joinSession(device.token, code);
      setPairedSessionId(res.session_id);
      setActiveFlow('receive');
      setActiveRole('receiver');
      setIsScannerOpen(false);
      isProcessingScanRef.current = false;
      setTransferStatusText('Connected to Sender');
      setupSignaling(res.session_id, false, res.sender);
    } catch (err: any) {
      Alert.alert('Join Failed', err?.message || 'Could not join session with this code.');
    } finally {
      isJoiningRef.current = false;
      setIsJoiningSession(false);
      isProcessingScanRef.current = false;
    }
  };

  // File Picker (Strict Sender Guard)
  const handlePickFiles = async () => {
    if (activeRole !== 'sender') {
      Alert.alert('Action Denied', 'Receivers cannot select files to send.');
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const files: NativeFile[] = result.assets.map((asset, idx) => ({
          id: `file_${Date.now()}_${idx}`,
          name: asset.name || 'unnamed_file',
          size: asset.size || 0,
          uri: asset.uri,
          mimeType: asset.mimeType || 'application/octet-stream',
        }));
        setSelectedFiles((prev) => {
          const updated = [...prev, ...files];
          selectedFilesRef.current = updated;
          return updated;
        });
      }
    } catch (err: any) {
      Alert.alert('Picker Error', err?.message || 'Failed to select files');
    }
  };

  const handleRemoveFile = (indexToRemove: number) => {
    setSelectedFiles((prev) => {
      const updated = prev.filter((_, idx) => idx !== indexToRemove);
      selectedFilesRef.current = updated;
      return updated;
    });
  };

  // Send files metadata to prompt receiver approval (Strict Sender Guard)
  const handleSendFiles = async () => {
    const canSendCheck = assertCanSend(activeRole, selectedFiles);
    if (!canSendCheck.allowed) {
      Alert.alert('Cannot Send', canSendCheck.reason);
      return;
    }

    if (!signaling) {
      Alert.alert('Not Connected', 'Signaling connection is not ready.');
      return;
    }

    setIsWaitingForApproval(true);
    setTransferStatusText('Awaiting receiver approval...');

    const filesMeta = selectedFiles.map((f, i) => ({
      id: f.id || `file_${i}_${Date.now()}`,
      name: f.name,
      size: f.size,
      type: f.mimeType || 'application/octet-stream',
    }));
    const totalSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);

    signaling.send({
      type: 'file_metadata',
      payload: {
        files: filesMeta,
        total_size: totalSize,
      },
    });
  };

  // Receiver accepts incoming files (Strict Receiver Guard)
  const handleAcceptIncomingTransfer = async () => {
    if (activeRole !== 'receiver') return;
    if (!signaling || !device || !incomingTransferRequest) return;
    if (isAcceptingRef.current) return;
    isAcceptingRef.current = true;

    if (webrtcConn) {
      webrtcConn.close();
    }

    signaling.send({
      type: 'transfer_response',
      payload: { accepted: true },
    });

    setTransferStatusText('Connecting WebRTC Receiver...');
    const turnServers = await getTurnCredentials(device.token);
    const conn = new MobileWebRTCConnection(signaling, false, device.deviceId, turnServers);

    conn.onConnectionStateChange = (state) => {
      setTransferStatusText(`P2P: ${state}`);
    };

    conn.onDataChannel = (dc) => {
      setIsTransferring(true);
      setTransferStatusText('Receiving files...');
      const receiver = new MobileFileReceiver(dc);
      activeReceiverRef.current = receiver;

      receiver.onProgress = (prog) => {
        setTransferProgress(prog);
      };

      receiver.onComplete = async (files) => {
        setIsTransferring(false);
        activeReceiverRef.current = null;
        setIncomingTransferRequest(null);
        isAcceptingRef.current = false;
        setReceivedFiles((prev) => [...prev, ...files]);
        setTransferStatusText('Transfer Complete');

        // Persist received items to history
        const historyEntries: HistoryItem[] = files.map((f) =>
          createHistoryItem({
            name: f.name,
            size: f.size,
            direction: 'received',
            peerName: peerDevice?.display_name || 'Sender',
            status: 'completed',
            uri: f.uri,
          })
        );
        await addHistoryItems(historyEntries);

        scheduleAutoArchive({
          success: true,
          message: `Received ${files.length} file(s) successfully!`,
          filesCount: files.length,
        });
      };

      receiver.onError = async (err) => {
        setIsTransferring(false);
        activeReceiverRef.current = null;
        isAcceptingRef.current = false;
        setTransferStatusText('Receive Failed');

        // Record failure in history
        if (incomingTransferRequest) {
          const failedEntries: HistoryItem[] = incomingTransferRequest.files.map((f) =>
            createHistoryItem({
              name: f.name,
              size: f.size,
              direction: 'received',
              peerName: peerDevice?.display_name || 'Sender',
              status: 'failed',
            })
          );
          await addHistoryItems(failedEntries);
        }

        Alert.alert('Receive Error', err);
      };
    };

    setWebrtcConn(conn);
    setIncomingTransferRequest(null);
  };

  // Receiver declines incoming files
  const handleDeclineIncomingTransfer = () => {
    if (!signaling) return;
    signaling.send({
      type: 'transfer_response',
      payload: { accepted: false },
    });
    setIncomingTransferRequest(null);
    isAcceptingRef.current = false;
    setTransferStatusText('Transfer Declined');
  };

  // Cancel ongoing transfer
  const handleCancelTransfer = () => {
    Alert.alert('Cancel Transfer', 'Are you sure you want to cancel the transfer?', [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes, Cancel',
        style: 'destructive',
        onPress: () => {
          if (activeSenderRef.current) {
            activeSenderRef.current.cancel();
            activeSenderRef.current = null;
          }
          if (activeReceiverRef.current) {
            activeReceiverRef.current.cancel();
            activeReceiverRef.current = null;
          }
          setIsTransferring(false);
          setIsWaitingForApproval(false);
          isAcceptingRef.current = false;
          setTransferProgress(null);
          setTransferStatusText('Transfer Cancelled');
          handleResetSession();
        },
      },
    ]);
  };

  // QR Scanning
  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (!isScannerOpen || isProcessingScanRef.current || isJoiningRef.current) return;
    isProcessingScanRef.current = true;
    setIsScannerOpen(false);

    try {
      const code = extractPairingCode(data);
      if (code) {
        setPairingCodeInput(code);
        handleJoinSession(code);
      } else {
        Alert.alert('Invalid QR Code', 'This QR code does not contain a valid 6-digit code.', [
          { text: 'OK', onPress: () => { isProcessingScanRef.current = false; } },
        ]);
      }
    } catch {
      Alert.alert('QR Error', 'Could not read pairing code from QR code.', [
        { text: 'OK', onPress: () => { isProcessingScanRef.current = false; } },
      ]);
    }
  };

  const handleOpenScanner = async () => {
    if (!cameraPermission || !cameraPermission.granted) {
      const { granted } = await requestCameraPermission();
      if (!granted) {
        Alert.alert('Permission Required', 'Camera permission is needed to scan QR codes.');
        return;
      }
    }
    isProcessingScanRef.current = false;
    setIsScannerOpen(true);
  };

  // Save received file from Home recent list to user-visible device storage
  const handleSaveRecentFile = async (item: HistoryItem) => {
    if (!item.uri) return;
    setSavingHistoryId(item.id);
    try {
      const res = await saveFileToDevice(item.uri, item.name);
      if (res.success) {
        await markHistoryItemSaved(item.id);
        await refreshRecentHistory();
        Alert.alert('Saved!', 'File saved to device successfully.');
      } else if (!res.cancelled) {
        Alert.alert('Save Failed', res.error || 'Failed to save file.');
      }
    } finally {
      setSavingHistoryId(null);
    }
  };

  // Visible controls helper
  const isPeerConnected = Boolean(pairedSessionId && peerDevice);
  const controls = getVisibleControlsForRole(activeRole, isPeerConnected);

  if (loading || !device) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text style={styles.loadingText}>Initializing device identity...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* COMPACT HEADER */}
      <View style={styles.header}>
        <View style={styles.headerBrandRow}>
          <Text style={styles.brandTitle}>JustShare</Text>
          <View style={styles.deviceChip}>
            <View style={styles.onlineDot} />
            <Text style={styles.deviceChipText} numberOfLines={1}>
              {device.displayName}
            </Text>
          </View>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handlePullToRefresh}
            colors={[theme.colors.primary]}
            tintColor={theme.colors.primary}
            enabled={!isTransferring}
          />
        }
      >
        {/* COMPLETION BANNER (Auto-archives after ~4s) */}
        {completionResult && (
          <View style={styles.completionBanner}>
            <Text style={styles.completionTitle}>✓ Transfer Complete</Text>
            <Text style={styles.completionSubtitle}>{completionResult.message}</Text>
            <Text style={styles.completionTimerText}>Archiving to History in a few seconds...</Text>
          </View>
        )}

        {/* ACTIVE SESSION / TRANSFER AREA (Rendered in isolated card when active) */}
        {pairedSessionId ? (
          <View style={styles.sessionCard}>
            <View style={styles.sessionHeaderRow}>
              <View>
                <Text style={styles.sessionTitle}>
                  {activeRole === 'sender' ? 'Sender Session' : 'Receiver Session'}
                </Text>
                <Text style={styles.sessionPeerSubtitle}>
                  {peerDevice ? `Connected with: ${peerDevice.display_name}` : 'Waiting for peer...'}
                </Text>
              </View>
              <TouchableOpacity style={styles.disconnectButton} onPress={handleResetSession}>
                <Text style={styles.disconnectButtonText}>Disconnect</Text>
              </TouchableOpacity>
            </View>

            {/* SENDER SCREEN: Code + QR before peer joins */}
            {activeRole === 'sender' && !peerDevice && createdSession && (
              <View style={styles.codeBox}>
                <Text style={styles.codeLabel}>Share 6-Digit Code with Peer</Text>
                <Text style={styles.codeText}>{createdSession.pairing_code}</Text>

                <View style={styles.qrWrapper}>
                  <QRCode
                    value={buildMobilePairingUrl(getConfig().backendUrl, createdSession.pairing_code)}
                    size={160}
                    color="#0f172a"
                    backgroundColor="#ffffff"
                  />
                  <Text style={styles.qrHint}>Or have the receiver scan this QR code</Text>
                </View>
              </View>
            )}

            {/* SENDER SCREEN: File Picking & Send Controls (Only after peer joined) */}
            {activeRole === 'sender' && peerDevice && (
              <View style={{ marginTop: theme.spacing.md }}>
                <TouchableOpacity
                  style={styles.dashedUploadArea}
                  onPress={handlePickFiles}
                  disabled={isTransferring}
                >
                  <Text style={{ fontSize: 28, marginBottom: 4 }}>📄</Text>
                  <Text style={styles.dashedUploadTitle}>+ Choose Files to Send</Text>
                  <Text style={styles.dashedUploadSubtitle}>Tap to browse documents, images, and files</Text>
                </TouchableOpacity>

                {selectedFiles.length > 0 && (
                  <View style={styles.selectedFilesList}>
                    <Text style={styles.selectedHeader}>
                      Selected Files ({selectedFiles.length}) • Total: {formatBytes(selectedFiles.reduce((acc, f) => acc + f.size, 0))}
                    </Text>
                    {selectedFiles.map((file, idx) => (
                      <View key={file.id || idx} style={styles.fileRow}>
                        <View style={{ flex: 1, marginRight: theme.spacing.sm }}>
                          <Text style={styles.fileNameText} numberOfLines={1}>
                            {truncateFilename(file.name, 28)}
                          </Text>
                          <Text style={styles.fileSizeText}>{formatBytes(file.size)}</Text>
                        </View>
                        {!isTransferring && (
                          <TouchableOpacity
                            style={styles.removeFileBtn}
                            onPress={() => handleRemoveFile(idx)}
                          >
                            <Text style={styles.removeFileBtnText}>✕</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    ))}

                    <TouchableOpacity
                      style={[styles.primaryButton, isTransferring && { opacity: 0.7 }]}
                      onPress={handleSendFiles}
                      disabled={isTransferring || isWaitingForApproval}
                    >
                      {isWaitingForApproval ? (
                        <View style={styles.loadingRow}>
                          <ActivityIndicator size="small" color="#fff" />
                          <Text style={styles.primaryButtonText}>Awaiting Approval...</Text>
                        </View>
                      ) : isTransferring ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.primaryButtonText}>
                          Send to {peerDevice.display_name} ({selectedFiles.length})
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}

            {/* RECEIVER SCREEN: Connected State & Accept/Decline (Never shows send/pick controls) */}
            {activeRole === 'receiver' && (
              <View style={{ marginTop: theme.spacing.md }}>
                {incomingTransferRequest ? (
                  <View style={styles.approvalBox}>
                    <Text style={styles.approvalTitle}>Incoming Transfer</Text>
                    <Text style={styles.approvalSubtitle}>
                      {peerDevice ? peerDevice.display_name : 'Sender'} wants to send you {incomingTransferRequest.files.length} file(s) ({formatBytes(incomingTransferRequest.totalSize)}):
                    </Text>

                    <ScrollView style={{ maxHeight: 110, marginVertical: 8 }}>
                      {incomingTransferRequest.files.map((file, idx) => (
                        <View key={file.id || idx} style={styles.approvalItem}>
                          <Text style={styles.approvalFileName} numberOfLines={1}>
                            • {truncateFilename(file.name, 28)}
                          </Text>
                          <Text style={styles.approvalFileSize}>{formatBytes(file.size)}</Text>
                        </View>
                      ))}
                    </ScrollView>

                    <View style={styles.buttonRow}>
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.btnGreen]}
                        onPress={handleAcceptIncomingTransfer}
                      >
                        <Text style={styles.btnTextWhite}>Accept</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.btnRed]}
                        onPress={handleDeclineIncomingTransfer}
                      >
                        <Text style={styles.btnTextWhite}>Decline</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View style={styles.receiverIdleState}>
                    <Text style={styles.receiverIdleText}>
                      Connected to {peerDevice ? peerDevice.display_name : 'Host'}. Waiting for files...
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* PROGRESS ROW (Percentage inside the row, never overflowing) */}
            {transferProgress && (
              <View style={styles.progressContainer}>
                <View style={styles.progressHeaderRow}>
                  <Text style={styles.progressFileName} numberOfLines={1}>
                    {truncateFilename(transferProgress.fileName, 24)}
                  </Text>
                  <Text style={styles.progressPercentText}>
                    {calculateProgressPercentage(transferProgress.fileBytesTransferred, transferProgress.fileTotalBytes)}%
                  </Text>
                </View>

                <View style={styles.progressBarTrack}>
                  <View
                    style={[
                      styles.progressBarFill,
                      {
                        width: `${calculateProgressPercentage(transferProgress.totalBytesTransferred, transferProgress.totalBytes)}%`,
                      },
                    ]}
                  />
                </View>

                <View style={styles.progressFooterRow}>
                  <Text style={styles.progressBytesText}>
                    {formatBytes(transferProgress.totalBytesTransferred)} / {formatBytes(transferProgress.totalBytes)}
                    {transferProgress.speedBps > 0 && ` (${formatBytes(transferProgress.speedBps)}/s)`}
                  </Text>
                  {isTransferring && (
                    <TouchableOpacity onPress={handleCancelTransfer}>
                      <Text style={styles.cancelText}>Cancel</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}
          </View>
        ) : (
          /* IDLE HOME DASHBOARD */
          <>
            {/* CENTRAL QUICK SHARE CARD */}
            <View style={styles.centralHeroCard}>
              <Text style={styles.heroTitle}>Direct Device Transfer</Text>
              <Text style={styles.heroSubtitle}>
                Transfer files directly peer-to-peer over your local network with SHA-256 integrity verification.
              </Text>
            </View>

            {/* ROW OF ACTION TILES: Send, Receive, History, QR Scan */}
            <View style={styles.tilesGrid}>
              {/* Tile 1: Send */}
              <TouchableOpacity
                style={[styles.actionTile, styles.tilePrimary]}
                activeOpacity={0.8}
                onPress={handleStartSenderFlow}
                disabled={isCreatingSession}
              >
                <View style={styles.tileIconCircle}>
                  <Text style={{ fontSize: 22 }}>↗</Text>
                </View>
                <Text style={styles.tileTitle}>Send</Text>
                <Text style={styles.tileDesc}>Host & send</Text>
              </TouchableOpacity>

              {/* Tile 2: Receive */}
              <TouchableOpacity
                style={styles.actionTile}
                activeOpacity={0.8}
                onPress={handleStartReceiverFlow}
              >
                <View style={[styles.tileIconCircle, { backgroundColor: theme.colors.accentGreenLight }]}>
                  <Text style={{ fontSize: 22 }}>↙</Text>
                </View>
                <Text style={styles.tileTitle}>Receive</Text>
                <Text style={styles.tileDesc}>Join session</Text>
              </TouchableOpacity>

              {/* Tile 3: History */}
              <TouchableOpacity
                style={styles.actionTile}
                activeOpacity={0.8}
                onPress={() => router.push('/history')}
              >
                <View style={[styles.tileIconCircle, { backgroundColor: theme.colors.surfaceAlt }]}>
                  <Text style={{ fontSize: 22 }}>📋</Text>
                </View>
                <Text style={styles.tileTitle}>History</Text>
                <Text style={styles.tileDesc}>All records</Text>
              </TouchableOpacity>

              {/* Tile 4: QR Scan */}
              <TouchableOpacity
                style={styles.actionTile}
                activeOpacity={0.8}
                onPress={handleOpenScanner}
              >
                <View style={[styles.tileIconCircle, { backgroundColor: theme.colors.primaryLight }]}>
                  <Text style={{ fontSize: 22 }}>📷</Text>
                </View>
                <Text style={styles.tileTitle}>Scan QR</Text>
                <Text style={styles.tileDesc}>Quick pair</Text>
              </TouchableOpacity>
            </View>

            {/* RECEIVE SHEET / CARD (When Receive tile tapped) */}
            {activeFlow === 'receive' && (
              <View style={styles.receiveInputCard}>
                <View style={styles.sessionHeaderRow}>
                  <Text style={styles.sessionTitle}>Join Session to Receive</Text>
                  <TouchableOpacity onPress={() => setActiveFlow('idle')}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Cancel</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.cardSubtitle}>
                  Enter the 6-digit code shown on the sender device, or scan their QR code.
                </Text>

                <TextInput
                  style={styles.codeInput}
                  placeholder="6-digit code (e.g. 123456)"
                  placeholderTextColor={theme.colors.textTertiary}
                  value={pairingCodeInput}
                  onChangeText={setPairingCodeInput}
                  maxLength={6}
                  keyboardType="numeric"
                  autoCapitalize="none"
                />

                <View style={styles.buttonRow}>
                  <TouchableOpacity
                    style={[styles.primaryButton, { flex: 1 }]}
                    onPress={() => handleJoinSession()}
                    disabled={isJoiningSession || pairingCodeInput.trim().length !== 6}
                  >
                    {isJoiningSession ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.primaryButtonText}>Connect to Sender</Text>
                    )}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.outlineButton, { minWidth: 100 }]}
                    onPress={handleOpenScanner}
                  >
                    <Text style={styles.outlineButtonText}>📷 Scan</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* RECENT TRANSFERS LIST (Last 3 with 'See all') */}
            <View style={styles.recentSection}>
              <View style={styles.recentHeaderRow}>
                <Text style={styles.recentSectionTitle}>Recent Transfers</Text>
                <TouchableOpacity onPress={() => router.push('/history')}>
                  <Text style={styles.seeAllText}>See all →</Text>
                </TouchableOpacity>
              </View>

              {recentTransfers.length === 0 ? (
                <View style={styles.recentEmptyBox}>
                  <Text style={styles.recentEmptyText}>No recent transfers yet</Text>
                </View>
              ) : (
                recentTransfers.map((item) => {
                  const isSent = item.direction === 'sent';
                  const isCompleted = item.status === 'completed';

                  return (
                    <View key={item.id} style={styles.recentItemCard}>
                      <View style={styles.recentItemLeft}>
                        <View
                          style={[
                            styles.recentIconCircle,
                            isCompleted ? styles.badgeGreen : styles.badgeRed,
                          ]}
                        >
                          <Text style={{ fontSize: 16 }}>{isSent ? '↗' : '✓'}</Text>
                        </View>
                        <View style={{ flex: 1, marginRight: theme.spacing.sm }}>
                          <Text style={styles.recentItemName} numberOfLines={1}>
                            {truncateFilename(item.name, 24)}
                          </Text>
                          <Text style={styles.recentItemMeta}>
                            {formatBytes(item.size)} • {isSent ? `To ${item.peerName}` : `From ${item.peerName}`}
                          </Text>
                        </View>
                      </View>

                      {!isSent && isCompleted && item.uri && (
                        <TouchableOpacity
                          style={[styles.saveChip, item.savedToDevice && styles.savedChip]}
                          onPress={() => handleSaveRecentFile(item)}
                          disabled={savingHistoryId === item.id || item.savedToDevice}
                        >
                          <Text style={[styles.saveChipText, item.savedToDevice && styles.savedChipText]}>
                            {item.savedToDevice ? '✓ Saved' : savingHistoryId === item.id ? '...' : 'Save'}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })
              )}
            </View>
          </>
        )}
      </ScrollView>

      {/* CAMERA QR SCANNER MODAL */}
      <Modal visible={isScannerOpen} animationType="slide">
        <View style={styles.modalRoot}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{
              barcodeTypes: ['qr'],
            }}
            onBarcodeScanned={handleBarCodeScanned}
          />

          <View style={styles.scannerOverlay}>
            <View style={styles.scannerHeader}>
              <Text style={styles.scannerTitle}>Scan JustShare QR Code</Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => setIsScannerOpen(false)}
              >
                <Text style={styles.closeButtonText}>Close</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.scannerTarget} />

            <Text style={styles.scannerHint}>
              Align the QR code within the frame to pair automatically
            </Text>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centerContainer: {
    flex: 1,
    backgroundColor: theme.colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.md,
  },
  header: {
    paddingHorizontal: theme.spacing.xl,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerBrandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  brandTitle: {
    ...theme.typography.titleLarge,
    color: theme.colors.textPrimary,
    letterSpacing: -0.5,
  },
  deviceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radii.full,
    maxWidth: 160,
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.accentGreen,
    marginRight: 6,
  },
  deviceChipText: {
    ...theme.typography.labelSmall,
    color: theme.colors.textSecondary,
  },
  scrollContent: {
    padding: theme.spacing.xl,
    paddingBottom: theme.spacing.xxxl,
  },
  completionBanner: {
    backgroundColor: theme.colors.accentGreenLight,
    borderColor: theme.colors.accentGreen,
    borderWidth: 1,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.lg,
  },
  completionTitle: {
    ...theme.typography.titleSmall,
    color: theme.colors.accentGreen,
  },
  completionSubtitle: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textPrimary,
    marginTop: 2,
  },
  completionTimerText: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    marginTop: 4,
  },
  centralHeroCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.xl,
    padding: theme.spacing.xl,
    marginBottom: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadows.card,
  },
  heroTitle: {
    ...theme.typography.titleMedium,
    color: theme.colors.textPrimary,
    marginBottom: 4,
  },
  heroSubtitle: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textSecondary,
    lineHeight: 20,
  },
  tilesGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: theme.spacing.xl,
  },
  actionTile: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.md,
    marginHorizontal: 4,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    minHeight: 104,
    justifyContent: 'center',
    ...theme.shadows.card,
  },
  tilePrimary: {
    borderColor: theme.colors.primaryLight,
  },
  tileIconCircle: {
    width: 44,
    height: 44,
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.xs,
  },
  tileTitle: {
    ...theme.typography.labelMedium,
    color: theme.colors.textPrimary,
  },
  tileDesc: {
    ...theme.typography.bodySmall,
    color: theme.colors.textTertiary,
    fontSize: 10,
  },
  receiveInputCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadows.card,
  },
  cardSubtitle: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.md,
  },
  codeInput: {
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    fontSize: 18,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
    minHeight: 48,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  primaryButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radii.md,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  primaryButtonText: {
    ...theme.typography.labelMedium,
    color: theme.colors.textInverse,
  },
  outlineButton: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.md,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
  },
  outlineButtonText: {
    ...theme.typography.labelMedium,
    color: theme.colors.textPrimary,
  },
  sessionCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.xl,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadows.card,
  },
  sessionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: theme.spacing.md,
  },
  sessionTitle: {
    ...theme.typography.titleSmall,
    color: theme.colors.textPrimary,
  },
  sessionPeerSubtitle: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  disconnectButton: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.accentRedLight,
    minHeight: 36,
    justifyContent: 'center',
  },
  disconnectButtonText: {
    ...theme.typography.labelSmall,
    color: theme.colors.accentRed,
  },
  codeBox: {
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.lg,
  },
  codeLabel: {
    ...theme.typography.labelMedium,
    color: theme.colors.textSecondary,
    marginBottom: 4,
  },
  codeText: {
    ...theme.typography.codeLarge,
    color: theme.colors.primary,
    marginVertical: theme.spacing.xs,
  },
  qrWrapper: {
    marginTop: theme.spacing.md,
    alignItems: 'center',
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.md,
  },
  qrHint: {
    ...theme.typography.bodySmall,
    color: theme.colors.textTertiary,
    marginTop: theme.spacing.sm,
  },
  dashedUploadArea: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: theme.colors.borderDashed,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.xl,
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
  },
  dashedUploadTitle: {
    ...theme.typography.titleSmall,
    color: theme.colors.primary,
  },
  dashedUploadSubtitle: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  selectedFilesList: {
    marginTop: theme.spacing.md,
  },
  selectedHeader: {
    ...theme.typography.labelSmall,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.sm,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radii.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  fileNameText: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textPrimary,
  },
  fileSizeText: {
    ...theme.typography.bodySmall,
    color: theme.colors.textTertiary,
  },
  removeFileBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeFileBtnText: {
    color: theme.colors.accentRed,
    fontWeight: '700',
  },
  approvalBox: {
    backgroundColor: theme.colors.accentAmberLight,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.accentAmber,
  },
  approvalTitle: {
    ...theme.typography.titleSmall,
    color: theme.colors.accentAmber,
  },
  approvalSubtitle: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textPrimary,
    marginTop: 2,
  },
  approvalItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  approvalFileName: {
    ...theme.typography.bodySmall,
    color: theme.colors.textPrimary,
    flex: 1,
  },
  approvalFileSize: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
  },
  actionBtn: {
    flex: 1,
    minHeight: 44,
    borderRadius: theme.radii.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnGreen: {
    backgroundColor: theme.colors.accentGreen,
  },
  btnRed: {
    backgroundColor: theme.colors.accentRed,
  },
  btnTextWhite: {
    ...theme.typography.labelMedium,
    color: theme.colors.textInverse,
  },
  receiverIdleState: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.lg,
    alignItems: 'center',
  },
  receiverIdleText: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  progressContainer: {
    marginTop: theme.spacing.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
  },
  progressHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.xs,
  },
  progressFileName: {
    ...theme.typography.labelMedium,
    color: theme.colors.textPrimary,
    flex: 1,
    marginRight: theme.spacing.sm,
  },
  progressPercentText: {
    ...theme.typography.labelMedium,
    color: theme.colors.primary,
  },
  progressBarTrack: {
    height: 8,
    backgroundColor: theme.colors.surfaceMuted,
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: theme.colors.primary,
  },
  progressFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: theme.spacing.xs,
  },
  progressBytesText: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
  },
  cancelText: {
    ...theme.typography.labelSmall,
    color: theme.colors.accentRed,
  },
  recentSection: {
    marginTop: theme.spacing.sm,
  },
  recentHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  recentSectionTitle: {
    ...theme.typography.titleSmall,
    color: theme.colors.textPrimary,
  },
  seeAllText: {
    ...theme.typography.labelSmall,
    color: theme.colors.primary,
  },
  recentEmptyBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  recentEmptyText: {
    ...theme.typography.bodyMedium,
    color: theme.colors.textTertiary,
  },
  recentItemCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...theme.shadows.card,
  },
  recentItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  recentIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.md,
  },
  badgeGreen: {
    backgroundColor: theme.colors.accentGreenLight,
  },
  badgeRed: {
    backgroundColor: theme.colors.accentRedLight,
  },
  recentItemName: {
    ...theme.typography.bodyMedium,
    fontWeight: '600',
    color: theme.colors.textPrimary,
  },
  recentItemMeta: {
    ...theme.typography.bodySmall,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  saveChip: {
    backgroundColor: theme.colors.primaryLight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radii.sm,
    minHeight: 32,
    justifyContent: 'center',
  },
  savedChip: {
    backgroundColor: theme.colors.accentGreenLight,
  },
  saveChipText: {
    ...theme.typography.labelSmall,
    color: theme.colors.primary,
  },
  savedChipText: {
    color: theme.colors.accentGreen,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  scannerOverlay: {
    flex: 1,
    justifyContent: 'space-between',
    padding: theme.spacing.xxxl,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  scannerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: theme.spacing.xxl,
  },
  scannerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  closeButton: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: theme.radii.sm,
    minHeight: 36,
    justifyContent: 'center',
  },
  closeButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  scannerTarget: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: '#58a6ff',
    borderRadius: theme.radii.xl,
    alignSelf: 'center',
    backgroundColor: 'transparent',
  },
  scannerHint: {
    color: '#fff',
    textAlign: 'center',
    fontSize: 13,
    marginBottom: theme.spacing.xl,
  },
});
