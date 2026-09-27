import { useEffect, useRef, useState } from 'react';
import { createSession, joinSession, updateSessionState } from '../services/api';
import { getOrCreateDevice } from '../services/device';
import { formatBytes, formatEta, formatSpeed } from '../services/format';
import { SignalingClient } from '../services/signaling';
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

  useEffect(() => {
    getOrCreateDevice()
      .then(setDevice)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Device init error'));
  }, []);

  const goHome = () => {
    if (sigRef.current) sigRef.current.disconnect();
    if (rtcRef.current) rtcRef.current.close();
    setScreen('home');
    setRole(null);
    setSession(null);
    setPeerDevice(null);
    setPairingInput('');
    setSelectedFiles([]);
    setIncomingFiles([]);
    setIncomingTotalSize(0);
    setTransferProgress(null);
    setError(null);
  };

  // Sender flow
  const startSending = async () => {
    if (!device) return;
    try {
      setRole('sender');
      const res = await createSession(device.token);
      const sess: SessionInfo = {
        session_id: res.session_id,
        pairing_code: res.pairing_code,
        expires_at: res.expires_at,
        state: res.state as SessionState,
      };
      setSession(sess);
      setScreen('send');

      const sig = new SignalingClient();
      sigRef.current = sig;

      sig.on('peer_joined', (msg: unknown) => {
        const payload = (msg as { payload: DeviceInfo }).payload;
        setPeerDevice(payload);
      });
      sig.on('peer_left', () => {
        setError('Peer disconnected');
        goHome();
      });
      sig.on('transfer_response', (msg: unknown) => {
        const payload = (msg as { payload: { accepted: boolean } }).payload;
        if (payload.accepted) {
          setScreen('transfer');
          startWebRTCSender();
        } else {
          setError('Transfer rejected by receiver');
          setScreen('failed');
        }
      });
      sig.on('error', (msg: unknown) => {
        const payload = (msg as { payload?: { message?: string } }).payload;
        setError(payload?.message || 'Signaling error');
      });

      sig.connect(sess.session_id, device.token);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Session creation error');
      goHome();
    }
  };

  const handleFileSelect = (files: FileList | null) => {
    if (!files) return;
    const fileArray = Array.from(files);
    setSelectedFiles(fileArray);
  };

  const sendFileMetadata = () => {
    if (!sigRef.current || !session || !device) return;
    const filesMeta: FileInfo[] = selectedFiles.map((f, i) => ({
      id: `file_${i}_${Date.now()}`,
      name: f.name,
      size: f.size,
      type: f.type || 'application/octet-stream',
    }));
    const totalSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);

    sigRef.current.send({
      type: 'file_metadata',
      payload: {
        files: filesMeta,
        total_size: totalSize,
      },
    });
    setScreen('send');
  };

  const startWebRTCSender = () => {
    if (!sigRef.current || !session) return;
    const rtc = new WebRTCConnection(sigRef.current, true);
    rtcRef.current = rtc;

    sigRef.current.on('signal', (msg: unknown) => {
      const signalMsg = msg as { from: string; payload: { signal_type: string; data: unknown } };
      if (signalMsg.from !== device?.device_id) {
        rtc.handleSignal(signalMsg.payload);
      }
    });

    rtc.onConnectionStateChange = (state) => {
      if (state === 'failed' || state === 'disconnected') {
        setError('Connection lost');
        setScreen('failed');
      }
    };

    const dc = rtc.getDataChannel();
    if (dc) {
      dc.onopen = () => {
        const sender = new FileSender(dc, selectedFiles);
        senderRef.current = sender;
        sender.onProgress = setTransferProgress;
        sender.onComplete = () => setScreen('completed');
        sender.onError = (e) => {
          setError(e);
          setScreen('failed');
        };
        sender.start();
      };
    }

    rtc.createOffer();
  };

  // Receiver flow
  const startReceiving = () => {
    setRole('receiver');
    setScreen('receive');
  };

  const handlePairingCodeChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    setPairingInput(val);

    if (val.length === 6 && device) {
      try {
        const res = await joinSession(device.token, val);
        const sess: SessionInfo = {
          session_id: res.session_id,
          pairing_code: val,
          expires_at: '',
          state: res.state as SessionState,
          sender: res.sender,
        };
        setSession(sess);
        setPeerDevice(res.sender || null);

        const sig = new SignalingClient();
        sigRef.current = sig;

        sig.on('file_metadata', (msg: unknown) => {
          const payload = (msg as { payload: { files: FileInfo[]; total_size: number } }).payload;
          setIncomingFiles(payload.files);
          setIncomingTotalSize(payload.total_size);
          updateSessionState(device.token, sess.session_id, 'AWAITING_APPROVAL');
        });

        sig.on('signal', (msg: unknown) => {
          const signalMsg = msg as { from: string; payload: { signal_type: string; data: unknown } };
          if (signalMsg.from !== device?.device_id && rtcRef.current) {
            rtcRef.current.handleSignal(signalMsg.payload);
          }
        });

        sig.on('peer_left', () => {
          setError('Peer disconnected');
          goHome();
        });

        sig.connect(sess.session_id, device.token);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Join session error');
      }
    }
  };

  const acceptTransfer = () => {
    if (!sigRef.current || !session || !device) return;
    sigRef.current.send({
      type: 'transfer_response',
      payload: { accepted: true },
    });
    updateSessionState(device.token, session.session_id, 'CONNECTING');

    const rtc = new WebRTCConnection(sigRef.current, false);
    rtcRef.current = rtc;

    rtc.onDataChannel = (dc) => {
      const receiver = new FileReceiver(dc);
      receiverRef.current = receiver;
      receiver.onProgress = setTransferProgress;
      receiver.onComplete = (files) => {
        setCompletedFiles(files);
        setScreen('completed');
        updateSessionState(device.token, session.session_id, 'COMPLETED');
      };
      receiver.onError = (err) => {
        setError(err);
        setScreen('failed');
      };
      receiver.start();
    };

    setScreen('transfer');
  };

  const rejectTransfer = () => {
    if (!sigRef.current || !session || !device) return;
    sigRef.current.send({
      type: 'transfer_response',
      payload: { accepted: false },
    });
    updateSessionState(device.token, session.session_id, 'REJECTED');
    goHome();
  };

  const cancelTransfer = () => {
    if (senderRef.current) senderRef.current.cancel('User cancelled');
    if (receiverRef.current) receiverRef.current.cancel('User cancelled');
    if (session && device) updateSessionState(device.token, session.session_id, 'CANCELLED');
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
            <div>
              <p className="status-msg">Enter the 6-digit pairing code from the sender:</p>
              <div className="code-input">
                <input type="text" maxLength={6} value={pairingInput} onChange={handlePairingCodeChange} autoFocus placeholder="000000" />
              </div>
              {pairingInput.length > 0 && pairingInput.length < 6 && <p className="note" style={{ textAlign: 'center' }}>Enter 6 digits</p>}
            </div>
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
          <h2>Transferring Files</h2>
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
