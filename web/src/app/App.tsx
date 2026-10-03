import { useEffect, useRef, useState } from 'react';
import { createSession, getSession, joinSession, updateSessionState } from '../services/api';
import { formatRemoteLog, RemoteDevLogger, RemoteLogPayload } from '../services/devLogger';
import { getOrCreateDevice, resetDevice } from '../services/device';
import { formatBytes, formatEta, formatSpeed } from '../services/format';
import { SignalingClient } from '../services/signaling';
import { createTransferStorage, TransferStorage } from '../services/storage';
import { FileReceiver, FileSender } from '../services/transfer';
import { WebRTCConnection } from '../services/webrtc';
import { AppScreen, DeviceInfo, FileInfo, SessionInfo, SessionState, TransferProgress } from '../types';

export function App() {
  const [device, setDevice] = useState<{ device_id: string; display_name: string; token: string } | null>(null);
  const [screen, setScreen] = useState<AppScreen>('home');
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

  const sigRef = useRef<SignalingClient | null>(null);
  const rtcRef = useRef<WebRTCConnection | null>(null);
  const senderRef = useRef<FileSender | null>(null);
  const receiverRef = useRef<FileReceiver | null>(null);
  const storageRef = useRef<TransferStorage | null>(null);

  const sessionRef = useRef<SessionInfo | null>(null);
  const deviceRef = useRef<{ device_id: string; display_name: string; token: string } | null>(null);
  const selectedFilesRef = useRef<File[]>([]);
  const peerDeviceRef = useRef<DeviceInfo | null>(null);

  const setSessionState = (sess: SessionInfo | null) => {
    sessionRef.current = sess;
    setSession(sess);
  };

  const setDeviceState = (dev: { device_id: string; display_name: string; token: string } | null) => {
    deviceRef.current = dev;
    setDevice(dev);
  };

  const setSelectedFilesState = (files: File[]) => {
    selectedFilesRef.current = files;
    setSelectedFiles(files);
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

    getOrCreateDevice()
      .then(setDeviceState)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Device init error'));
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
    setScreen('home');
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

  const handleAuthFailure = async () => {
    try {
      const freshDevice = await resetDevice();
      setDeviceState(freshDevice);
      return freshDevice;
    } catch {
      return null;
    }
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
      setScreen('send');

      const sig = new SignalingClient();
      sigRef.current = sig;

      sig.on('peer_joined', (msg: unknown) => {
        const payload = (msg as { payload: DeviceInfo }).payload;
        setPeerDeviceState(payload);
      });
      sig.on('peer_left', () => {
        setError('Peer disconnected');
        goHome();
      });
      sig.on('transfer_response', (msg: unknown) => {
        console.log('[SIGNAL] transfer_response handler START');
        const payload = (msg as { payload: { accepted: boolean } }).payload;
        console.log(`[SIGNAL] transfer_response accepted=${payload?.accepted}`);
        if (payload && payload.accepted) {
          console.log('[SIGNAL] transfer_response handler invoking sender WebRTC initialization');
          setScreen('transfer');
          startWebRTCSender();
          console.log('[SIGNAL] transfer_response handler completed');
        } else {
          console.log('[SIGNAL] transfer_response rejected');
          setError('Transfer rejected by receiver');
          setScreen('failed');
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
    if (!files) return;
    const fileArray = Array.from(files);
    console.log(`[TRANSFER][SEND] file selected: ${fileArray.length} file(s)`);
    setSelectedFilesState(fileArray);

    if (sigRef.current && deviceRef.current) {
      const logger = new RemoteDevLogger(sigRef.current, deviceRef.current.device_id);
      fileArray.forEach((f) => {
        logger.log('file_selected', {
          fileName: f.name,
          fileSize: f.size,
          totalChunks: f.size === 0 ? 0 : Math.ceil(f.size / 65536),
        });
      });
    }
  };

  const sendFileMetadata = () => {
    const curSig = sigRef.current;
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;
    const curFiles = selectedFilesRef.current;

    if (!curSig || !curSession || !curDevice) return;
    const filesMeta: FileInfo[] = curFiles.map((f, i) => ({
      id: `file_${i}_${Date.now()}`,
      name: f.name,
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
    setScreen('send');
  };

  const reconnectAttemptsRef = useRef<number>(0);
  const isReconnectingRef = useRef<boolean>(false);
  const MAX_RECONNECT_ATTEMPTS = 5;

  const handleConnectionDrop = async () => {
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;
    const curSig = sigRef.current;

    if (!curSession || !curDevice || !curSig || screen !== 'transfer') {
      return;
    }

    if (isReconnectingRef.current) {
      console.log('[RECOVERY] Reconnection already in progress');
      return;
    }

    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[RECOVERY] Max reconnect attempts exceeded');
      setError('Connection lost: could not recover after maximum retries');
      setScreen('failed');
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

        // Recreate WebRTC Sender
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
        // Receiver waiting for new DataChannel
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
    console.log(`[TRANSFER][SEND] Check state: sig=${!!curSig}, session=${!!curSession}, device=${!!curDevice}, selectedFiles count=${curFiles.length}`);

    if (!curSig || !curSession || !curDevice) {
      console.error('[TRANSFER][SEND] Cannot start WebRTC sender: missing dependencies', {
        hasSig: !!curSig,
        hasSession: !!curSession,
        hasDevice: !!curDevice
      });
      setError('Internal error: WebRTC session not ready');
      setScreen('failed');
      return;
    }

    try {
      console.log('[TRANSFER][SEND] creating WebRTC connection');
      const rtc = new WebRTCConnection(curSig, true);
      rtcRef.current = rtc;
      console.log('[TRANSFER][SEND] WebRTC connection created');

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
            setScreen('completed');
          };
          sender.onError = (e) => {
            console.error('[TRANSFER][SEND] FileSender error:', e);
            setError(e);
            setScreen('failed');
          };
          sender.start();
        };

        if (dc.readyState === 'open') {
          runSender();
        } else {
          dc.addEventListener('open', runSender, { once: true });
        }
      }

      console.log('[TRANSFER][SEND] starting offer');
      rtc.createOffer();
    } catch (err) {
      console.error('[TRANSFER][SEND] runSender FAILED:', err);
      setError('WebRTC initialization failed');
      setScreen('failed');
    }
  };

  // Receiver flow
  const startReceiving = () => {
    setError(null);
    setRole('receiver');
    setScreen('receive');
  };

  const submitPairingCode = async (codeToJoin: string) => {
    if (codeToJoin.length !== 6 || joining) return;
    setJoining(true);
    setError(null);

    let currentDevice = deviceRef.current;
    if (!currentDevice) {
      currentDevice = await handleAuthFailure();
      if (!currentDevice) {
        setJoining(false);
        return;
      }
    }

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
        console.log(`[SIGNAL][RECEIVE] Signal message received from peer (type=${signalMsg.payload?.signal_type})`);
        if (signalMsg.from !== curDev?.device_id && rtcRef.current) {
          rtcRef.current.handleSignal(signalMsg.payload);
        } else if (!rtcRef.current) {
          console.warn('[SIGNAL][RECEIVE] Received signal before rtcRef was ready');
        }
      });

      sig.on('dev_log', (msg: unknown) => {
        const payload = (msg as { payload: RemoteLogPayload }).payload;
        if (payload) {
          console.log(formatRemoteLog(payload));
        }
      });

      sig.on('peer_left', () => {
        setError('Peer disconnected');
        goHome();
      });

      sig.connect(sess.session_id, currentDevice.token);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Join session error');
    } finally {
      setJoining(false);
    }
  };

  const acceptTransfer = () => {
    const curSig = sigRef.current;
    const curSession = sessionRef.current;
    const curDevice = deviceRef.current;

    console.log('[TRANSFER][RECEIVE] acceptTransfer START');

    if (!curSig || !curSession || !curDevice) {
      console.error('[TRANSFER][RECEIVE] Cannot accept transfer: missing dependencies', {
        hasSig: !!curSig,
        hasSession: !!curSession,
        hasDevice: !!curDevice
      });
      return;
    }

    curSig.send({
      type: 'transfer_response',
      payload: { accepted: true },
    });
    console.log('[SIGNAL][RECEIVE] transfer_response sent (accepted=true)');

    updateSessionState(curDevice.token, curSession.session_id, 'CONNECTING').catch((err) => {
      console.error('[TRANSFER][RECEIVE] Failed to update state to CONNECTING', err);
    });

    console.log('[TRANSFER][RECEIVE] creating WebRTC receiver connection');
    const rtc = new WebRTCConnection(curSig, false);
    rtcRef.current = rtc;
    console.log('[TRANSFER][RECEIVE] WebRTC receiver connection created');

    rtc.onConnectionStateChange = (state) => {
      if (state === 'failed' || state === 'disconnected') {
        console.warn(`[WEBRTC][RECEIVE] Connection state ${state}, triggering recovery`);
        handleConnectionDrop();
      }
    };

    rtc.onDataChannel = (dc) => {
      console.log('[TRANSFER][RECEIVE] DataChannel received, starting FileReceiver');
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
        console.log('[TRANSFER][RECEIVE] FileReceiver completed, files verified');
        setCompletedFiles(files);
        setScreen('completed');
        updateSessionState(curDevice.token, curSession.session_id, 'COMPLETED').catch((err) => {
          console.error('[TRANSFER][RECEIVE] Failed to update state to COMPLETED', err);
        });
      };
      receiver.onError = (err) => {
        console.error('[TRANSFER][RECEIVE] FileReceiver error:', err);
        setError(err);
        setScreen('failed');
      };
      receiver.start();
    };

    setScreen('transfer');
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
    setScreen('cancelled');
  };

  return (
    <main>
      <header>
        <span className="brand" onClick={goHome} style={{ cursor: 'pointer' }}>
          JustShare
        </span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {device && <span className="status">{device.display_name}</span>}
          {screen !== 'home' && (
            <button className="btn btn-secondary" onClick={goHome} style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
              Home
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="error-msg" style={{ maxWidth: '600px', margin: '1rem auto' }}>
          {error}
        </div>
      )}

      {/* Screen 1: Home */}
      {screen === 'home' && (
        <section className="screen">
          <p className="eyebrow">Secure File Transfer</p>
          <h1>Connect. Approve. Transfer.</h1>
          <p className="summary">Peer-to-peer file transfer directly between browsers. Fast, private, end-to-end verified.</p>
          <div className="home-actions">
            <button className="btn btn-primary" onClick={startSending}>
              Send Files
              <span className="btn-label">Create a session and generate a pairing code</span>
            </button>
            <button className="btn btn-secondary" onClick={startReceiving}>
              Receive Files
              <span className="btn-label">Enter a 6-digit code to pair with a sender</span>
            </button>
          </div>
        </section>
      )}

      {/* Screen 2: Send (Waiting for peer or selecting files) */}
      {screen === 'send' && session && (
        <section className="screen">
          <h2>Send Files</h2>

          {!peerDevice ? (
            <div>
              <p className="status-msg">Share this temporary 6-digit code with the receiver:</p>
              <div className="pairing-code">
                {session.pairing_code.split('').map((digit, i) => (
                  <div key={i} className="pairing-digit">
                    {digit}
                  </div>
                ))}
              </div>
              <p className="note" style={{ textAlign: 'center' }}>
                <span className="spinner"></span> Waiting for receiver to join...
              </p>
            </div>
          ) : (
            <div>
              <p className="status-msg">Paired with {peerDevice.display_name}</p>

              <div
                className="drop-zone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  handleFileSelect(e.dataTransfer.files);
                }}
                onClick={() => document.getElementById('file-input')?.click()}
              >
                <div className="icon">📁</div>
                <p>Drag and drop files here, or click to browse</p>
                <input id="file-input" type="file" multiple style={{ display: 'none' }} onChange={(e) => handleFileSelect(e.target.files)} />
              </div>

              {selectedFiles.length > 0 && (
                <div>
                  <ul className="file-list">
                    {selectedFiles.map((file, idx) => (
                      <li key={idx} className="file-item">
                        <span className="file-name">{file.name}</span>
                        <span className="file-size">{formatBytes(file.size)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="status-msg">
                    {selectedFiles.length} file(s) selected ({formatBytes(selectedFiles.reduce((a, f) => a + f.size, 0))})
                  </p>
                  <div className="btn-group">
                    <button className="btn btn-primary" onClick={sendFileMetadata}>
                      Send to {peerDevice.display_name}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Screen 3: Receive (Enter code or approve) */}
      {screen === 'receive' && (
        <section className="screen">
          <h2>Receive Files</h2>

          {!session ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitPairingCode(pairingInput);
              }}
            >
              <p className="status-msg">Enter the 6-digit pairing code from the sender:</p>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', margin: '1.5rem 0' }}>
                <input
                  type="text"
                  maxLength={6}
                  value={pairingInput}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setPairingInput(val);
                    setError(null);
                    if (val.length === 6) {
                      submitPairingCode(val);
                    }
                  }}
                  autoFocus
                  placeholder="000000"
                  style={{
                    letterSpacing: '8px',
                    textAlign: 'center',
                    width: '240px',
                    fontSize: '1.8rem',
                    padding: '12px',
                    borderRadius: '10px',
                    background: '#1a2746',
                    border: '2px solid #344263',
                    color: '#eaf0ff',
                    fontFamily: 'SF Mono, Consolas, monospace',
                  }}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={pairingInput.length !== 6 || joining}
                  style={{ width: '240px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}
                >
                  {joining ? (
                    <>
                      <span className="spinner"></span> Joining...
                    </>
                  ) : (
                    'Join Session'
                  )}
                </button>
              </div>
              {pairingInput.length > 0 && pairingInput.length < 6 && (
                <p className="note" style={{ textAlign: 'center' }}>
                  Enter {6 - pairingInput.length} more digit(s)
                </p>
              )}
            </form>
          ) : incomingFiles.length === 0 ? (
            <p className="status-msg">
              <span className="spinner"></span> Connected to {peerDevice?.display_name || 'sender'}. Waiting for file selection...
            </p>
          ) : (
            <div className="approval-card">
              <h3>Incoming File Request</h3>
              <p className="approval-meta">From: {peerDevice?.display_name}</p>
              <p className="approval-meta">Files: {incomingFiles.length}</p>
              <p className="approval-meta">Total Size: {formatBytes(incomingTotalSize)}</p>

              <ul className="file-list">
                {incomingFiles.map((f, i) => (
                  <li key={i} className="file-item">
                    <span className="file-name">{f.name}</span>
                    <span className="file-size">{formatBytes(f.size)}</span>
                  </li>
                ))}
              </ul>

              <div className="btn-group">
                <button className="btn btn-primary" onClick={acceptTransfer}>
                  Accept
                </button>
                <button className="btn btn-danger" onClick={rejectTransfer}>
                  Reject
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Screen 4: Transfer (Progress) */}
      {screen === 'transfer' && (
        <section className="screen">
          <h2>
            {transferProgress?.state === 'reconnecting'
              ? 'Connection Interrupted — Reconnecting...'
              : transferProgress?.state === 'resuming'
              ? 'Resuming Transfer...'
              : transferProgress?.state === 'paused'
              ? 'Transfer Paused'
              : transferProgress?.state === 'verifying'
              ? 'Verifying File Integrity...'
              : 'Transferring Files'}
          </h2>
          <div className="progress-container">
            {transferProgress ? (
              <div>
                <p className="progress-filename">{transferProgress.currentFile}</p>
                <div className="progress-bar-bg">
                  <div className="progress-bar-fill" style={{ width: `${transferProgress.percentage}%` }}></div>
                </div>
                <div className="progress-stats">
                  <span>
                    {formatBytes(transferProgress.bytesTransferred)} / {formatBytes(transferProgress.totalBytes)} ({transferProgress.percentage.toFixed(1)}%)
                  </span>
                  <span>{formatSpeed(transferProgress.speed)}</span>
                </div>
                <div className="progress-stats">
                  <span>
                    File {transferProgress.currentFileIndex + 1} of {transferProgress.totalFiles}
                  </span>
                  <span>ETA: {formatEta(transferProgress.eta)}</span>
                </div>
              </div>
            ) : (
              <p className="status-msg">
                <span className="spinner"></span> Establishing P2P WebRTC Connection...
              </p>
            )}
          </div>
          <div className="btn-group">
            <button className="btn btn-danger" onClick={cancelTransfer}>
              Cancel Transfer
            </button>
          </div>
        </section>
      )}

      {/* Screen 5: Completed */}
      {screen === 'completed' && (
        <section className="screen">
          <div className="completed-icon">🎉</div>
          <h2>Transfer Completed!</h2>
          <p className="status-msg">All files were transferred and cryptographically verified (SHA-256).</p>

          {completedFiles.length > 0 && (
            <ul className="download-list">
              {completedFiles.map((file, i) => (
                <li key={i} className="download-item">
                  <div>
                    <span style={{ fontWeight: 600, display: 'block' }}>{file.name}</span>
                    <span className={file.verified ? 'verified' : 'not-verified'} style={{ fontSize: '0.8rem' }}>
                      {file.verified ? '✓ SHA-256 Verified' : '✗ Hash Mismatch'}
                    </span>
                  </div>
                  <button
                    className="download-btn"
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
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="btn-group">
            <button className="btn btn-primary" onClick={goHome}>
              Done
            </button>
          </div>
        </section>
      )}

      {/* Screen 6: Failed / Cancelled */}
      {(screen === 'failed' || screen === 'cancelled') && (
        <section className="screen">
          <h2>{screen === 'cancelled' ? 'Transfer Cancelled' : 'Transfer Failed'}</h2>
          <p className="status-msg">{error || (screen === 'cancelled' ? 'The transfer was cancelled by user.' : 'An error occurred during transfer.')}</p>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={goHome}>
              Return Home
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
