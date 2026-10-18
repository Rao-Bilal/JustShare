import { useEffect, useRef, useState } from 'react';
import { createSession, getSession, joinSession, updateSessionState } from '../services/api';
import { formatBytes } from '../services/format';
import { SignalingClient } from '../services/signaling';
import { createTransferStorage, TransferStorage } from '../services/storage';
import { FileReceiver, FileSender } from '../services/transfer';
import { WebRTCConnection } from '../services/webrtc';
import { AppScreen, DeviceInfo, FileInfo, SessionInfo, SessionState, TransferProgress } from '../types';
import { decidePeerLeftAction } from '../services/peerLeft';
import { determineInitialUrlAction } from '../services/pairingUrl';
import { mapTechnicalError } from '../services/errorMapper';
import { COPY } from '../copy';

import { NearbyDiscovery } from '../components/NearbyDiscovery';
import { QrScanner } from '../components/QrScanner';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Stepper } from '../components/Stepper';
import { CodeInput } from '../components/CodeInput';
import { FileRow } from '../components/FileRow';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DeviceEditModal } from '../components/DeviceEditModal';
import { ShareManagementModal } from '../components/ShareManagementModal';
import { FileManagerDashboard, HistoryItem } from '../components/FileManagerDashboard';
import { getOrCreateDevice, renameDevice, supportsDirectoryUpload } from '../services/device';

import { TransferScreen } from '../components/TransferScreen';
import { mapScreenToMainView } from '../services/transferState';

