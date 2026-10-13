import { useEffect, useRef, useState } from 'react';
import { createSession, getSession, joinSession, updateSessionState } from '../services/api';
import { formatRemoteLog, RemoteDevLogger, RemoteLogPayload } from '../services/devLogger';
import { getOrCreateDevice, renameDevice, resetDevice, supportsDirectoryUpload } from '../services/device';
import { formatBytes, formatEta, formatSpeed } from '../services/format';
import { SignalingClient } from '../services/signaling';
import { createTransferStorage, TransferStorage } from '../services/storage';
import { FileReceiver, FileSender } from '../services/transfer';
import { WebRTCConnection } from '../services/webrtc';
import { AppScreen, DeviceInfo, FileInfo, SessionInfo, SessionState, TransferProgress } from '../types';
import { decidePeerLeftAction } from '../services/peerLeft';
import { determineInitialUrlAction } from '../services/pairingUrl';
import { QRCodeDisplay } from '../components/QRCodeDisplay';
import { NearbyDiscovery } from '../components/NearbyDiscovery';
import {
  IconLogo,
  IconSun,
  IconMoon,
  IconEdit,
  IconUpload,
  IconDownload,
  IconKeypad,
  IconQrCode,
  IconCopy,
  IconCheck,
  IconShield,
  IconCheckCircle,
  IconAlertCircle,
  IconClock,
  IconFolder,
  IconArrowLeft,
  IconRefreshCw,
} from '../components/Icons';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { CodeInput } from '../components/CodeInput';
import { DeviceAvatar } from '../components/DeviceAvatar';
import { DeviceEditModal } from '../components/DeviceEditModal';
import { FileRow } from '../components/FileRow';
import { ProgressBar } from '../components/ProgressBar';
import { StatusChip } from '../components/StatusChip';

