import { useEffect, useRef, useState } from 'react';
import { createSession, getSession, joinSession, updateSessionState } from '../services/api';
import { getOrCreateDevice, supportsDirectoryUpload } from '../services/device';
import { formatBytes, formatEta, formatSpeed } from '../services/format';
import { SignalingClient } from '../services/signaling';
import { createTransferStorage, TransferStorage } from '../services/storage';
import { FileReceiver, FileSender } from '../services/transfer';
import { WebRTCConnection } from '../services/webrtc';
import { AppScreen, DeviceInfo, FileInfo, SessionInfo, SessionState, TransferProgress } from '../types';
import { decidePeerLeftAction } from '../services/peerLeft';
import { determineInitialUrlAction } from '../services/pairingUrl';
import { mapTechnicalError, formatDuration, truncateMiddle } from '../services/errorMapper';
import { COPY } from '../copy';

import { QRCodeDisplay } from '../components/QRCodeDisplay';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Stepper } from '../components/Stepper';
import { CodeInput } from '../components/CodeInput';
import { FileRow } from '../components/FileRow';
import { ProgressBar } from '../components/ProgressBar';
import { StatusBadge } from '../components/StatusBadge';
import { ErrorPanel } from '../components/ErrorPanel';
import { ConfirmDialog } from '../components/ConfirmDialog';

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
  const [receiveMode, setReceiveMode] = useState<'code' | 'qr'>('code');

  // Cancel confirmation & countdown states
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [transferDurationSecs, setTransferDurationSecs] = useState<number | null>(null);
  const transferStartTimeRef = useRef<number | null>(null);

  // Expiration countdown
  const [expirySecondsLeft, setExpirySecondsLeft] = useState<number | null>(null);

  // Storage space warning
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

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

  const startReceiving = (mode: 'code' | 'qr' = 'code') => {
    setError(null);
    setRole('receiver');
    setReceiveMode(mode);
    setScreenState('receive');
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

  const handleCopyPairingCode = async () => {
    if (!session?.pairing_code) return;
    try {
      await navigator.clipboard.writeText(session.pairing_code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // ignore
    }
  };

  const totalStagedSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);

  return (
    <>
      <header className="app-header">
        <button type="button" className="brand-button" onClick={goHome} aria-label="JustShare Home">
          <span>{COPY.header.brand}</span>
        </button>

        <div className="header-right">
          {device && (
            <div className="device-chip-static" title={device.display_name}>
              <span className="device-chip-dot" aria-hidden="true" />
              <span>{device.display_name}</span>
            </div>
          )}
          {screen !== 'home' && (
            <Button variant="link" onClick={goHome}>
              {COPY.header.home}
            </Button>
          )}
        </div>
      </header>

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
            SCREEN 1: HOME
            ========================================================================= */}
        {screen === 'home' && (
          <div className="screen-wrapper">
            <div className="home-hero">
              <h1>{COPY.home.title}</h1>
              <p className="home-hero-subtitle">{COPY.home.subtitle}</p>
            </div>

            <div className="home-action-panels">
              {/* PRIMARY ACTION: Send */}
              <Card className="primary-send-panel">
                <h2 className="card-title">{COPY.home.sendCardTitle}</h2>
                <p className="card-desc">{COPY.home.sendCardDesc}</p>
                <Button variant="primary" onClick={startSending}>
                  {COPY.home.sendButton}
                </Button>
              </Card>

              {/* SECONDARY ACTION: Receive */}
              <Card secondary>
                <h3 className="card-title">{COPY.home.receiveCardTitle}</h3>
                <p className="card-desc">{COPY.home.receiveCardDesc}</p>
                <Button variant="secondary" onClick={() => startReceiving('code')}>
                  {COPY.home.receiveButton}
                </Button>
              </Card>
            </div>

            {/* HOW IT WORKS (3 numbered steps with UI concepts) */}
            <section className="how-it-works-section" aria-labelledby="how-it-works-title">
              <h3 id="how-it-works-title">{COPY.home.howItWorksTitle}</h3>
              <div className="step-row">
                <span className="step-num">1</span>
                <div className="step-content">
                  <h4>{COPY.home.step1Title}</h4>
                  <p>{COPY.home.step1Desc}</p>
                </div>
              </div>
              <div className="step-row">
                <span className="step-num">2</span>
                <div className="step-content">
                  <h4>{COPY.home.step2Title}</h4>
                  <p>{COPY.home.step2Desc}</p>
                </div>
              </div>
              <div className="step-row">
                <span className="step-num">3</span>
                <div className="step-content">
                  <h4>{COPY.home.step3Title}</h4>
                  <p>{COPY.home.step3Desc}</p>
                </div>
              </div>
            </section>

            {/* VERIFIABLE PROOF FACTS */}
            <div className="proof-list">
              <div className="proof-item">
                <span className="proof-bullet">✓</span>
                <span>{COPY.home.proofDirect}</span>
              </div>
              <div className="proof-item">
                <span className="proof-bullet">✓</span>
                <span>{COPY.home.proofHash}</span>
              </div>
              <div className="proof-item">
                <span className="proof-bullet">✓</span>
                <span>{COPY.home.proofNoAccount}</span>
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
              /* State 2A: Waiting for receiver */
              <Card className="pairing-container">
                <h2>{COPY.send.waitingHeadline}</h2>
                <p>{COPY.send.waitingInstruction}</p>

                <div className="pairing-code-large">
                  {session.pairing_code.split('').map((d, i) => (
                    <div key={i} className="code-box-display">
                      {d}
                    </div>
                  ))}
                </div>

                <Button variant="secondary" onClick={handleCopyPairingCode}>
                  {copiedCode ? COPY.send.codeCopied : COPY.send.copyCode}
                </Button>

                <div className="qr-box-container">
                  <QRCodeDisplay pairingCode={session.pairing_code} />
                </div>

                <div className="expiry-text">
                  {expirySecondsLeft !== null && expirySecondsLeft > 0 ? (
                    COPY.send.expiresIn(expirySecondsLeft)
                  ) : expirySecondsLeft === 0 ? (
                    <div>
                      <span>{COPY.send.codeExpired} </span>
                      <Button variant="link" onClick={startSending}>
                        {COPY.send.generateNewCode}
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div style={{ marginTop: '16px' }}>
                  <Button variant="link" onClick={goHome}>
                    Cancel session
                  </Button>
                </div>
              </Card>
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

                    <div style={{ marginTop: '24px' }}>
                      <Button variant="link" onClick={() => setReceiveMode('qr')}>
                        {COPY.receive.scanQrToggle}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: '16px', textAlign: 'center' }}>
                    <p style={{ marginBottom: '16px' }}>{COPY.receive.scanQrInstruction}</p>
                    <Button variant="link" onClick={() => setReceiveMode('code')}>
                      {COPY.receive.enterCodeToggle}
                    </Button>
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
            SCREEN 4: ACTIVE TRANSFER
            ========================================================================= */}
        {screen === 'transfer' && (
          <div className="screen-wrapper">
            <Card className="transfer-box">
              {/* Progress State Title */}
              <div>
                <h2>
                  {transferProgress?.state === 'verifying'
                    ? COPY.transfer.stateVerifying
                    : transferProgress?.state === 'reconnecting'
                    ? 'Reconnecting...'
                    : role === 'sender'
                    ? COPY.transfer.stateSending(peerDevice?.display_name || 'receiver')
                    : COPY.transfer.stateReceiving(peerDevice?.display_name || 'sender')}
                </h2>

                {transferProgress && (
                  <p style={{ marginTop: '4px' }}>
                    {COPY.transfer.fileCounter(
                      transferProgress.currentFileIndex + 1,
                      transferProgress.totalFiles
                    )}
                    : <strong title={transferProgress.currentFile}>{truncateMiddle(transferProgress.currentFile, 32)}</strong>
                  </p>
                )}
              </div>

              {/* Progress Bar & Indicators (Never 0 B/s or ETA 0s during hashing) */}
              {transferProgress ? (
                <div>
                  <ProgressBar
                    value={transferProgress.percentage}
                    indeterminate={transferProgress.state === 'verifying'}
                  />

                  {transferProgress.state === 'verifying' ? (
                    <p style={{ marginTop: '12px', fontSize: '0.875rem' }}>
                      {COPY.transfer.stateVerifyingDesc}
                    </p>
                  ) : (
                    <div className="transfer-meta-grid">
                      <div>
                        <span className="meta-item-label">Transferred</span>
                        <span className="meta-item-val tabular-numbers">
                          {formatBytes(transferProgress.bytesTransferred)} / {formatBytes(transferProgress.totalBytes)} ({transferProgress.percentage.toFixed(0)}%)
                        </span>
                      </div>
                      <div>
                        <span className="meta-item-label">Speed</span>
                        <span className="meta-item-val tabular-numbers">
                          {formatSpeed(transferProgress.speed)}
                        </span>
                      </div>
                      <div>
                        <span className="meta-item-label">Time Remaining</span>
                        <span className="meta-item-val tabular-numbers">
                          {formatEta(transferProgress.eta)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <ProgressBar indeterminate />
                  <p style={{ marginTop: '8px' }}>{COPY.transfer.stateConnecting}</p>
                </div>
              )}

              {/* Quiet destructive outline cancel button */}
              <div style={{ marginTop: '16px' }}>
                <Button variant="destructive" onClick={handleCancelClick}>
                  {COPY.transfer.cancel}
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* =========================================================================
            SCREEN 5: COMPLETED
            ========================================================================= */}
        {screen === 'completed' && (
          <div className="screen-wrapper">
            <Card>
              {role === 'receiver' ? (
                <>
                  <h2>{COPY.completed.receiverTitle}</h2>
                  <p style={{ marginTop: '4px' }}>{COPY.completed.receiverSubtitle}</p>
                  {transferDurationSecs !== null && (
                    <p style={{ marginTop: '2px', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                      {COPY.completed.timeElapsed(formatDuration(transferDurationSecs))}
                    </p>
                  )}

                  <div className="file-list" style={{ marginTop: '20px' }}>
                    {completedFiles.map((file, i) => (
                      <div key={i} className="file-row">
                        <span className="file-row-name" title={file.name}>
                          {file.name}
                        </span>
                        <div className="file-row-meta">
                          <StatusBadge status={file.verified ? 'success' : 'warning'}>
                            {file.verified ? COPY.completed.hashVerifiedBadge : COPY.completed.hashFailedBadge}
                          </StatusBadge>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              const url = URL.createObjectURL(file.blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = file.name;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                          >
                            {COPY.completed.saveFile}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{ marginTop: '24px' }}>
                    <Button variant="link" onClick={goHome}>
                      {COPY.completed.receiveAnother}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h2>{COPY.completed.senderTitle(peerDevice?.display_name || 'receiver')}</h2>
                  <p style={{ marginTop: '4px' }}>{COPY.completed.senderSubtitle}</p>
                  {transferDurationSecs !== null && (
                    <p style={{ marginTop: '2px', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                      {COPY.completed.timeElapsed(formatDuration(transferDurationSecs))}
                    </p>
                  )}

                  <div style={{ marginTop: '24px' }}>
                    <Button variant="primary" onClick={goHome}>
                      {COPY.completed.sendAnother}
                    </Button>
                  </div>
                </>
              )}
            </Card>
          </div>
        )}

        {/* =========================================================================
            SCREEN 6: FAILED OR CANCELLED (Friendly single error message)
            ========================================================================= */}
        {(screen === 'failed' || screen === 'cancelled') && (
          <div className="screen-wrapper">
            {(() => {
              const friendly = mapTechnicalError(error);
              return (
                <ErrorPanel
                  headline={screen === 'cancelled' ? COPY.errors.transferCancelled.headline : friendly.headline}
                  cause={screen === 'cancelled' ? COPY.errors.transferCancelled.cause : friendly.cause}
                  nextStep={screen === 'cancelled' ? COPY.errors.transferCancelled.nextStep : friendly.nextStep}
                  rawDetails={screen === 'failed' ? friendly.rawDetails : undefined}
                  onTryAgain={screen === 'failed' ? (role === 'sender' ? startSending : () => startReceiving('code')) : undefined}
                  onHome={goHome}
                />
              );
            })()}
          </div>
        )}
      </main>

      <footer className="app-footer">
        {COPY.footer.securityNote}
      </footer>

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