export function App() {
  const [device, setDevice] = useState<{ device_id: string; display_name: string; token: string } | null>(null);
  const [screen, setScreen] = useState<AppScreen>('home');
  const screenRef = useRef<AppScreen>('home');
  const [role, setRole] = useState<'sender' | 'receiver' | null>(null);
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
  const [receiveMode, setReceiveMode] = useState<'code' | 'qr' | 'nearby'>('code');
  const [mobilePanel, setMobilePanel] = useState<'send' | 'receive'>('send');
  const [isTechDetailsOpen, setIsTechDetailsOpen] = useState(false);
  const [nearbyNotice, setNearbyNotice] = useState<string | null>(null);

  // Device Edit Modal state
  const [isEditNameOpen, setIsEditNameOpen] = useState(false);

  // Cancel confirmation & countdown states
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [transferDurationSecs, setTransferDurationSecs] = useState<number | null>(null);
  const transferStartTimeRef = useRef<number | null>(null);

  // Expiration countdown
  const [expirySecondsLeft, setExpirySecondsLeft] = useState<number | null>(null);

  // Storage space warning & quota
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [storageEstimate, setStorageEstimate] = useState<{ used: number; quota: number } | null>(null);

  // Header Nav Tab & File Manager Dashboard
  const [activeHeaderTab, setActiveHeaderTab] = useState<'transfer' | 'dashboard'>('transfer');
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [isHeroDragging, setIsHeroDragging] = useState(false);

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

  // Expiration countdown timer
  useEffect(() => {
    if (screen === 'send' && session?.expires_at) {
      const targetTime = new Date(session.expires_at).getTime();
      const updateLeft = () => {
        const now = Date.now();
        const diff = Math.max(0, Math.floor((targetTime - now) / 1000));
        setExpirySecondsLeft(diff);
      };
      updateLeft();
      const interval = setInterval(updateLeft, 1000);
      return () => clearInterval(interval);
    } else {
      setExpirySecondsLeft(null);
    }
  }, [screen, session]);

  useEffect(() => {
    createTransferStorage()
      .then((storage) => {
        storageRef.current = storage;
      })
      .catch((err) => {
        console.warn('Failed to initialize transfer storage:', err);
      });

    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((est) => {
        if (est.quota !== undefined && est.usage !== undefined) {
          setStorageEstimate({ used: est.usage, quota: est.quota });
        }
      }).catch(() => {});
    }

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
        const errorMsg = e instanceof Error ? e.message : 'Device registration failed';
        setError(errorMsg);
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
    setShowCancelConfirm(false);
    setTransferDurationSecs(null);
    transferStartTimeRef.current = null;
    setStorageWarning(null);
  };

  const handleSaveDeviceName = async (newName: string) => {
    const updated = await renameDevice(newName);
    setDeviceState(updated);
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
      if (senderRef.current) senderRef.current.cancel('Peer disconnected');
      if (receiverRef.current) receiverRef.current.cancel('Peer disconnected');
      if (rtcRef.current) rtcRef.current.close();
      if (sigRef.current) sigRef.current.disconnect();

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
    }
  };

  // Sender flow
  const startSending = async () => {
    const currentDevice = deviceRef.current;
    if (!currentDevice) return;

    try {
      setError(null);
      setRole('sender');
      const res = await createSession(currentDevice.token);

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
        const payload = (msg as { payload: { accepted: boolean } }).payload;
        if (payload && payload.accepted) {
          setScreenState('transfer');
          startWebRTCSender();
        } else {
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

      return [...prevFiles, ...uniqueAdditions];
    });
  };

  const handleRemoveFile = (indexToRemove: number) => {
    setSelectedFilesState((prev) => prev.filter((_, idx) => idx !== indexToRemove));
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

    curSig.send({
      type: 'file_metadata',
      payload: {
        files: filesMeta,
        total_size: totalSize,
      },
    });
    setScreenState('send');
  };

  const startWebRTCSender = () => {
    const curSig = sigRef.current;
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;
    const curFiles = selectedFilesRef.current;

    if (!curSig || !curSession || !curDevice) {
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
          handlePeerLeft();
        }
      };

      const dc = rtc.getDataChannel();
      if (dc) {
        let senderStarted = false;
        const runSender = () => {
          if (senderStarted) return;
          senderStarted = true;
          updateSessionState(curDevice.token, curSession.session_id, 'TRANSFERRING').catch(() => {});
          const sender = new FileSender(dc, curFiles);
          senderRef.current = sender;
          transferStartTimeRef.current = Date.now();
          sender.onProgress = setTransferProgress;
          sender.onComplete = () => {
            if (transferStartTimeRef.current) {
              setTransferDurationSecs((Date.now() - transferStartTimeRef.current) / 1000);
            }
            // Record in dashboard history
            const newHistoryEntries: HistoryItem[] = curFiles.map((file, idx) => ({
              id: `sent_${Date.now()}_${idx}`,
              name: file.webkitRelativePath || file.name,
              size: file.size,
              direction: 'sent',
              timestamp: Date.now(),
              peerName: peerDeviceRef.current?.display_name,
              verified: true,
            }));
            setHistoryItems((prev) => [...newHistoryEntries, ...prev]);
            setScreenState('completed');
          };
          sender.onError = (e) => {
            if (screenRef.current === 'failed' || screenRef.current === 'cancelled' || screenRef.current === 'completed') {
              return;
            }
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
    } catch {
      setError('WebRTC initialization failed');
      setScreenState('failed');
    }
  };

  const startReceiving = (mode: 'code' | 'qr' | 'nearby' = 'code') => {
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
    const currentDevice = deviceRef.current;
    if (!currentDevice) return;

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

    const currentDevice = targetDevice || deviceRef.current;
    if (!currentDevice) {
      setError('Device not initialized');
      setJoining(false);
      return;
    }

    try {
      const res = await joinSession(currentDevice.token, codeToJoin);

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

        // Check storage quota if available
        if (navigator.storage && navigator.storage.estimate) {
          navigator.storage.estimate().then((est) => {
            if (est.quota !== undefined && est.usage !== undefined) {
              const freeSpace = est.quota - est.usage;
              if (freeSpace < payload.total_size) {
                setStorageWarning(
                  COPY.receive.storageWarning(formatBytes(freeSpace), formatBytes(payload.total_size))
                );
              }
            }
          }).catch(() => {});
        }

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

    updateSessionState(curDevice.token, curSession.session_id, 'CONNECTING').catch(() => {});

    const rtc = new WebRTCConnection(curSig, false);
    rtcRef.current = rtc;

    rtc.onConnectionStateChange = (state) => {
      if (state === 'failed' || state === 'disconnected') {
        handlePeerLeft();
      }
    };

    rtc.onDataChannel = (dc) => {
      const receiver = new FileReceiver(dc, { storage: storageRef.current || undefined });
      receiverRef.current = receiver;
      transferStartTimeRef.current = Date.now();
      let lastVerifyingFileIndex = -1;
      receiver.onProgress = (progress) => {
        setTransferProgress(progress);
        if (progress.state === 'verifying' && progress.currentFileIndex !== lastVerifyingFileIndex) {
          lastVerifyingFileIndex = progress.currentFileIndex;
          updateSessionState(curDevice.token, curSession.session_id, 'VERIFYING').catch(() => {});
        }
      };
      receiver.onComplete = (files) => {
        if (transferStartTimeRef.current) {
          setTransferDurationSecs((Date.now() - transferStartTimeRef.current) / 1000);
        }
        setCompletedFiles(files);
        // Record in dashboard history
        const newHistoryEntries: HistoryItem[] = files.map((file, idx) => ({
          id: `recv_${Date.now()}_${idx}`,
          name: file.name,
          size: file.blob.size,
          direction: 'received',
          timestamp: Date.now(),
          peerName: peerDeviceRef.current?.display_name,
          verified: file.verified,
          blob: file.blob,
        }));
        setHistoryItems((prev) => [...newHistoryEntries, ...prev]);
        setScreenState('completed');
        updateSessionState(curDevice.token, curSession.session_id, 'COMPLETED').catch(() => {});
      };
      receiver.onError = (err) => {
        if (screenRef.current === 'failed' || screenRef.current === 'cancelled' || screenRef.current === 'completed') {
          return;
        }
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

  const handleCancelClick = () => {
    const percentage = transferProgress?.percentage || 0;
    if (percentage > 10) {
      setShowCancelConfirm(true);
    } else {
      executeCancel();
    }
  };

  const executeCancel = () => {
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;

    if (senderRef.current) senderRef.current.cancel('User cancelled');
    if (receiverRef.current) receiverRef.current.cancel('User cancelled');
    if (curSession && curDevice) updateSessionState(curDevice.token, curSession.session_id, 'CANCELLED').catch(() => {});
    setShowCancelConfirm(false);
    setScreenState('cancelled');
  };

  const totalStagedSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);

  return (
    <>
      {/* BEGIN: MainHeader */}
      <header className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-12 pt-4 sm:pt-6 pb-2 flex items-center justify-between" data-purpose="site-navigation">
        {/* Brand Logo */}
        <div className="flex items-center gap-3">
          <button type="button" className="flex items-center gap-2 group focus:outline-none bg-transparent border-0 cursor-pointer p-0 text-left" onClick={goHome}>
            <div className="w-7 h-7 rounded-lg bg-brand-charcoal text-white flex items-center justify-center font-bold text-sm tracking-tight shadow-sm group-hover:scale-105 transition-transform">
              JS
            </div>
            <span className="text-xl font-bold tracking-tight text-neutral-900">JustShare</span>
          </button>
        </div>

        {/* Navigation Links (Desktop) */}
        <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-neutral-600">
          <a className="hover:text-neutral-900 transition-colors text-neutral-600 no-underline" href="#how-it-works">
            {COPY.home.howItWorksTitle}
          </a>
        </nav>

        {/* Right Device Identity Pill */}
        <div className="flex items-center gap-3">
          {device && (
            <button
              type="button"
              className="frosted-glass px-3.5 py-1.5 rounded-full shadow-sm flex items-center gap-2 text-xs font-medium text-neutral-700 hover:border-neutral-300 transition-all cursor-pointer group border border-neutral-200"
              title="Click to rename this device"
              onClick={() => setIsEditNameOpen(true)}
              aria-label={`This device: ${device.display_name}. Click to rename.`}
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping-subtle absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span>{COPY.header.thisDevice}:</span>
              <span className="font-semibold text-neutral-900 group-hover:text-brand-orange transition-colors">
                {device.display_name}
              </span>
              <svg className="w-3.5 h-3.5 text-neutral-400 group-hover:rotate-180 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
              </svg>
            </button>
          )}
          {screen !== 'home' && (
            <Button variant="link" onClick={goHome}>
              {COPY.header.home}
            </Button>
          )}
        </div>
      </header>
      {/* END: MainHeader */}

      <main className="app-main">
        {/* Hidden file pickers */}
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
            // @ts-expect-error - webkitdirectory standard in browsers
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

        {/* =========================================================================
            DASHBOARD / FILE MANAGER VIEW (When tab selected)
            ========================================================================= */}
        {activeHeaderTab === 'dashboard' ? (
          <div className="screen-wrapper">
            <FileManagerDashboard
              history={historyItems}
              onClearHistory={() => setHistoryItems([])}
              onSendNew={() => {
                setActiveHeaderTab('transfer');
                startSending();
              }}
              onReceiveNew={() => {
                setActiveHeaderTab('transfer');
                startReceiving('code');
              }}
              storageEstimate={storageEstimate}
            />
          </div>
        ) : (
          <>
            {/* =========================================================================
                SCREEN 1: HOME (Send+ Dual-Zone Workspace + Vermilion Spotlight Card)
                ========================================================================= */}
            {screen === 'home' && (
              <div className="w-full">
                {/* Top Headline Section */}
                <div className="mb-4 sm:mb-6 flex flex-col md:flex-row md:items-end justify-between gap-3">
                  <div>
                    <div className="flex items-baseline gap-2">
                      <h1 className="text-5xl sm:text-6xl lg:text-7xl font-serif tracking-tight text-neutral-950 font-normal leading-none select-none">
                        Send<span className="text-3xl md:text-4xl text-neutral-400 font-sans font-light align-super ml-0.5">+</span>
                      </h1>
                      <span className="text-neutral-500 text-sm hidden sm:inline-block ml-3 font-normal max-w-sm">
                        {COPY.home.tagline}
                      </span>
                    </div>
                  </div>
                  {/* Mobile-only Segmented Control (Actually switches panels on <768px) */}
                  <div className="flex p-1 bg-neutral-200/70 rounded-xl max-w-fit md:hidden text-xs font-semibold">
                    <button
                      className={`px-4 py-2 rounded-lg border-0 cursor-pointer transition-all ${
                        mobilePanel === 'send'
                          ? 'bg-white shadow-sm text-neutral-900 font-bold'
                          : 'bg-transparent text-neutral-600'
                      }`}
                      type="button"
                      onClick={() => setMobilePanel('send')}
                    >
                      {COPY.home.sendTab}
                    </button>
                    <button
                      className={`px-4 py-2 rounded-lg border-0 cursor-pointer transition-all ${
                        mobilePanel === 'receive'
                          ? 'bg-white shadow-sm text-neutral-900 font-bold'
                          : 'bg-transparent text-neutral-600'
                      }`}
                      type="button"
                      onClick={() => setMobilePanel('receive')}
                    >
                      {COPY.home.receiveTab}
                    </button>
                  </div>
                </div>

                {/* Primary Layout Grid: Split Transfer Panel + Spotlight Card */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 lg:gap-8 items-stretch">
                  {/* LEFT & CENTER: Structured Dual-Zone Workspace (Send + Receive side by side) */}
                  <div className="lg:col-span-7 xl:col-span-8 flex flex-col">
                    {/* Master Glass Card */}
                    <div className="frosted-glass rounded-3xl p-5 sm:p-7 lg:p-8 shadow-glass border border-white/90 relative overflow-hidden flex flex-col justify-between h-full">
                      {/* Upper Action Split */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8 relative">
                        {/* ZONE 1: SEND FILES (Visible on desktop/tablet, or on mobile when mobilePanel === 'send') */}
                        <section
                          className={`flex flex-col justify-between ${
                            mobilePanel === 'receive' ? 'hidden md:flex' : 'flex'
                          }`}
                          data-purpose="send-action-zone"
                        >
                          <div>
                            {/* Zone Header */}
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-brand-orange"></span>
                                <h2 className="text-base font-bold text-neutral-900 tracking-tight">
                                  {COPY.home.sendCardTitle}
                                </h2>
                              </div>
                            </div>

                            {/* Drag & Drop Zone Box */}
                            <div
                              className={`border-2 border-dashed rounded-2xl p-5 text-center cursor-pointer group flex flex-col items-center justify-center min-h-[145px] transition-all ${
                                isHeroDragging
                                  ? 'border-brand-orange bg-orange-50/60'
                                  : 'border-neutral-300 hover:border-brand-orange/80 bg-white/50 hover:bg-orange-50/30'
                              }`}
                              id="drop-zone"
                              tabIndex={0}
                              role="button"
                              aria-label="Drop files here or click to browse"
                              onClick={() => fileInputRef.current?.click()}
                              onDragOver={(e) => {
                                e.preventDefault();
                                setIsHeroDragging(true);
                              }}
                              onDragLeave={() => setIsHeroDragging(false)}
                              onDrop={(e) => {
                                e.preventDefault();
                                setIsHeroDragging(false);
                                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                  handleFileSelect(e.dataTransfer.files);
                                  startSending();
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  fileInputRef.current?.click();
                                }
                              }}
                            >
                              <div className="w-10 h-10 rounded-full bg-neutral-100 group-hover:bg-brand-orange/10 flex items-center justify-center text-neutral-600 group-hover:text-brand-orange transition-colors mb-2">
                                <svg className="w-5 h-5 transition-transform group-hover:-translate-y-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                                </svg>
                              </div>
                              <p className="text-sm font-semibold text-neutral-800 group-hover:text-brand-orange transition-colors">
                                {COPY.home.dropPrompt}
                              </p>
                              <p className="text-xs text-neutral-600 mt-0.5">{COPY.home.dropSub}</p>
                            </div>

                            {/* Action Button Group */}
                            <div className="grid grid-cols-2 gap-2 mt-3">
                              <button
                                className="w-full bg-brand-charcoal hover:bg-neutral-800 active:scale-[0.98] text-white text-xs font-semibold py-2.5 px-3 rounded-xl transition-all shadow-sm flex items-center justify-center gap-1.5 border-0 cursor-pointer min-h-[44px]"
                                onClick={() => fileInputRef.current?.click()}
                                type="button"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path d="M12 4v16m8-8H4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                                </svg>
                                {COPY.home.chooseFilesBtn}
                              </button>
                              {supportsDirectoryUpload() ? (
                                <button
                                  className="w-full bg-white hover:bg-neutral-50 active:scale-[0.98] border border-neutral-300 text-neutral-700 text-xs font-semibold py-2.5 px-3 rounded-xl transition-all flex items-center justify-center gap-1.5 cursor-pointer min-h-[44px]"
                                  onClick={() => folderInputRef.current?.click()}
                                  type="button"
                                >
                                  <svg className="w-3.5 h-3.5 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                                  </svg>
                                  {COPY.home.chooseFolderBtn}
                                </button>
                              ) : (
                                <button
                                  className="w-full bg-white hover:bg-neutral-50 active:scale-[0.98] border border-neutral-300 text-neutral-700 text-xs font-semibold py-2.5 px-3 rounded-xl transition-all flex items-center justify-center gap-1.5 cursor-pointer min-h-[44px]"
                                  onClick={startSending}
                                  type="button"
                                >
                                  {COPY.home.startSessionBtn}
                                </button>
                              )}
                            </div>
                          </div>
                        </section>

                        {/* Vertical Separator Divider (Visible on desktop/tablet) */}
                        <div className="hidden md:block absolute left-1/2 top-1 bottom-1 w-[1px] bg-gradient-to-b from-transparent via-neutral-200 to-transparent"></div>

                        {/* ZONE 2: RECEIVE FILES (Visible on desktop/tablet, or on mobile when mobilePanel === 'receive') */}
                        <section
                          className={`flex flex-col justify-between pt-4 md:pt-0 border-t md:border-t-0 border-neutral-200/80 ${
                            mobilePanel === 'send' ? 'hidden md:flex' : 'flex'
                          }`}
                          data-purpose="receive-action-zone"
                        >
                          <div>
                            {/* Zone Header */}
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                                <h2 className="text-base font-bold text-neutral-900 tracking-tight">
                                  {COPY.home.receiveCardTitle}
                                </h2>
                              </div>
                            </div>

                            <label className="block text-xs font-medium text-neutral-600 mb-2">
                              {COPY.home.enterCodeLabel}
                            </label>

                            {/* Code Input Display Container */}
                            <div className="relative mb-3">
                              <CodeInput
                                value={pairingInput}
                                onChange={(val) => {
                                  setPairingInput(val);
                                  setError(null);
                                }}
                                onSubmit={(code) => submitPairingCode(code)}
                                disabled={joining}
                                error={error ? mapTechnicalError(error).headline : null}
                              />
                            </div>

                            {/* Action Button Group for Receiving */}
                            <div className="flex flex-col gap-2">
                              <button
                                className="w-full bg-brand-charcoal hover:bg-neutral-800 active:scale-[0.98] text-white text-xs font-semibold py-2.5 px-4 rounded-xl transition-all shadow-sm flex items-center justify-center gap-2 border-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
                                type="button"
                                disabled={joining || pairingInput.length !== 6}
                                onClick={() => submitPairingCode(pairingInput)}
                              >
                                <span>{joining ? COPY.home.connectingBtn : COPY.home.connectBtn}</span>
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path d="M14 5l7 7m0 0l-7 7m7-7H3" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                                </svg>
                              </button>
                              <button
                                className="w-full bg-white hover:bg-neutral-50 active:scale-[0.98] border border-neutral-300 text-neutral-700 text-xs font-semibold py-2 px-3 rounded-xl transition-all flex items-center justify-center gap-1.5 cursor-pointer min-h-[44px]"
                                type="button"
                                onClick={() => startReceiving('qr')}
                              >
                                <svg className="w-3.5 h-3.5 text-neutral-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                                </svg>
                                <span>{COPY.home.scanQrBtn}</span>
                              </button>
                            </div>
                          </div>
                        </section>
                      </div>

                      {/* BOTTOM SECTION OF WORKSPACE: Nearby Devices Bar */}
                      <div className="mt-6 pt-5 border-t border-neutral-200/90 flex flex-col sm:flex-row sm:items-center justify-between gap-3" data-purpose="nearby-device-discovery">
                        <div className="flex items-center gap-2 text-xs font-semibold text-neutral-700">
                          <span className="flex h-2 w-2 relative">
                            <span className="animate-ping-subtle absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                          </span>
                          <span>{COPY.home.nearbyTitle}:</span>
                        </div>
                        {/* Discovered Devices / Direct Navigation */}
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white hover:bg-neutral-50 border border-neutral-300 text-xs font-medium text-neutral-800 transition-all shadow-sm hover:shadow active:scale-95 group cursor-pointer min-h-[44px]"
                            type="button"
                            onClick={() => {
                              if (selectedFiles.length === 0) {
                                setNearbyNotice(COPY.home.nearbyNeedFilesHint);
                                setTimeout(() => setNearbyNotice(null), 4000);
                              }
                              startReceiving('nearby');
                            }}
                          >
                            <span className="w-2 h-2 rounded-full bg-brand-orange ring-2 ring-orange-200"></span>
                            <span>{COPY.home.nearbyBtn}</span>
                            <span className="text-[11px] text-neutral-500 font-normal group-hover:text-neutral-700">Scan →</span>
                          </button>
                        </div>
                      </div>
                      {nearbyNotice && (
                        <p className="text-xs text-neutral-600 mt-2 bg-neutral-100 p-2 rounded-lg" role="status">
                          {nearbyNotice}
                        </p>
                      )}
                    </div>
                  </div>
                  {/* END LEFT & CENTER */}

                  {/* RIGHT COLUMN: Signature Orange Spotlight Card */}
                  <div className="lg:col-span-5 xl:col-span-4 flex flex-col">
                    <div className="bg-gradient-to-br from-[#f85a23] to-[#e6460f] rounded-3xl p-5 sm:p-7 lg:p-8 text-white shadow-float flex flex-col justify-between relative overflow-hidden h-full">
                      {/* Ambient blur accents */}
                      <div className="absolute -top-16 -right-16 w-48 h-48 bg-white/10 rounded-full blur-2xl pointer-events-none"></div>
                      <div className="absolute -bottom-12 -left-12 w-48 h-48 bg-black/10 rounded-full blur-xl pointer-events-none"></div>

                      <div className="relative z-10 flex flex-col justify-between h-full gap-4">
                        <div>
                          <h2 className="text-xl sm:text-2xl lg:text-3xl font-serif tracking-normal font-normal text-white leading-tight">
                            {COPY.home.orangeCardHeadline}
                          </h2>
                          <p className="mt-2 text-sm text-white/90 leading-relaxed font-normal">
                            {COPY.home.orangeCardDesc}
                          </p>
                        </div>

                        <div className="pt-2">
                          <a
                            className="inline-flex items-center gap-1.5 text-xs text-white underline underline-offset-4 hover:text-white/80 font-medium cursor-pointer"
                            href="#how-it-works"
                          >
                            <span>{COPY.home.orangeCardLearnMore}</span>
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                            </svg>
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* END RIGHT COLUMN */}
                </div>

                {/* HOW IT WORKS ANCHOR SECTION */}
                <div id="how-it-works" className="mt-8 sm:mt-12 frosted-glass rounded-3xl p-5 sm:p-8 shadow-sm border border-white/80">
                  <h3 className="text-xl font-bold text-neutral-900 mb-6">{COPY.home.howItWorksTitle}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="flex gap-4">
                      <span className="w-8 h-8 rounded-full bg-brand-orange/10 text-brand-orange font-bold flex items-center justify-center shrink-0">1</span>
                      <div>
                        <h4 className="text-sm font-bold text-neutral-900 mb-1">{COPY.home.step1Title}</h4>
                        <p className="text-xs text-neutral-600 leading-relaxed">{COPY.home.step1Desc}</p>
                      </div>
                    </div>
                    <div className="flex gap-4">
                      <span className="w-8 h-8 rounded-full bg-brand-orange/10 text-brand-orange font-bold flex items-center justify-center shrink-0">2</span>
                      <div>
                        <h4 className="text-sm font-bold text-neutral-900 mb-1">{COPY.home.step2Title}</h4>
                        <p className="text-xs text-neutral-600 leading-relaxed">{COPY.home.step2Desc}</p>
                      </div>
                    </div>
                    <div className="flex gap-4">
                      <span className="w-8 h-8 rounded-full bg-brand-orange/10 text-brand-orange font-bold flex items-center justify-center shrink-0">3</span>
                      <div>
                        <h4 className="text-sm font-bold text-neutral-900 mb-1">{COPY.home.step3Title}</h4>
                        <p className="text-xs text-neutral-600 leading-relaxed">{COPY.home.step3Desc}</p>
                      </div>
                    </div>
                  </div>

                  {/* Collapsed Technical Details Section */}
                  <div className="mt-6 pt-4 border-t border-neutral-200/80">
                    <button
                      type="button"
                      className="text-xs font-semibold text-neutral-700 hover:text-neutral-950 flex items-center gap-1.5 bg-transparent border-0 cursor-pointer p-0"
                      onClick={() => setIsTechDetailsOpen(!isTechDetailsOpen)}
                      aria-expanded={isTechDetailsOpen}
                    >
                      <svg
                        className={`w-3.5 h-3.5 transition-transform ${isTechDetailsOpen ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                      </svg>
                      <span>{COPY.home.techDetailsToggle}</span>
                    </button>
                    {isTechDetailsOpen && (
                      <p className="text-xs text-neutral-600 mt-2 leading-relaxed max-w-2xl bg-neutral-100/70 p-3 rounded-xl">
                        {COPY.home.techDetailsDesc}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* =========================================================================
                SCREEN 2: SEND (Waiting or Paired)
                ========================================================================= */}
            {screen === 'send' && session && (
              <div className="screen-wrapper">
                <Stepper currentStep={peerDevice ? 2 : 1} />

                {!peerDevice ? (
                  /* State 2A: Waiting for receiver with Share Management Component */
                  <ShareManagementModal
                    pairingCode={session.pairing_code}
                    expiresInSeconds={expirySecondsLeft}
                    onGenerateNewCode={startSending}
                    onClose={goHome}
                  />
                ) : (
              /* State 2B: Paired - Choose Files */
              <Card>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                  <span className="device-chip-dot" aria-hidden="true" />
                  <h3>{COPY.send.pairedWith(peerDevice.display_name)}</h3>
                </div>

                <div
                  className="dropzone-box"
                  tabIndex={0}
                  role="button"
                  aria-label="Drop files or click to choose files"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleFileSelect(e.dataTransfer.files);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                >
                  <p>{COPY.send.chooseFilesPrompt}</p>
                  <div style={{ display: 'flex', gap: '8px' }} onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="secondary"
                      className="action-choose-files"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {COPY.send.chooseFilesBtn}
                    </Button>
                    {supportsDirectoryUpload() && (
                      <Button
                        variant="secondary"
                        className="action-choose-folder"
                        onClick={() => folderInputRef.current?.click()}
                      >
                        {COPY.send.chooseFolderBtn}
                      </Button>
                    )}
                  </div>
                </div>

                {selectedFiles.length > 0 && (
                  <div style={{ marginTop: '24px' }}>
                    <div className="file-list">
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

                    <p style={{ margin: '16px 0', fontWeight: 600 }}>
                      {COPY.send.totalSize(selectedFiles.length, formatBytes(totalStagedSize))}
                    </p>

                    <Button variant="primary" onClick={sendFileMetadata}>
                      {COPY.send.sendToPeer(peerDevice.display_name)}
                    </Button>
                  </div>
                )}
              </Card>
            )}
          </div>
        )}

        {/* =========================================================================
            SCREEN 3: RECEIVE (Code Entry or Incoming Approval)
            ========================================================================= */}
        {screen === 'receive' && (
          <div className="screen-wrapper">
            {!session ? (
              /* Code Entry / Scan QR */
              <Card>
                <h2>{COPY.receive.title}</h2>
                <p>{COPY.receive.instruction}</p>

                {receiveMode === 'code' ? (
                  <div style={{ marginTop: '16px' }}>
                    <CodeInput
                      value={pairingInput}
                      onChange={(val) => {
                        setPairingInput(val);
                        setError(null);
                      }}
                      onSubmit={(code) => submitPairingCode(code)}
                      disabled={joining}
                      error={error ? mapTechnicalError(error).headline : null}
                    />

                    {joining && (
                      <p style={{ marginTop: '12px', color: 'var(--text-muted)' }}>
                        {COPY.receive.joining}
                      </p>
                    )}

                    <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
                      <Button variant="link" onClick={() => setReceiveMode('qr')}>
                        {COPY.receive.scanQrToggle}
                      </Button>
                      <Button variant="link" onClick={() => setReceiveMode('nearby')}>
                        Search nearby
                      </Button>
                    </div>
                  </div>
                ) : receiveMode === 'qr' ? (
                  <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <QrScanner
                      onScan={(scannedCode) => {
                        setReceiveMode('code');
                        setPairingInput(scannedCode);
                        submitPairingCode(scannedCode);
                      }}
                      onClose={() => setReceiveMode('code')}
                    />
                    <div style={{ marginTop: '12px' }}>
                      <Button variant="link" onClick={() => setReceiveMode('code')}>
                        {COPY.receive.enterCodeToggle}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: '16px' }}>
                    {device && (
                      <NearbyDiscovery
                        token={device.token}
                        displayName={device.display_name}
                        variant="standalone"
                        onPaired={handleNearbyPaired}
                        onSelectCode={() => setReceiveMode('code')}
                        onSelectQr={() => setReceiveMode('qr')}
                        onClose={() => setReceiveMode('code')}
                      />
                    )}
                  </div>
                )}
              </Card>
            ) : incomingFiles.length === 0 ? (
              /* Connected, waiting for sender to select files */
              <Card style={{ textAlign: 'center' }}>
                <h3>Connected to {peerDevice?.display_name || 'sender'}</h3>
                <p style={{ marginTop: '8px' }}>Waiting for the sender to choose files...</p>
              </Card>
            ) : (
              /* Incoming Approval Card */
              <Card>
                <h2>
                  {COPY.receive.incomingTitle(
                    peerDevice?.display_name || 'Sender',
                    incomingFiles.length,
                    formatBytes(incomingTotalSize)
                  )}
                </h2>

                {storageWarning && (
                  <div className="notice-box" style={{ margin: '16px 0', borderLeft: '4px solid var(--status-warning)' }}>
                    {storageWarning}
                  </div>
                )}

                <div className="file-list">
                  {incomingFiles.map((file, idx) => (
                    <FileRow key={idx} name={file.name} size={file.size} />
                  ))}
                </div>

                <div style={{ display: 'flex', gap: '12px', marginTop: '24px', alignItems: 'center' }}>
                  <Button variant="primary" onClick={acceptTransfer}>
                    {COPY.receive.accept}
                  </Button>
                  <Button variant="secondary" onClick={rejectTransfer}>
                    {COPY.receive.decline}
                  </Button>
                </div>
              </Card>
            )}
          </div>
        )}

        {/* =========================================================================
            SCREEN 4, 5, FAILED, CANCELLED: DEDICATED TRANSFER SCREEN
            (Only mounts when transfer actually starts; stays through completion/failure)
            ========================================================================= */}
        {mapScreenToMainView(screen) === 'transfer' && (
          <TransferScreen
            screen={screen}
            role={role}
            peerName={peerDevice?.display_name}
            transferProgress={transferProgress}
            files={
              role === 'sender'
                ? selectedFiles.map((f) => ({
                    name: f.name,
                    size: f.size,
                    relativePath: f.webkitRelativePath,
                  }))
                : incomingFiles.map((f) => ({
                    name: f.name,
                    size: f.size,
                  }))
            }
            completedFiles={completedFiles}
            transferDurationSecs={transferDurationSecs}
            error={error}
            onCancel={handleCancelClick}
            onBackToHome={goHome}
            onTryAgain={
              screen === 'failed'
                ? role === 'sender'
                  ? startSending
                  : () => startReceiving('code')
                : undefined
            }
            onSendMore={() => {
              goHome();
              startSending();
            }}
            onReceiveMore={() => {
              goHome();
              startReceiving('code');
            }}
          />
        )}
          </>
        )}
      </main>

      {/* BEGIN: BottomTrustFooter (At most 3 plain language items, no fine print) */}
      <footer className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-12 py-4 sm:py-6" data-purpose="trust-badges-bar">
        <div className="frosted-glass rounded-2xl py-3 px-6 shadow-sm border border-white/80">
          <div className="flex flex-wrap items-center justify-around sm:justify-between gap-y-3 gap-x-6 text-xs text-neutral-600 font-medium">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
              </svg>
              <span className="text-neutral-900 font-semibold">{COPY.footer.privateEncrypted}</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
              </svg>
              <span className="text-neutral-900 font-semibold">{COPY.footer.noAccount}</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
              </svg>
              <span className="text-neutral-900 font-semibold">{COPY.footer.worksAnyBrowser}</span>
            </div>
          </div>
        </div>
      </footer>
      {/* END: BottomTrustFooter */}

      {/* Device Name Edit Modal */}
      {device && (
        <DeviceEditModal
          isOpen={isEditNameOpen}
          currentName={device.display_name}
          onSave={handleSaveDeviceName}
          onClose={() => setIsEditNameOpen(false)}
        />
      )}

      {/* Cancel Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showCancelConfirm}
        title={COPY.transfer.cancelConfirmTitle}
        description={COPY.transfer.cancelConfirmDesc}
        onConfirm={executeCancel}
        onCancel={() => setShowCancelConfirm(false)}
      />
    </>
  );
}