export function App() {
  const [device, setDevice] = useState<{ device_id: string; display_name: string; token: string } | null>(null);
  const [screen, setScreen] = useState<AppScreen>('home');
  const screenRef = useRef<AppScreen>('home');
  const [, setRole] = useState<'sender' | 'receiver' | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [peerDevice, setPeerDevice] = useState<DeviceInfo | null>(null);
  const [pairingInput, setPairingInput] = useState('');
  const [joining, setJoining] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [incomingFiles, setIncomingFiles] = useState<FileInfo[]>([]);
  const [incomingTotalSize, setIncomingTotalSize] = useState(0);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [completedFiles, setCompletedFiles] = useState<{ name: string; blob: Blob; verified: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [receiveMode, setReceiveMode] = useState<'nearby' | 'code' | 'qr'>('code');

  // Theme & Device Name modal states
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('justshare_theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  });
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const sigRef = useRef<SignalingClient | null>(null);
  const rtcRef = useRef<WebRTCConnection | null>(null);
  const senderRef = useRef<FileSender | null>(null);
  const receiverRef = useRef<FileReceiver | null>(null);
  const storageRef = useRef<TransferStorage | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const sessionRef = useRef<SessionInfo | null>(null);
  const deviceRef = useRef<{ device_id: string; display_name: string; token: string } | null>(null);
  const selectedFilesRef = useRef<File[]>([]);
  const peerDeviceRef = useRef<DeviceInfo | null>(null);
  const hasAutoJoinedRef = useRef(false);

  // Sync theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('justshare_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  const setScreenState = (s: AppScreen) => {
    screenRef.current = s;
    setScreen(s);
  };

  const setSessionState = (sess: SessionInfo | null) => {
    sessionRef.current = sess;
    setSession(sess);
  };

  const setDeviceState = (dev: { device_id: string; display_name: string; token: string } | null) => {
    deviceRef.current = dev;
    setDevice(dev);
  };

  const setSelectedFilesState = (filesOrUpdater: File[] | ((prev: File[]) => File[])) => {
    if (typeof filesOrUpdater === 'function') {
      setSelectedFiles((prev) => {
        const next = filesOrUpdater(prev);
        selectedFilesRef.current = next;
        return next;
      });
    } else {
      selectedFilesRef.current = filesOrUpdater;
      setSelectedFiles(filesOrUpdater);
    }
  };

  const setPeerDeviceState = (peer: DeviceInfo | null) => {
    peerDeviceRef.current = peer;
    setPeerDevice(peer);
  };

  useEffect(() => {
    createTransferStorage()
      .then((storage) => {
        storageRef.current = storage;
      })
      .catch((err) => {
        console.warn('Failed to initialize transfer storage:', err);
      });

    const initialUrlAction = determineInitialUrlAction(window.location.hash);
    if (initialUrlAction.action !== 'none') {
      window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
    }

    if (initialUrlAction.action === 'join') {
      setRole('receiver');
      setReceiveMode('code');
      setScreenState('receive');
      setPairingInput(initialUrlAction.code);
      setJoining(true);
    } else if (initialUrlAction.action === 'error') {
      setRole('receiver');
      setReceiveMode('code');
      setScreenState('receive');
      setError(initialUrlAction.message);
    }

    getOrCreateDevice()
      .then((freshDev) => {
        setDeviceState(freshDev);
        if (initialUrlAction.action === 'join' && !hasAutoJoinedRef.current) {
          hasAutoJoinedRef.current = true;
          submitPairingCode(initialUrlAction.code, freshDev);
        }
      })
      .catch((e: unknown) => {
        const errorMsg = e instanceof Error ? e.message : 'Device init error';
        setError('Device registration failed: ' + errorMsg);
        setJoining(false);
      });
  }, []);

  // Poll for peer info if waiting on send screen
  useEffect(() => {
    if (screen === 'send' && session && device && !peerDevice) {
      const interval = setInterval(async () => {
        try {
          const details = await getSession(device.token, session.session_id);
          if (details.receiver) {
            setPeerDeviceState(details.receiver);
          }
        } catch {
          // ignore polling errors
        }
      }, 1500);
      return () => clearInterval(interval);
    }
  }, [screen, session, device, peerDevice]);

  const goHome = () => {
    if (sigRef.current) sigRef.current.disconnect();
    if (rtcRef.current) rtcRef.current.close();
    setScreenState('home');
    setRole(null);
    setSessionState(null);
    setPeerDeviceState(null);
    setPairingInput('');
    setJoining(false);
    setSelectedFilesState([]);
    setIncomingFiles([]);
    setIncomingTotalSize(0);
    setTransferProgress(null);
    setError(null);
  };

  const handlePeerLeft = () => {
    const isSenderDone = senderRef.current ? (senderRef.current as unknown as { isCompleted: boolean }).isCompleted === true : false;
    const receiver = receiverRef.current;
    const receiverState = receiver ? receiver.getState() : undefined;
    const assembledCount = receiver ? receiver.getAssembledFiles().length : undefined;
    const totalCount = receiver ? receiver.getManifest()?.totalFiles : undefined;

    const decision = decidePeerLeftAction({
      screen: screenRef.current,
      isSenderCompleted: isSenderDone,
      receiverState,
      assembledFilesCount: assembledCount,
      totalFilesCount: totalCount,
    });

    if (decision.action === 'fail') {
      console.warn('[PEER_LEFT] Peer disconnected during active transfer, setting screen to failed');
      if (senderRef.current) {
        senderRef.current.cancel('Peer disconnected');
      }
      if (receiverRef.current) {
        receiverRef.current.cancel('Peer disconnected');
      }
      if (rtcRef.current) {
        rtcRef.current.close();
      }
      if (sigRef.current) {
        sigRef.current.disconnect();
      }

      setError(decision.error);
      setScreenState('failed');

      const curSession = sessionRef.current;
      const curDevice = deviceRef.current;
      if (curSession && curDevice?.token) {
        updateSessionState(curDevice.token, curSession.session_id, 'FAILED').catch(() => {});
      }
    } else if (decision.action === 'go_home') {
      setError(decision.error);
      goHome();
    } else {
      console.log('[PEER_LEFT] Ignoring peer_left (transfer already finished or terminal)');
    }
  };

  const handleAuthFailure = async () => {
    try {
      const freshDevice = await resetDevice();
      setDeviceState(freshDevice);
      return freshDevice;
    } catch {
      return null;
    }
  };

  const handleRenameDevice = async (newName: string) => {
    const updated = await renameDevice(newName);
    setDeviceState(updated);
  };

  // Sender flow
  const startSending = async () => {
    let currentDevice = deviceRef.current;
    if (!currentDevice) {
      currentDevice = await handleAuthFailure();
      if (!currentDevice) return;
    }

    try {
      setError(null);
      setRole('sender');
      let res;
      try {
        res = await createSession(currentDevice.token);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('Authentication') || msg.includes('token') || msg.includes('401')) {
          const fresh = await handleAuthFailure();
          if (fresh) {
            currentDevice = fresh;
            res = await createSession(fresh.token);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      const sess: SessionInfo = {
        session_id: res.session_id,
        pairing_code: res.pairing_code,
        expires_at: res.expires_at,
        state: res.state as SessionState,
      };
      setSessionState(sess);
      setScreenState('send');

      const sig = new SignalingClient();
      sigRef.current = sig;

      sig.on('peer_joined', (msg: unknown) => {
        const payload = (msg as { payload: DeviceInfo }).payload;
        setPeerDeviceState(payload);
      });
      sig.on('peer_left', () => {
        handlePeerLeft();
      });
      sig.on('transfer_response', (msg: unknown) => {
        console.log('[SIGNAL] transfer_response handler START');
        const payload = (msg as { payload: { accepted: boolean } }).payload;
        console.log(`[SIGNAL] transfer_response accepted=${payload?.accepted}`);
        if (payload && payload.accepted) {
          console.log('[SIGNAL] transfer_response handler invoking sender WebRTC initialization');
          setScreenState('transfer');
          startWebRTCSender();
          console.log('[SIGNAL] transfer_response handler completed');
        } else {
          console.log('[SIGNAL] transfer_response rejected');
          setError('Transfer declined by receiver');
          setScreenState('failed');
        }
      });
      sig.on('error', (msg: unknown) => {
        const payload = (msg as { payload?: { message?: string } }).payload;
        setError(payload?.message || 'Signaling error');
      });

      sig.connect(sess.session_id, currentDevice.token);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Session creation error');
      goHome();
    }
  };

  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const newFiles = Array.from(files);

    setSelectedFilesState((prevFiles) => {
      const existingKeys = new Set(
        prevFiles.map(
          (f) => `${f.webkitRelativePath || f.name}__${f.size}__${f.lastModified}`
        )
      );

      const uniqueAdditions = newFiles.filter(
        (f) =>
          !existingKeys.has(
            `${f.webkitRelativePath || f.name}__${f.size}__${f.lastModified}`
          )
      );

      const updated = [...prevFiles, ...uniqueAdditions];
      console.log(`[TRANSFER][SEND] files updated: total=${updated.length} file(s) (+${uniqueAdditions.length})`);

      if (sigRef.current && deviceRef.current) {
        const logger = new RemoteDevLogger(sigRef.current, deviceRef.current.device_id);
        uniqueAdditions.forEach((f) => {
          logger.log('file_selected', {
            fileName: f.webkitRelativePath || f.name,
            fileSize: f.size,
            totalChunks: f.size === 0 ? 0 : Math.ceil(f.size / 65536),
          });
        });
      }

      return updated;
    });
  };

  const handleRemoveFile = (indexToRemove: number) => {
    setSelectedFilesState((prev) => {
      const updated = prev.filter((_, idx) => idx !== indexToRemove);
      console.log(`[TRANSFER][SEND] file removed at index ${indexToRemove}, remaining=${updated.length}`);
      return updated;
    });
  };

  const sendFileMetadata = () => {
    const curSig = sigRef.current;
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;
    const curFiles = selectedFilesRef.current;

    if (!curSig || !curSession || !curDevice) return;
    const filesMeta: FileInfo[] = curFiles.map((f, i) => ({
      id: `file_${i}_${Date.now()}`,
      name: f.webkitRelativePath || f.name,
      size: f.size,
      type: f.type || 'application/octet-stream',
    }));
    const totalSize = curFiles.reduce((acc, f) => acc + f.size, 0);

    console.log(`[TRANSFER][SEND] file_metadata sent (${curFiles.length} file(s), ${totalSize} bytes)`);
    curSig.send({
      type: 'file_metadata',
      payload: {
        files: filesMeta,
        total_size: totalSize,
      },
    });
    setScreenState('send');
  };

  const reconnectAttemptsRef = useRef<number>(0);
  const isReconnectingRef = useRef<boolean>(false);
  const MAX_RECONNECT_ATTEMPTS = 5;

  const handleConnectionDrop = async () => {
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;
    const curSig = sigRef.current;

    if (!curSession || !curDevice || !curSig || screenRef.current !== 'transfer') {
      return;
    }

    if (isReconnectingRef.current) {
      console.log('[RECOVERY] Reconnection already in progress');
      return;
    }

    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[RECOVERY] Max reconnect attempts exceeded');
      setError('Connection lost: could not recover after maximum retries');
      setScreenState('failed');
      if (curDevice && curSession) {
        updateSessionState(curDevice.token, curSession.session_id, 'FAILED').catch(() => {});
      }
      return;
    }

    isReconnectingRef.current = true;
    reconnectAttemptsRef.current += 1;
    console.log(`[RECOVERY] Attempting reconnection (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})`);

    setTransferProgress((prev) =>
      prev ? { ...prev, state: 'reconnecting' } : null
    );

    try {
      if (senderRef.current) {
        senderRef.current.pause();
        await updateSessionState(curDevice.token, curSession.session_id, 'PAUSED').catch(() => {});

        if (rtcRef.current) {
          rtcRef.current.close();
        }
        const rtc = new WebRTCConnection(curSig, true);
        rtcRef.current = rtc;

        curSig.on('signal', (msg: unknown) => {
          const signalMsg = msg as { from: string; payload: { signal_type: string; data: unknown } };
          if (signalMsg.from !== curDevice.device_id) {
            rtc.handleSignal(signalMsg.payload);
          }
        });

        rtc.onConnectionStateChange = (state) => {
          if (state === 'failed' || state === 'disconnected') {
            handleConnectionDrop();
          }
        };

        const dc = rtc.getDataChannel();
        if (dc) {
          let recoveryStarted = false;
          const onDcOpen = async () => {
            if (recoveryStarted) return;
            recoveryStarted = true;
            console.log('[RECOVERY][SEND] Reconnected DataChannel open, resuming FileSender');
            isReconnectingRef.current = false;
            reconnectAttemptsRef.current = 0;
            await updateSessionState(curDevice.token, curSession.session_id, 'TRANSFERRING').catch(() => {});
            if (senderRef.current) {
              senderRef.current.resume(dc);
            }
          };

          if (dc.readyState === 'open') {
            onDcOpen();
          } else {
            dc.addEventListener('open', onDcOpen, { once: true });
          }
        }

        await rtc.createOffer();
      } else if (receiverRef.current) {
        if (rtcRef.current) {
          rtcRef.current.close();
        }
        const rtc = new WebRTCConnection(curSig, false);
        rtcRef.current = rtc;

        curSig.on('signal', (msg: unknown) => {
          const signalMsg = msg as { from: string; payload: { signal_type: string; data: unknown } };
          if (signalMsg.from !== curDevice.device_id) {
            rtc.handleSignal(signalMsg.payload);
          }
        });

        rtc.onConnectionStateChange = (state) => {
          if (state === 'failed' || state === 'disconnected') {
            handleConnectionDrop();
          }
        };

        rtc.onDataChannel = (dc) => {
          console.log('[RECOVERY][RECEIVE] Reconnected DataChannel received, resuming FileReceiver');
          isReconnectingRef.current = false;
          reconnectAttemptsRef.current = 0;
          if (receiverRef.current) {
            receiverRef.current.resume(dc);
          }
        };
      }
    } catch (err) {
      console.error('[RECOVERY] Reconnection attempt failed:', err);
      isReconnectingRef.current = false;
      setTimeout(() => handleConnectionDrop(), 2000);
    }
  };

  const startWebRTCSender = () => {
    const curSig = sigRef.current;
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;
    const curFiles = selectedFilesRef.current;

    console.log('[TRANSFER][SEND] runSender START');
    if (!curSig || !curSession || !curDevice) {
      console.error('[TRANSFER][SEND] Cannot start WebRTC sender: missing dependencies');
      setError('Internal error: WebRTC session not ready');
      setScreenState('failed');
      return;
    }

    try {
      const rtc = new WebRTCConnection(curSig, true);
      rtcRef.current = rtc;

      curSig.on('signal', (msg: unknown) => {
        const signalMsg = msg as { from: string; payload: { signal_type: string; data: unknown } };
        if (signalMsg.from !== curDevice.device_id) {
          rtc.handleSignal(signalMsg.payload);
        }
      });

      rtc.onConnectionStateChange = (state) => {
        if (state === 'failed' || state === 'disconnected') {
          console.warn(`[WEBRTC][SEND] Connection state ${state}, triggering recovery`);
          handleConnectionDrop();
        }
      };

      const dc = rtc.getDataChannel();
      if (dc) {
        let senderStarted = false;
        const runSender = () => {
          if (senderStarted) return;
          senderStarted = true;
          console.log('[TRANSFER][SEND] DataChannel open, starting FileSender');
          updateSessionState(curDevice.token, curSession.session_id, 'TRANSFERRING').catch((err) => {
            console.error('[TRANSFER][SEND] Failed to update state to TRANSFERRING', err);
          });
          const devLogger = curSig && curDevice ? new RemoteDevLogger(curSig, curDevice.device_id) : undefined;
          const sender = new FileSender(dc, curFiles, { logger: devLogger });
          senderRef.current = sender;
          sender.onProgress = setTransferProgress;
          sender.onComplete = () => {
            console.log('[TRANSFER][SEND] FileSender completed');
            setScreenState('completed');
          };
          sender.onError = (e) => {
            if (screenRef.current === 'failed' || screenRef.current === 'cancelled' || screenRef.current === 'completed') {
              return;
            }
            console.error('[TRANSFER][SEND] FileSender error:', e);
            setError(e);
            setScreenState('failed');
          };
          sender.start();
        };

        if (dc.readyState === 'open') {
          runSender();
        } else {
          dc.addEventListener('open', runSender, { once: true });
        }
      }

      rtc.createOffer();
    } catch (err) {
      console.error('[TRANSFER][SEND] runSender FAILED:', err);
      setError('WebRTC initialization failed');
      setScreenState('failed');
    }
  };

  const startReceiving = (mode: 'nearby' | 'code' | 'qr' = 'code') => {
    setError(null);
    setRole('receiver');
    setReceiveMode(mode);
    setScreenState('receive');
  };

  const handleNearbyPaired = async (payload: {
    session_id: string;
    pairing_code: string;
    role: 'sender' | 'receiver';
    peer_ephemeral_id: string;
  }) => {
    let currentDevice = deviceRef.current;
    if (!currentDevice) {
      currentDevice = await handleAuthFailure();
      if (!currentDevice) {
        setError('Device registration failed. Please refresh.');
        return;
      }
    }
    setDeviceState(currentDevice);

    const sess: SessionInfo = {
      session_id: payload.session_id,
      pairing_code: payload.pairing_code,
      expires_at: '',
      state: 'PAIRED',
    };
    setSessionState(sess);

    const sig = new SignalingClient();
    sigRef.current = sig;

    if (payload.role === 'sender') {
      setRole('sender');
      setScreenState('send');

      sig.on('peer_joined', (msg: unknown) => {
        const p = (msg as { payload: DeviceInfo }).payload;
        setPeerDeviceState(p);
      });
      sig.on('peer_left', () => {
        handlePeerLeft();
      });
      sig.on('transfer_response', (msg: unknown) => {
        const p = (msg as { payload: { accepted: boolean } }).payload;
        if (p && p.accepted) {
          setScreenState('transfer');
          startWebRTCSender();
        } else {
          setError('Transfer declined by receiver');
          setScreenState('failed');
        }
      });
      sig.on('error', (msg: unknown) => {
        const p = (msg as { payload?: { message?: string } }).payload;
        setError(p?.message || 'Signaling error');
      });
      sig.connect(sess.session_id, currentDevice.token);
    } else {
      setRole('receiver');
      setScreenState('receive');

      sig.on('peer_joined', (msg: unknown) => {
        const p = (msg as { payload: DeviceInfo }).payload;
        setPeerDeviceState(p);
      });
      sig.on('file_metadata', (msg: unknown) => {
        const p = (msg as { payload: { files: FileInfo[]; total_size: number } }).payload;
        setIncomingFiles(p.files);
        setIncomingTotalSize(p.total_size);
        const curDev = deviceRef.current;
        if (curDev) {
          updateSessionState(curDev.token, sess.session_id, 'AWAITING_APPROVAL').catch(() => {});
        }
      });
      sig.on('signal', (msg: unknown) => {
        const signalMsg = msg as { from: string; payload: { signal_type: string; data: unknown } };
        const curDev = deviceRef.current;
        if (signalMsg.from !== curDev?.device_id && rtcRef.current) {
          rtcRef.current.handleSignal(signalMsg.payload);
        }
      });
      sig.on('dev_log', (msg: unknown) => {
        const p = (msg as { payload: RemoteLogPayload }).payload;
        if (p) {
          console.log(formatRemoteLog(p));
        }
      });
      sig.on('peer_left', () => {
        handlePeerLeft();
      });
      sig.connect(sess.session_id, currentDevice.token);
    }
  };

  const submitPairingCode = async (
    codeToJoin: string,
    targetDevice?: { device_id: string; display_name: string; token: string }
  ) => {
    if (codeToJoin.length !== 6) return;
    setJoining(true);
    setError(null);

    let currentDevice = targetDevice || deviceRef.current;
    if (!currentDevice) {
      currentDevice = await handleAuthFailure();
      if (!currentDevice) {
        setError('Device registration failed. Please refresh.');
        setJoining(false);
        return;
      }
    }
    setDeviceState(currentDevice);

    try {
      let res;
      try {
        res = await joinSession(currentDevice.token, codeToJoin);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('Authentication') || msg.includes('token') || msg.includes('401')) {
          const fresh = await handleAuthFailure();
          if (fresh) {
            currentDevice = fresh;
            res = await joinSession(fresh.token, codeToJoin);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      const sess: SessionInfo = {
        session_id: res.session_id,
        pairing_code: codeToJoin,
        expires_at: '',
        state: res.state as SessionState,
        sender: res.sender,
      };
      setSessionState(sess);
      setPeerDeviceState(res.sender || null);

      const sig = new SignalingClient();
      sigRef.current = sig;

      sig.on('file_metadata', (msg: unknown) => {
        const payload = (msg as { payload: { files: FileInfo[]; total_size: number } }).payload;
        setIncomingFiles(payload.files);
        setIncomingTotalSize(payload.total_size);
        const curDev = deviceRef.current;
        if (curDev) {
          updateSessionState(curDev.token, sess.session_id, 'AWAITING_APPROVAL').catch(() => {});
        }
      });

      sig.on('signal', (msg: unknown) => {
        const signalMsg = msg as { from: string; payload: { signal_type: string; data: unknown } };
        const curDev = deviceRef.current;
        if (signalMsg.from !== curDev?.device_id && rtcRef.current) {
          rtcRef.current.handleSignal(signalMsg.payload);
        }
      });

      sig.on('dev_log', (msg: unknown) => {
        const payload = (msg as { payload: RemoteLogPayload }).payload;
        if (payload) {
          console.log(formatRemoteLog(payload));
        }
      });

      sig.on('peer_left', () => {
        handlePeerLeft();
      });

      sig.connect(sess.session_id, currentDevice.token);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Invalid or expired pairing code');
    } finally {
      setJoining(false);
    }
  };

  const acceptTransfer = () => {
    const curSig = sigRef.current;
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;

    if (!curSig || !curSession || !curDevice) return;

    curSig.send({
      type: 'transfer_response',
      payload: { accepted: true },
    });

    updateSessionState(curDevice.token, curSession.session_id, 'CONNECTING').catch((err) => {
      console.error('[TRANSFER][RECEIVE] Failed to update state to CONNECTING', err);
    });

    const rtc = new WebRTCConnection(curSig, false);
    rtcRef.current = rtc;

    rtc.onConnectionStateChange = (state) => {
      if (state === 'failed' || state === 'disconnected') {
        handleConnectionDrop();
      }
    };

    rtc.onDataChannel = (dc) => {
      const receiver = new FileReceiver(dc, { storage: storageRef.current || undefined });
      receiverRef.current = receiver;
      let lastVerifyingFileIndex = -1;
      receiver.onProgress = (progress) => {
        setTransferProgress(progress);
        if (progress.state === 'verifying' && progress.currentFileIndex !== lastVerifyingFileIndex) {
          lastVerifyingFileIndex = progress.currentFileIndex;
          updateSessionState(curDevice.token, curSession.session_id, 'VERIFYING').catch((err) => {
            console.error('[TRANSFER][RECEIVE] Failed to update state to VERIFYING', err);
          });
        }
      };
      receiver.onComplete = (files) => {
        setCompletedFiles(files);
        setScreenState('completed');
        updateSessionState(curDevice.token, curSession.session_id, 'COMPLETED').catch((err) => {
          console.error('[TRANSFER][RECEIVE] Failed to update state to COMPLETED', err);
        });
      };
      receiver.onError = (err) => {
        if (screenRef.current === 'failed' || screenRef.current === 'cancelled' || screenRef.current === 'completed') {
          return;
        }
        console.error('[TRANSFER][RECEIVE] FileReceiver error:', err);
        setError(err);
        setScreenState('failed');
      };
      receiver.start();
    };

    setScreenState('transfer');
  };

  const rejectTransfer = () => {
    const curSig = sigRef.current;
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;

    if (!curSig || !curSession || !curDevice) return;
    curSig.send({
      type: 'transfer_response',
      payload: { accepted: false },
    });
    updateSessionState(curDevice.token, curSession.session_id, 'REJECTED').catch(() => {});
    goHome();
  };

  const cancelTransfer = () => {
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;

    if (senderRef.current) senderRef.current.cancel('User cancelled');
    if (receiverRef.current) receiverRef.current.cancel('User cancelled');
    if (curSession && curDevice) updateSessionState(curDevice.token, curSession.session_id, 'CANCELLED').catch(() => {});
    setScreenState('cancelled');
  };

  const handleCopyPairingCode = async () => {
    if (!session?.pairing_code) return;
    try {
      await navigator.clipboard.writeText(session.pairing_code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // fallback
    }
  };

  const totalStagedSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);

  return (
    <>
      <header className="app-header">
        <button type="button" className="brand-button" onClick={goHome} aria-label="JustShare Home">
          <div className="brand-icon-wrapper">
            <IconLogo size={18} />
          </div>
          <span>JustShare</span>
        </button>

        <div className="header-actions">
          {device && (
            <button
              type="button"
              className="device-chip"
              onClick={() => setIsRenameModalOpen(true)}
              title="Click to rename your device"
              aria-label={`Device: ${device.display_name}. Click to rename.`}
            >
              <DeviceAvatar name={device.display_name} size="sm" showBadge={false} />
              <span className="device-chip-name">{device.display_name}</span>
              <IconEdit size={14} className="device-chip-edit-icon" />
            </button>
          )}

          <button
            type="button"
            className="theme-toggle-btn"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? <IconMoon size={18} /> : <IconSun size={18} />}
          </button>
        </div>
      </header>

      <main className="app-main">
        {error && (
          <div className="global-error-banner" role="alert">
            <IconAlertCircle size={20} />
            <span>{error}</span>
          </div>
        )}

        {/* Hidden inputs for file/folder pickers */}
        <input
          ref={fileInputRef}
          id="file-input"
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            handleFileSelect(e.target.files);
            e.target.value = '';
          }}
        />
        {supportsDirectoryUpload() && (
          <input
            ref={folderInputRef}
            id="folder-input"
            type="file"
            // @ts-expect-error - webkitdirectory is standard in browsers but not yet in standard React HTMLInput types
            webkitdirectory=""
            directory=""
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              handleFileSelect(e.target.files);
              e.target.value = '';
            }}
          />
        )}

        {/* Screen 1: Home (Direct Tool Interface) */}
        {screen === 'home' && (
          <div className="screen-container home-tool-layout">
            <div className="home-primary-grid">
              {/* Primary Dropzone */}
              <Card padding="none" className="dropzone-container">
                <div
                  className={`dropzone-area ${dragOver ? 'is-drag-over' : ''}`}
                  tabIndex={0}
                  role="button"
                  aria-label="Drop files or click to choose files"
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    handleFileSelect(e.dataTransfer.files);
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                >
                  <div className="dropzone-icon">
                    <IconUpload size={26} />
                  </div>
                  <h2 className="dropzone-title">Drop files or folders to send</h2>
                  <p className="dropzone-subtitle">or click anywhere to browse</p>

                  <div className="dropzone-actions" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="action-choose-files"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Choose files
                    </Button>
                    {supportsDirectoryUpload() && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="action-choose-folder"
                        icon={<IconFolder size={14} />}
                        onClick={() => folderInputRef.current?.click()}
                      >
                        Choose folder
                      </Button>
                    )}
                  </div>
                </div>
              </Card>

              {/* Receive Quick Action Card */}
              <Card padding="md" className="receive-quick-card">
                <div className="section-header">
                  <h3 className="section-title">Receive Files</h3>
                  <StatusChip status="default" icon={<IconDownload size={14} />}>
                    Direct P2P
                  </StatusChip>
                </div>

                <div className="receive-options-list">
                  <button
                    type="button"
                    className="receive-option-btn"
                    onClick={() => startReceiving('code')}
                  >
                    <div className="receive-option-icon">
                      <IconKeypad size={20} />
                    </div>
                    <div className="receive-option-info">
                      <span className="receive-option-title">Enter 6-Digit Code</span>
                      <span className="receive-option-desc">Connect with a sender’s temporary code</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    className="receive-option-btn"
                    onClick={() => startReceiving('qr')}
                  >
                    <div className="receive-option-icon">
                      <IconQrCode size={20} />
                    </div>
                    <div className="receive-option-info">
                      <span className="receive-option-title">Scan QR Code</span>
                      <span className="receive-option-desc">Pair immediately with a camera</span>
                    </div>
                  </button>
                </div>
              </Card>
            </div>

            {/* Staged Files Preview (if user selected files) */}
            {selectedFiles.length > 0 && (
              <Card padding="md" className="staged-files-card">
                <div className="staged-files-header">
                  <h3 className="section-title">Files Ready to Send</h3>
                  <span className="staged-files-count">
                    {selectedFiles.length} item{selectedFiles.length === 1 ? '' : 's'} · {formatBytes(totalStagedSize)}
                  </span>
                </div>

                <div className="staged-files-list">
                  {selectedFiles.map((file, idx) => (
                    <FileRow
                      key={idx}
                      name={file.name}
                      size={file.size}
                      relativePath={file.webkitRelativePath}
                      onRemove={() => handleRemoveFile(idx)}
                    />
                  ))}
                </div>

                <div className="staged-files-summary">
                  <Button variant="ghost" onClick={() => setSelectedFilesState([])}>
                    Clear all
                  </Button>
                  <Button variant="primary" size="lg" onClick={startSending}>
                    Generate Code & Send
                  </Button>
                </div>
              </Card>
            )}

            {/* Live Nearby Discovery Section on Home */}
            <div className="nearby-live-section">
              <div className="section-header">
                <h3 className="section-title">Nearby Devices on Network</h3>
                <StatusChip status="info" pulse>
                  Searching Wi-Fi
                </StatusChip>
              </div>

              {device && (
                <NearbyDiscovery
                  token={device.token}
                  displayName={device.display_name}
                  variant="embedded"
                  onPaired={handleNearbyPaired}
                  onSelectCode={() => startReceiving('code')}
                  onSelectQr={() => startReceiving('qr')}
                  onTokenRefreshed={(newToken) => {
                    if (deviceRef.current) {
                      setDeviceState({ ...deviceRef.current, token: newToken });
                    }
                  }}
                />
              )}
            </div>
          </div>
        )}

        {/* Screen 2: Sender Waiting Screen */}
        {screen === 'send' && session && (
          <div className="screen-container">
            <div className="section-header">
              <Button variant="ghost" size="sm" icon={<IconArrowLeft size={16} />} onClick={goHome}>
                Cancel Session
              </Button>
              <StatusChip status="info" pulse>
                Waiting for receiver
              </StatusChip>
            </div>

            {!peerDevice ? (
              <Card padding="lg">
                <div className="sender-waiting-grid">
                  {/* Left Column: 6-Digit Code */}
                  <div className="code-display-box">
                    <div>
                      <h3 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '4px' }}>
                        Pairing Code
                      </h3>
                      <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                        Enter this 6-digit code on the receiving device
                      </p>
                    </div>

                    <div className="code-large-banner">
                      {session.pairing_code.split('').map((digit, i) => (
                        <div key={i} className="code-large-digit">
                          {digit}
                        </div>
                      ))}
                    </div>

                    <Button
                      variant="secondary"
                      icon={copiedCode ? <IconCheck size={16} /> : <IconCopy size={16} />}
                      onClick={handleCopyPairingCode}
                    >
                      {copiedCode ? 'Code Copied!' : 'Copy Code'}
                    </Button>

                    <div className="code-expiry-badge">
                      <IconClock size={14} />
                      <span>Code expires in 10 minutes</span>
                    </div>
                  </div>

                  {/* Right Column: QR Code */}
                  <div className="qr-display-container">
                    <QRCodeDisplay pairingCode={session.pairing_code} />
                  </div>
                </div>
              </Card>
            ) : (
              /* Receiver Connected - Send Confirmation */
              <Card padding="md">
                <div className="section-header">
                  <div className="peer-identity-chip">
                    <DeviceAvatar name={peerDevice.display_name} size="md" />
                    <div>
                      <span className="peer-name">{peerDevice.display_name}</span>
                      <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        Connected Receiver
                      </span>
                    </div>
                  </div>
                  <StatusChip status="success" icon={<IconCheck size={14} />}>
                    Connected
                  </StatusChip>
                </div>

                {selectedFiles.length > 0 ? (
                  <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div className="staged-files-list">
                      {selectedFiles.map((file, idx) => (
                        <FileRow
                          key={idx}
                          name={file.name}
                          size={file.size}
                          relativePath={file.webkitRelativePath}
                          onRemove={() => handleRemoveFile(idx)}
                        />
                      ))}
                    </div>
                    <Button variant="primary" size="lg" onClick={sendFileMetadata}>
                      Send {selectedFiles.length} File{selectedFiles.length === 1 ? '' : 's'} to {peerDevice.display_name}
                    </Button>
                  </div>
                ) : (
                  <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
                    <Button variant="primary" size="lg" onClick={() => fileInputRef.current?.click()}>
                      Choose Files to Send
                    </Button>
                  </div>
                )}
              </Card>
            )}
          </div>
        )}

        {/* Screen 3: Receive Screen (Code / QR / Nearby Mode) */}
        {screen === 'receive' && (
          <div className="screen-container">
            {!session ? (
              <Card padding="lg">
                <div className="section-header" style={{ marginBottom: '1.5rem' }}>
                  <Button variant="ghost" size="sm" icon={<IconArrowLeft size={16} />} onClick={goHome}>
                    Back
                  </Button>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <Button
                      variant={receiveMode === 'code' ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => setReceiveMode('code')}
                    >
                      6-Digit Code
                    </Button>
                    <Button
                      variant={receiveMode === 'qr' ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => setReceiveMode('qr')}
                    >
                      Scan QR
                    </Button>
                    <Button
                      variant={receiveMode === 'nearby' ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => setReceiveMode('nearby')}
                    >
                      Nearby
                    </Button>
                  </div>
                </div>

                {receiveMode === 'code' && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}>
                    <div style={{ textAlign: 'center' }}>
                      <h3 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Enter 6-Digit Code</h3>
                      <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                        Enter the pairing code displayed on the sender’s screen
                      </p>
                    </div>

                    <CodeInput
                      value={pairingInput}
                      onChange={(val) => {
                        setPairingInput(val);
                        setError(null);
                      }}
                      onSubmit={(code) => submitPairingCode(code)}
                      disabled={joining}
                      error={error}
                    />

                    {joining && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)' }}>
                        <span className="btn-spinner" />
                        <span>Connecting to sender…</span>
                      </div>
                    )}
                  </div>
                )}

                {receiveMode === 'qr' && (
                  <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                    <div style={{ marginBottom: '1rem', color: 'var(--accent-primary)' }}>
                      <IconQrCode size={48} />
                    </div>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Scan QR Code</h3>
                    <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', maxWidth: '380px', margin: '0.5rem auto 1.5rem' }}>
                      Point your phone’s camera at the QR code shown on the sender’s device to open the session automatically.
                    </p>
                  </div>
                )}

                {receiveMode === 'nearby' && device && (
                  <NearbyDiscovery
                    token={device.token}
                    displayName={device.display_name}
                    variant="standalone"
                    onPaired={handleNearbyPaired}
                    onSelectCode={() => setReceiveMode('code')}
                    onSelectQr={() => setReceiveMode('qr')}
                    onClose={goHome}
                  />
                )}
              </Card>
            ) : incomingFiles.length === 0 ? (
              /* Connected, waiting for sender to pick files */
              <Card padding="lg" style={{ textAlign: 'center' }}>
                <div style={{ margin: '1rem auto' }}>
                  <span className="btn-spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
                </div>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 600 }}>
                  Connected to {peerDevice?.display_name || 'Sender'}
                </h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Waiting for the sender to select files…
                </p>
              </Card>
            ) : (
              /* Incoming Transfer Approval Card */
              <Card padding="lg">
                <div className="section-header">
                  <div className="peer-identity-chip">
                    <DeviceAvatar name={peerDevice?.display_name || 'Sender'} size="md" />
                    <div>
                      <span className="peer-name">{peerDevice?.display_name || 'Sender'}</span>
                      <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        Wants to send {incomingFiles.length} file{incomingFiles.length === 1 ? '' : 's'} ({formatBytes(incomingTotalSize)})
                      </span>
                    </div>
                  </div>
                  <StatusChip status="info">Incoming Transfer</StatusChip>
                </div>

                <div className="staged-files-list" style={{ margin: '1.5rem 0' }}>
                  {incomingFiles.map((file, idx) => (
                    <FileRow key={idx} name={file.name} size={file.size} />
                  ))}
                </div>

                <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                  <Button variant="secondary" onClick={rejectTransfer}>
                    Decline
                  </Button>
                  <Button variant="primary" size="lg" onClick={acceptTransfer}>
                    Accept & Download
                  </Button>
                </div>
              </Card>
            )}
          </div>
        )}

        {/* Screen 4: Active Transfer Progress */}
        {screen === 'transfer' && (
          <div className="screen-container">
            <Card padding="lg">
              <div className="transfer-header">
                <div className="peer-identity-chip">
                  <DeviceAvatar name={peerDevice?.display_name || 'Peer'} size="md" />
                  <div>
                    <span className="peer-name">{peerDevice?.display_name || 'Peer'}</span>
                    <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {transferProgress?.state === 'reconnecting'
                        ? 'Reconnecting…'
                        : transferProgress?.state === 'verifying'
                        ? 'Verifying integrity…'
                        : 'Transferring data…'}
                    </span>
                  </div>
                </div>

                <StatusChip status="info" icon={<IconShield size={14} />}>
                  Direct · Encrypted
                </StatusChip>
              </div>

              {transferProgress ? (
                <div style={{ margin: '1.5rem 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>
                      {transferProgress.currentFile}
                    </span>
                    <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                      File {transferProgress.currentFileIndex + 1} of {transferProgress.totalFiles}
                    </span>
                  </div>

                  <ProgressBar
                    value={transferProgress.percentage}
                    size="lg"
                    status={transferProgress.state === 'reconnecting' ? 'warning' : 'default'}
                  />

                  <div className="transfer-stats-grid">
                    <div className="stat-box">
                      <span className="stat-label">Progress</span>
                      <span className="stat-value">
                        {formatBytes(transferProgress.bytesTransferred)} / {formatBytes(transferProgress.totalBytes)}
                      </span>
                    </div>

                    <div className="stat-box">
                      <span className="stat-label">Speed</span>
                      <span className="stat-value">{formatSpeed(transferProgress.speed)}</span>
                    </div>

                    <div className="stat-box">
                      <span className="stat-label">Estimated Time</span>
                      <span className="stat-value">{formatEta(transferProgress.eta)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '2rem 0', textAlign: 'center' }}>
                  <span className="btn-spinner" style={{ width: 24, height: 24 }} />
                  <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '8px' }}>
                    Establishing direct WebRTC peer connection…
                  </p>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '1rem', borderTop: '1px solid var(--border-default)' }}>
                <Button variant="danger" onClick={cancelTransfer}>
                  Cancel Transfer
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* Screen 5: Transfer Completed */}
        {screen === 'completed' && (
          <div className="screen-container">
            <Card padding="none" className="result-screen-card">
              <div className="result-icon-large result-icon-success">
                <IconCheckCircle size={36} />
              </div>

              <div>
                <h2 className="result-title">Transfer Completed!</h2>
                <p className="result-desc">
                  All files were transferred and cryptographically verified with SHA-256 integrity.
                </p>
              </div>

              {completedFiles.length > 0 && (
                <div className="completed-files-list">
                  {completedFiles.map((file, i) => (
                    <div key={i} className="download-row">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <IconCheckCircle size={18} style={{ color: 'var(--success)' }} />
                        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{file.name}</span>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<IconDownload size={14} />}
                        onClick={() => {
                          const url = URL.createObjectURL(file.blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = file.name;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        Download
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px', marginTop: '1rem' }}>
                <Button variant="secondary" onClick={goHome}>
                  Send More Files
                </Button>
                <Button variant="primary" onClick={goHome}>
                  Done
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* Screen 6: Failed or Cancelled */}
        {(screen === 'failed' || screen === 'cancelled') && (
          <div className="screen-container">
            <Card padding="none" className="result-screen-card">
              <div className="result-icon-large result-icon-error">
                <IconAlertCircle size={36} />
              </div>

              <div>
                <h2 className="result-title">
                  {screen === 'cancelled' ? 'Transfer Cancelled' : 'Transfer Failed'}
                </h2>
                <p className="result-desc">
                  {error ||
                    (screen === 'cancelled'
                      ? 'The file transfer was stopped by user request.'
                      : 'An unexpected connection or transfer error occurred.')}
                </p>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginTop: '1rem' }}>
                <Button variant="secondary" icon={<IconRefreshCw size={14} />} onClick={goHome}>
                  Try Again
                </Button>
                <Button variant="primary" onClick={goHome}>
                  Return Home
                </Button>
              </div>
            </Card>
          </div>
        )}
      </main>

      <footer className="app-footer">
        <IconShield size={14} />
        <span>End-to-end encrypted · Direct WebRTC transfer · Zero server storage</span>
      </footer>

      {/* Friendly Name Rename Modal */}
      {device && (
        <DeviceEditModal
          isOpen={isRenameModalOpen}
          currentName={device.display_name}
          onSave={handleRenameDevice}
          onClose={() => setIsRenameModalOpen(false)}
        />
      )}
    </>
  );
}
