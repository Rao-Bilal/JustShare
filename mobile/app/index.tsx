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
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { getOrCreateDevice } from '../src/services/device';
import { StoredDevice } from '../src/services/storage';
import { getConfig } from '../src/config';
import { createSession, joinSession, SessionResponse } from '../src/services/api';
import { SignalingClient } from '../src/services/signaling';
import { MobileWebRTCConnection } from '../src/services/webrtc';
import {
  MobileFileSender,
  MobileFileReceiver,
} from '../src/services/transfer';
import { NativeFile, TransferProgress } from '../src/types/transfer';
import {
  NearbyDiscoveryManager,
  NearbyDiscoveredDevice,
  NearbyDiscoveryStatus,
  NearbyIncomingRequest,
} from '../src/services/nearby';
import { NearbyPairedPayload } from '../src/services/nearbySignaling';
import { extractPairingCode, buildMobilePairingUrl } from '../src/services/pairingUrl';

type Tab = 'nearby' | 'code' | 'qr';

export default function HomeScreen() {
  const [device, setDevice] = useState<StoredDevice | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('nearby');

  // 6-digit Code & Session state
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [createdSession, setCreatedSession] = useState<SessionResponse | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isJoiningSession, setIsJoiningSession] = useState(false);
  const [pairedSessionId, setPairedSessionId] = useState<string | null>(null);
  const [pairedPeerRole, setPairedPeerRole] = useState<string | null>(null);

  // Nearby Discovery state
  const [nearbyStatus, setNearbyStatus] = useState<NearbyDiscoveryStatus>('idle');
  const [discoveredDevices, setDiscoveredDevices] = useState<NearbyDiscoveredDevice[]>([]);
  const [incomingRequest, setIncomingRequest] = useState<NearbyIncomingRequest | null>(null);
  const nearbyManagerRef = useRef<NearbyDiscoveryManager | null>(null);

  // WebRTC & Transfer state
  const [webrtcConn, setWebrtcConn] = useState<MobileWebRTCConnection | null>(null);
  const [signaling, setSignaling] = useState<SignalingClient | null>(null);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<Array<{ name: string; uri: string; size: number }>>([]);
  const [selectedFiles, setSelectedFiles] = useState<NativeFile[]>([]);
  const selectedFilesRef = useRef<NativeFile[]>([]);
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferStatusText, setTransferStatusText] = useState<string>('');
  const [peerDevice, setPeerDevice] = useState<{ device_id: string; display_name: string } | null>(null);

  // Incoming transfer metadata approval state
  const [incomingTransferRequest, setIncomingTransferRequest] = useState<{
    files: Array<{ id: string; name: string; size: number; type: string }>;
    totalSize: number;
  } | null>(null);
  const [isWaitingForApproval, setIsWaitingForApproval] = useState(false);

  // Active sender/receiver instances
  const activeSenderRef = useRef<MobileFileSender | null>(null);
  const activeReceiverRef = useRef<MobileFileReceiver | null>(null);
  const isAcceptingRef = useRef(false);
  const isJoiningRef = useRef(false);

  // Camera QR Scanner state
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const isProcessingScanRef = useRef(false);

  const initDevice = useCallback(async () => {
    setLoading(true);
    try {
      const dev = await getOrCreateDevice();
      setDevice(dev);
    } catch (err: any) {
      Alert.alert('Initialization Error', err?.message || 'Failed to initialize device');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    initDevice();
  }, [initDevice]);

  // Setup Nearby Discovery Manager
  useEffect(() => {
    if (!device) return;

    const manager = new NearbyDiscoveryManager({
      onStatusChange: (status) => setNearbyStatus(status),
      onDeviceListUpdate: (devices) => setDiscoveredDevices(devices),
      onIncomingRequest: (request) => setIncomingRequest(request),
      onPaired: (payload: NearbyPairedPayload) => {
        setPairedSessionId(payload.session_id);
        setPairedPeerRole(payload.role);
        Alert.alert('Device Paired!', `Paired with nearby peer as ${payload.role}. Session: ${payload.session_id.substring(0, 8)}...`);
      },
    });

    nearbyManagerRef.current = manager;

    return () => {
      manager.stopDiscovery();
      nearbyManagerRef.current = null;
    };
  }, [device]);

  // Start or Stop Nearby Discovery based on tab
  useEffect(() => {
    if (!device || !nearbyManagerRef.current) return;

    if (activeTab === 'nearby') {
      nearbyManagerRef.current.startDiscovery(device.token, device.displayName);
    } else {
      nearbyManagerRef.current.stopDiscovery();
    }
  }, [activeTab, device]);

  // Start WebRTC DataChannel file sender upon peer approval
  const startWebRTCSender = useCallback((sig: SignalingClient, sessionId: string, filesToSend: NativeFile[]) => {
    if (!device) return;
    if (webrtcConn) {
      webrtcConn.close();
    }
    setTransferStatusText('Connecting WebRTC...');
    const conn = new MobileWebRTCConnection(sig, true, device.deviceId);

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
        sender.onComplete = () => {
          setIsTransferring(false);
          activeSenderRef.current = null;
          setTransferStatusText('Transfer Complete');
          Alert.alert('Success', 'All files sent and verified successfully!');
        };
        sender.onError = (err) => {
          setIsTransferring(false);
          activeSenderRef.current = null;
          setTransferStatusText('Transfer Failed');
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
  }, [device]);

  // Setup Signaling Connection for Session
  const setupSignaling = useCallback((sessionId: string, isSender: boolean, initialPeer?: { device_id: string; display_name: string }) => {
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
  }, [device, signaling, webrtcConn, startWebRTCSender]);

  // Create 6-digit Code Session (Mobile as Host)
  const handleCreateSession = async () => {
    if (!device) return;
    setIsCreatingSession(true);
    try {
      const session = await createSession(device.token);
      setCreatedSession(session);
      setPairedSessionId(session.session_id);
      setPairedPeerRole('host');
      setTransferStatusText('Waiting for peer to join...');
      setupSignaling(session.session_id, true);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to create session');
    } finally {
      setIsCreatingSession(false);
    }
  };

  // Join Session via 6-digit code (Mobile as Joiner)
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
      setPairedPeerRole('receiver');
      setIsScannerOpen(false);
      isProcessingScanRef.current = false;
      setTransferStatusText('Connected to Host');
      setupSignaling(res.session_id, false, res.sender);
      Alert.alert('Session Joined!', `Connected to: ${res.sender.display_name}`);
    } catch (err: any) {
      Alert.alert('Join Failed', err?.message || 'Could not join session with this code.');
    } finally {
      isJoiningRef.current = false;
      setIsJoiningSession(false);
      isProcessingScanRef.current = false;
    }
  };

  // File Picker
  const handlePickFiles = async () => {
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

  // Remove individual file from selection
  const handleRemoveFile = (indexToRemove: number) => {
    setSelectedFiles((prev) => {
      const updated = prev.filter((_, idx) => idx !== indexToRemove);
      selectedFilesRef.current = updated;
      return updated;
    });
  };

  // Dispatch File Metadata via Signaling to prompt receiver approval
  const handleSendFiles = async () => {
    if (!signaling || selectedFiles.length === 0) {
      Alert.alert('No Files', 'Please select at least one file to send.');
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

  // Receiver accepts incoming files
  const handleAcceptIncomingTransfer = () => {
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
    const conn = new MobileWebRTCConnection(signaling, false, device.deviceId);

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

      receiver.onComplete = (files) => {
        setIsTransferring(false);
        activeReceiverRef.current = null;
        setIncomingTransferRequest(null);
        isAcceptingRef.current = false;
        setReceivedFiles((prev) => [...prev, ...files]);
        setTransferStatusText('Transfer Complete');
        Alert.alert('Transfer Complete', `Received ${files.length} file(s) successfully!`);
      };

      receiver.onError = (err) => {
        setIsTransferring(false);
        activeReceiverRef.current = null;
        isAcceptingRef.current = false;
        setTransferStatusText('Receive Failed');
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
    Alert.alert(
      'Cancel Transfer',
      'Are you sure you want to cancel the transfer?',
      [
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
          },
        },
      ]
    );
  };

  // QR Code Barcode Scanned handler
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
        Alert.alert(
          'Invalid QR Code',
          'This QR code does not contain a valid 6-digit JustShare pairing code.',
          [{ text: 'OK', onPress: () => { isProcessingScanRef.current = false; } }]
        );
      }
    } catch {
      Alert.alert(
        'QR Error',
        'Could not read pairing code from QR code.',
        [{ text: 'OK', onPress: () => { isProcessingScanRef.current = false; } }]
      );
    }
  };

  const handleOpenScanner = async () => {
    isProcessingScanRef.current = false;
    if (!cameraPermission?.granted) {
      const permission = await requestCameraPermission();
      if (!permission.granted) {
        Alert.alert('Permission Required', 'Camera access is required to scan QR codes.');
        return;
      }
    }
    setIsScannerOpen(true);
  };

  if (loading || !device) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#58a6ff" />
        <Text style={styles.loadingText}>Initializing device identity...</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.appName}>JustShare</Text>
        <View style={styles.deviceBadge}>
          <View style={styles.dotOnline} />
          <Text style={styles.deviceBadgeText} numberOfLines={1}>
            {device.displayName}
          </Text>
        </View>
      </View>

      {/* Paired Banner & Transfer Control Panel */}
      {pairedSessionId && (
        <View style={styles.pairedBanner}>
          <View style={styles.rowBetween}>
            <Text style={styles.pairedBannerTitle}>Session Connected</Text>
            <Text style={styles.deviceBadgeText}>{transferStatusText || 'Connected'}</Text>
          </View>
          <Text style={styles.pairedBannerText}>
            {peerDevice ? `Peer: ${peerDevice.display_name} • ` : ''}ID: {pairedSessionId.substring(0, 8)}...
          </Text>

          {/* INCOMING TRANSFER APPROVAL DIALOG (Receiver) */}
          {incomingTransferRequest && (
            <View style={styles.incomingModalBox}>
              <Text style={styles.incomingTitle}>Incoming File Transfer</Text>
              <Text style={styles.incomingSubtitle}>
                {peerDevice ? peerDevice.display_name : 'Sender'} wants to send you {incomingTransferRequest.files.length} file(s) ({Math.round(incomingTransferRequest.totalSize / 1024)} KB):
              </Text>

              <ScrollView style={{ maxHeight: 120, marginVertical: 8 }}>
                {incomingTransferRequest.files.map((file, idx) => (
                  <View key={file.id || idx} style={styles.incomingFileItem}>
                    <Text style={styles.incomingFileName} numberOfLines={1}>
                      • {file.name}
                    </Text>
                    <Text style={styles.incomingFileSize}>
                      {Math.round(file.size / 1024)} KB
                    </Text>
                  </View>
                ))}
              </ScrollView>

              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={[styles.actionButton, styles.buttonGreen, { flex: 1 }]}
                  onPress={handleAcceptIncomingTransfer}
                >
                  <Text style={styles.buttonText}>Accept</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionButton, styles.buttonRed, { flex: 1 }]}
                  onPress={handleDeclineIncomingTransfer}
                >
                  <Text style={styles.buttonText}>Decline</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* FILE SELECTION & SENDER CONTROLS */}
          <View style={{ marginTop: 12 }}>
            <TouchableOpacity
              style={[styles.smallButton, styles.buttonBlue, { marginBottom: 8 }]}
              onPress={handlePickFiles}
              disabled={isTransferring}
            >
              <Text style={styles.smallButtonText}>+ Add Files to Send</Text>
            </TouchableOpacity>

            {/* List of Selected Files with Remove Button */}
            {selectedFiles.length > 0 && (
              <View style={styles.selectedFilesBox}>
                <Text style={styles.selectedHeader}>
                  Selected Files ({selectedFiles.length}) • Total: {Math.round(selectedFiles.reduce((acc, f) => acc + f.size, 0) / 1024)} KB
                </Text>
                {selectedFiles.map((f, idx) => (
                  <View key={f.id || idx} style={styles.fileRow}>
                    <View style={{ flex: 1, marginRight: 8 }}>
                      <Text style={styles.fileNameText} numberOfLines={1}>
                        {f.name}
                      </Text>
                      <Text style={styles.fileSizeText}>
                        {Math.round(f.size / 1024)} KB
                      </Text>
                    </View>
                    {!isTransferring && (
                      <TouchableOpacity
                        style={styles.removeFileButton}
                        onPress={() => handleRemoveFile(idx)}
                      >
                        <Text style={styles.removeFileButtonText}>✕</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}

                <TouchableOpacity
                  style={[styles.actionButton, styles.buttonGreen, { marginTop: 10 }]}
                  onPress={handleSendFiles}
                  disabled={isTransferring || isWaitingForApproval}
                >
                  {isWaitingForApproval ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text style={styles.buttonText}>Awaiting Peer Approval...</Text>
                    </View>
                  ) : isTransferring ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Send {selectedFiles.length} File(s) Now</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* PROGRESS BAR & CANCEL BUTTON */}
          {transferProgress && (
            <View style={{ marginTop: 12 }}>
              <View style={styles.rowBetween}>
                <Text style={{ color: '#f0f6fc', fontSize: 13, fontWeight: '600' }}>
                  {transferProgress.fileName}
                </Text>
                <Text style={{ color: '#58a6ff', fontSize: 13, fontWeight: '700' }}>
                  {transferProgress.percent}%
                </Text>
              </View>

              <View
                style={{
                  height: 6,
                  backgroundColor: '#21262d',
                  borderRadius: 3,
                  marginTop: 6,
                  overflow: 'hidden',
                }}
              >
                <View
                  style={{
                    height: '100%',
                    width: `${transferProgress.percent}%`,
                    backgroundColor: '#238636',
                  }}
                />
              </View>
              <View style={[styles.rowBetween, { marginTop: 4 }]}>
                <Text style={{ color: '#8b949e', fontSize: 11 }}>
                  {Math.round(transferProgress.totalBytesTransferred / 1024)} KB /{' '}
                  {Math.round(transferProgress.totalBytes / 1024)} KB
                  {transferProgress.speedBps > 0 && ` (${Math.round(transferProgress.speedBps / 1024)} KB/s)`}
                </Text>
                {isTransferring && (
                  <TouchableOpacity onPress={handleCancelTransfer}>
                    <Text style={{ color: '#da3633', fontSize: 12, fontWeight: '700' }}>Cancel</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}

          {/* RECEIVED FILES */}
          {receivedFiles.length > 0 && (
            <View style={{ marginTop: 12 }}>
              <Text style={{ color: '#3fb950', fontSize: 13, fontWeight: '700', marginBottom: 6 }}>
                Received Files ({receivedFiles.length}):
              </Text>
              {receivedFiles.map((file, idx) => (
                <View key={idx} style={[styles.rowBetween, { paddingVertical: 4 }]}>
                  <Text style={{ color: '#f0f6fc', fontSize: 12, flex: 1, marginRight: 8 }} numberOfLines={1}>
                    • {file.name} ({Math.round(file.size / 1024)} KB)
                  </Text>
                  <TouchableOpacity
                    style={[styles.smallButton, styles.buttonBlue]}
                    onPress={() => Sharing.shareAsync(file.uri)}
                  >
                    <Text style={{ color: '#fff', fontSize: 11 }}>Save / Share</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {/* Tabs */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'nearby' && styles.tabButtonActive]}
          onPress={() => setActiveTab('nearby')}
        >
          <Text style={[styles.tabText, activeTab === 'nearby' && styles.tabTextActive]}>
            Nearby
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'code' && styles.tabButtonActive]}
          onPress={() => setActiveTab('code')}
        >
          <Text style={[styles.tabText, activeTab === 'code' && styles.tabTextActive]}>
            Pair Code
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'qr' && styles.tabButtonActive]}
          onPress={() => setActiveTab('qr')}
        >
          <Text style={[styles.tabText, activeTab === 'qr' && styles.tabTextActive]}>
            QR Code
          </Text>
        </TouchableOpacity>
      </View>

      {/* Tab Content */}
      <ScrollView contentContainerStyle={styles.contentContainer}>
        {/* NEARBY DISCOVERY TAB */}
        {activeTab === 'nearby' && (
          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>Nearby Devices</Text>
              <ActivityIndicator
                animating={nearbyStatus === 'searching'}
                size="small"
                color="#58a6ff"
              />
            </View>

            <Text style={styles.cardSubtitle}>
              Devices on the same network running JustShare appear here automatically.
            </Text>

            {/* Incoming Request Dialog */}
            {incomingRequest && (
              <View style={styles.requestAlert}>
                <Text style={styles.requestAlertTitle}>Incoming Connection Request</Text>
                <Text style={styles.requestAlertText}>
                  {incomingRequest.fromDevice.name} wants to connect with you.
                </Text>
                <View style={styles.requestButtonRow}>
                  <TouchableOpacity
                    style={[styles.actionButton, styles.buttonGreen]}
                    onPress={() => {
                      nearbyManagerRef.current?.respondToIncomingRequest(true);
                      setIncomingRequest(null);
                    }}
                  >
                    <Text style={styles.buttonText}>Accept</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionButton, styles.buttonRed]}
                    onPress={() => {
                      nearbyManagerRef.current?.respondToIncomingRequest(false);
                      setIncomingRequest(null);
                    }}
                  >
                    <Text style={styles.buttonText}>Decline</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Device List */}
            {discoveredDevices.length === 0 ? (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyText}>
                  {nearbyStatus === 'searching'
                    ? 'Scanning local Wi-Fi for peers...'
                    : 'No devices found nearby. Ensure other devices are on the same Wi-Fi.'}
                </Text>
              </View>
            ) : (
              discoveredDevices.map((dev) => (
                <View key={dev.id} style={styles.peerRow}>
                  <View style={styles.peerInfo}>
                    <Text style={styles.peerName}>{dev.name}</Text>
                    <Text style={styles.peerType}>Type: {dev.type}</Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.smallButton, styles.buttonBlue]}
                    onPress={() => nearbyManagerRef.current?.requestPair(dev.id)}
                  >
                    <Text style={styles.smallButtonText}>Connect</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        )}

        {/* 6-DIGIT CODE TAB */}
        {activeTab === 'code' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Pair with 6-Digit Code</Text>
            <Text style={styles.cardSubtitle}>
              Generate a code to receive files, or enter a sender's code to connect.
            </Text>

            {/* Generate Code Box */}
            <View style={styles.subCard}>
              <Text style={styles.subCardTitle}>Your Pairing Code</Text>
              {createdSession ? (
                <View style={styles.codeDisplayBox}>
                  <Text style={styles.codeBig}>{createdSession.pairing_code}</Text>
                  <Text style={styles.codeExpiry}>
                    Expires in 10 minutes. Share this with your peer.
                  </Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.actionButton, styles.buttonGreen]}
                  onPress={handleCreateSession}
                  disabled={isCreatingSession}
                >
                  {isCreatingSession ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Generate New Code</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>

            {/* Enter Code Box */}
            <View style={styles.subCard}>
              <Text style={styles.subCardTitle}>Enter Peer's Code</Text>
              <TextInput
                style={styles.input}
                placeholder="6-digit code (e.g. 123456)"
                placeholderTextColor="#8b949e"
                value={pairingCodeInput}
                onChangeText={setPairingCodeInput}
                maxLength={6}
                keyboardType="numeric"
                autoCapitalize="none"
              />
              <TouchableOpacity
                style={[styles.actionButton, styles.buttonBlue]}
                onPress={() => handleJoinSession()}
                disabled={isJoiningSession || pairingCodeInput.length !== 6}
              >
                {isJoiningSession ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>Join Session</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* QR CODE TAB */}
        {activeTab === 'qr' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>QR Code Pairing</Text>
            <Text style={styles.cardSubtitle}>
              Display your session QR code or scan a code from your laptop / another device.
            </Text>

            {/* QR Scanner Trigger */}
            <TouchableOpacity
              style={[styles.actionButton, styles.buttonBlue, { marginBottom: 20 }]}
              onPress={handleOpenScanner}
            >
              <Text style={styles.buttonText}>Open Camera to Scan QR</Text>
            </TouchableOpacity>

            {/* Display QR Code */}
            <View style={styles.subCard}>
              <Text style={styles.subCardTitle}>Your QR Code</Text>
              {createdSession ? (
                <View style={styles.qrContainer}>
                  <QRCode
                    value={buildMobilePairingUrl(getConfig().backendUrl, createdSession.pairing_code)}
                    size={200}
                    color="#000"
                    backgroundColor="#fff"
                  />
                  <Text style={styles.qrCodeLabel}>Code: {createdSession.pairing_code}</Text>
                  <Text style={{ fontSize: 11, color: '#57606a', marginTop: 4, textAlign: 'center' }}>
                    Scan with JustShare on your laptop or another phone
                  </Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.actionButton, styles.buttonGreen]}
                  onPress={handleCreateSession}
                  disabled={isCreatingSession}
                >
                  {isCreatingSession ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Generate Session for QR</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}
      </ScrollView>

      {/* Camera Scanner Modal */}
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  centerContainer: {
    flex: 1,
    backgroundColor: '#0d1117',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  loadingText: {
    color: '#8b949e',
    marginTop: 12,
    fontSize: 14,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 50,
    paddingBottom: 16,
    backgroundColor: '#161b22',
    borderBottomWidth: 1,
    borderBottomColor: '#30363d',
  },
  appName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  deviceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#21262d',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 14,
    maxWidth: 180,
  },
  dotOnline: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3fb950',
    marginRight: 6,
  },
  deviceBadgeText: {
    color: '#c9d1d9',
    fontSize: 12,
    fontWeight: '500',
  },
  pairedBanner: {
    backgroundColor: 'rgba(35, 134, 54, 0.2)',
    borderColor: '#238636',
    borderWidth: 1,
    margin: 16,
    marginBottom: 0,
    padding: 12,
    borderRadius: 8,
  },
  pairedBannerTitle: {
    color: '#3fb950',
    fontWeight: '700',
    fontSize: 14,
  },
  pairedBannerText: {
    color: '#8b949e',
    fontSize: 12,
    marginTop: 2,
  },
  incomingModalBox: {
    backgroundColor: '#1c2128',
    borderColor: '#388bfd',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  incomingTitle: {
    color: '#58a6ff',
    fontWeight: '700',
    fontSize: 14,
    marginBottom: 4,
  },
  incomingSubtitle: {
    color: '#c9d1d9',
    fontSize: 12,
    lineHeight: 16,
  },
  incomingFileItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  incomingFileName: {
    color: '#f0f6fc',
    fontSize: 12,
    flex: 1,
    marginRight: 6,
  },
  incomingFileSize: {
    color: '#8b949e',
    fontSize: 11,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  selectedFilesBox: {
    backgroundColor: '#0d1117',
    borderColor: '#30363d',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
  },
  selectedHeader: {
    color: '#c9d1d9',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
  },
  fileNameText: {
    color: '#f0f6fc',
    fontSize: 12,
    fontWeight: '500',
  },
  fileSizeText: {
    color: '#8b949e',
    fontSize: 11,
  },
  removeFileButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: 'rgba(218, 54, 51, 0.2)',
  },
  removeFileButtonText: {
    color: '#da3633',
    fontSize: 12,
    fontWeight: '700',
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#161b22',
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 8,
    padding: 4,
    borderWidth: 1,
    borderColor: '#30363d',
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 6,
  },
  tabButtonActive: {
    backgroundColor: '#21262d',
  },
  tabText: {
    color: '#8b949e',
    fontWeight: '600',
    fontSize: 14,
  },
  tabTextActive: {
    color: '#f0f6fc',
  },
  contentContainer: {
    padding: 16,
  },
  card: {
    backgroundColor: '#161b22',
    borderColor: '#30363d',
    borderWidth: 1,
    borderRadius: 12,
    padding: 20,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#f0f6fc',
    marginBottom: 4,
  },
  cardSubtitle: {
    fontSize: 13,
    color: '#8b949e',
    marginBottom: 16,
    lineHeight: 18,
  },
  subCard: {
    backgroundColor: '#0d1117',
    borderColor: '#21262d',
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  },
  subCardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#c9d1d9',
    marginBottom: 10,
  },
  emptyBox: {
    padding: 24,
    alignItems: 'center',
  },
  emptyText: {
    color: '#8b949e',
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
  },
  peerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
  },
  peerInfo: {
    flex: 1,
  },
  peerName: {
    color: '#f0f6fc',
    fontSize: 15,
    fontWeight: '600',
  },
  peerType: {
    color: '#8b949e',
    fontSize: 12,
    marginTop: 2,
  },
  smallButton: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 6,
  },
  smallButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  actionButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonGreen: {
    backgroundColor: '#238636',
  },
  buttonBlue: {
    backgroundColor: '#1f6feb',
  },
  buttonRed: {
    backgroundColor: '#da3633',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#161b22',
    borderColor: '#30363d',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    color: '#f0f6fc',
    fontSize: 18,
    textAlign: 'center',
    letterSpacing: 4,
    marginBottom: 12,
  },
  codeDisplayBox: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  codeBig: {
    fontSize: 32,
    fontWeight: '800',
    color: '#58a6ff',
    letterSpacing: 6,
  },
  codeExpiry: {
    color: '#8b949e',
    fontSize: 12,
    marginTop: 6,
  },
  requestAlert: {
    backgroundColor: 'rgba(56, 139, 253, 0.15)',
    borderColor: '#388bfd',
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginBottom: 16,
  },
  requestAlertTitle: {
    color: '#58a6ff',
    fontWeight: '700',
    fontSize: 14,
    marginBottom: 4,
  },
  requestAlertText: {
    color: '#c9d1d9',
    fontSize: 13,
    marginBottom: 12,
  },
  requestButtonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  qrContainer: {
    alignItems: 'center',
    paddingVertical: 12,
    backgroundColor: '#ffffff',
    borderRadius: 12,
  },
  qrCodeLabel: {
    color: '#0d1117',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 10,
    letterSpacing: 2,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  scannerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 50,
  },
  scannerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  scannerTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  closeButton: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  closeButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  scannerTarget: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: '#58a6ff',
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  scannerHint: {
    color: '#ffffff',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
});
