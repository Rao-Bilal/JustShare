import { useEffect, useRef } from 'react';
import { TransferProgress, AppScreen } from '../types';
import { formatBytes, formatEta, formatSpeed } from '../services/format';
import { formatDuration, truncateMiddle, mapTechnicalError } from '../services/errorMapper';
import { ProgressBar } from './ProgressBar';
import { FileRow } from './FileRow';
import { StatusBadge } from './StatusBadge';
import { COPY } from '../copy';

export interface TransferScreenProps {
  screen: AppScreen;
  role: 'sender' | 'receiver' | null;
  peerName?: string;
  transferProgress: TransferProgress | null;
  files: { name: string; size: number; relativePath?: string }[];
  completedFiles: { name: string; blob: Blob; verified: boolean }[];
  transferDurationSecs: number | null;
  error: string | null;
  onCancel: () => void;
  onBackToHome: () => void;
  onResumeTransfer?: () => void;
  isResumable?: boolean;
  onTryAgain?: () => void;
  onSendMore?: () => void;
  onReceiveMore?: () => void;
}

export function TransferScreen({
  screen,
  role,
  peerName = 'device',
  transferProgress,
  files,
  completedFiles,
  transferDurationSecs,
  error,
  onCancel,
  onBackToHome,
  onResumeTransfer,
  isResumable = false,
  onTryAgain,
  onSendMore,
  onReceiveMore,
}: TransferScreenProps) {
  const isTransferring = screen === 'transfer';
  const isCompleted = screen === 'completed';
  const isFailedOrCancelled = screen === 'failed' || screen === 'cancelled';
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // 1. Beforeunload confirmation during active transfer
  useEffect(() => {
    if (!isTransferring) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isTransferring]);

  // 2. Intercept browser back button with confirm dialog during active transfer
  useEffect(() => {
    if (!isTransferring) return;
    window.history.pushState({ transferActive: true }, document.title);

    const handlePopState = () => {
      onCancel();
      window.history.pushState({ transferActive: true }, document.title);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isTransferring, onCancel]);

  // 3. Screen Wake Lock where supported (feature-detected, fails silently)
  useEffect(() => {
    if (!isTransferring) return;
    let isMounted = true;

    if ('wakeLock' in navigator && typeof navigator.wakeLock.request === 'function') {
      navigator.wakeLock
        .request('screen')
        .then((sentinel) => {
          if (isMounted) {
            wakeLockRef.current = sentinel;
          } else {
            sentinel.release().catch(() => {});
          }
        })
        .catch(() => {
          // Fails silently if battery saver or permissions disallow
        });
    }

    return () => {
      isMounted = false;
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [isTransferring]);

  // Safe file list to display
  const displayFiles =
    completedFiles.length > 0
      ? completedFiles.map((f) => ({ name: f.name, size: f.blob.size, verified: f.verified }))
      : files.map((f) => ({ name: f.name, size: f.size, verified: undefined }));

  const currentFileIdx = transferProgress ? transferProgress.currentFileIndex : 0;
  const totalFilesCount = transferProgress ? transferProgress.totalFiles : displayFiles.length || 1;
  const isVerifying = transferProgress?.state === 'verifying';
  const isReconnecting = transferProgress?.state === 'reconnecting';

  return (
    <div className="transfer-screen-container" data-purpose="transfer-screen">
      <div className="transfer-card">
        {/* Direction-specific Header */}
        <header className="transfer-card-header">
          {isCompleted ? (
            <div>
              <div className="transfer-status-chip success">
                <span className="dot bg-emerald-500"></span>
                <span>
                  {role === 'sender'
                    ? COPY.transfer.doneSendingTitle(completedFiles.length || totalFilesCount)
                    : COPY.transfer.doneReceivingTitle(completedFiles.length || totalFilesCount)}
                </span>
              </div>
              <h2 className="transfer-title">{COPY.transfer.doneSubtitle}</h2>
              {transferDurationSecs !== null && (
                <p className="transfer-subtitle">
                  {COPY.transfer.timeElapsed(formatDuration(transferDurationSecs))}
                </p>
              )}
            </div>
          ) : isFailedOrCancelled ? (
            <div>
              <div className="transfer-status-chip error">
                <span className="dot bg-rose-500"></span>
                <span>{screen === 'cancelled' ? COPY.errors.transferCancelled.headline : mapTechnicalError(error).headline}</span>
              </div>
              <h2 className="transfer-title">
                {screen === 'cancelled' ? COPY.errors.transferCancelled.cause : mapTechnicalError(error).cause}
              </h2>
              <p className="transfer-subtitle">
                {screen === 'cancelled' ? COPY.errors.transferCancelled.nextStep : mapTechnicalError(error).nextStep}
              </p>
            </div>
          ) : (
            <div>
              <div className="transfer-status-chip active">
                <span className="dot bg-brand-orange animate-pulse"></span>
                <span>
                  {role === 'sender'
                    ? COPY.transfer.titleSending(peerName)
                    : COPY.transfer.titleReceiving(peerName)}
                </span>
              </div>
              <h2 className="transfer-title">
                {isVerifying
                  ? COPY.transfer.stateVerifying
                  : isReconnecting
                  ? COPY.transfer.stateReconnecting
                  : COPY.transfer.fileCounter(currentFileIdx + 1, totalFilesCount)}
              </h2>
              {transferProgress && !isVerifying && (
                <p className="transfer-subtitle" title={transferProgress.currentFile}>
                  {truncateMiddle(transferProgress.currentFile || '', 32)}
                </p>
              )}
            </div>
          )}
        </header>

        {/* Progress Bar & Real-time Metrics (During Active Transfer) */}
        {isTransferring && (
          <section className="transfer-progress-section">
            <ProgressBar
              value={transferProgress?.percentage || 0}
              indeterminate={isVerifying || !transferProgress}
            />

            {isVerifying ? (
              <p className="transfer-verifying-text">{COPY.transfer.stateVerifyingDesc}</p>
            ) : transferProgress ? (
              <div className="transfer-metrics-grid">
                <div className="metric-col">
                  <span className="metric-label">{COPY.transfer.transferredLabel}</span>
                  <span className="metric-val tabular-numbers">
                    {formatBytes(transferProgress.bytesTransferred)} / {formatBytes(transferProgress.totalBytes)} ({transferProgress.percentage.toFixed(0)}%)
                  </span>
                </div>
                <div className="metric-col">
                  <span className="metric-label">{COPY.transfer.speedLabel}</span>
                  <span className="metric-val tabular-numbers">
                    {transferProgress.speed > 0 ? formatSpeed(transferProgress.speed) : COPY.transfer.calculating}
                  </span>
                </div>
                <div className="metric-col">
                  <span className="metric-label">{COPY.transfer.timeLeftLabel}</span>
                  <span className="metric-val tabular-numbers">
                    {transferProgress.eta !== null && transferProgress.eta > 0
                      ? formatEta(transferProgress.eta)
                      : COPY.transfer.calculating}
                  </span>
                </div>
              </div>
            ) : (
              <p className="transfer-connecting-text">{COPY.transfer.stateConnecting}</p>
            )}
          </section>
        )}

        {/* File List Container with independent scrolling */}
        {displayFiles.length > 0 && (
          <section className="transfer-files-section">
            <div className="transfer-file-list" tabIndex={0} aria-label="Transferring files list">
              {displayFiles.map((file, idx) => (
                <div key={idx} className="transfer-file-item">
                  <FileRow
                    name={file.name}
                    size={file.size}
                    relativePath={files[idx]?.relativePath}
                    showMiddleTruncate
                  />
                  {/* Status / Save Action when completed */}
                  {isCompleted && role === 'receiver' && completedFiles[idx] && (
                    <div className="completed-file-action">
                      <StatusBadge status={completedFiles[idx].verified ? 'success' : 'warning'}>
                        {completedFiles[idx].verified
                          ? COPY.completed.hashVerifiedBadge
                          : COPY.completed.hashFailedBadge}
                      </StatusBadge>
                      <button
                        type="button"
                        className="btn-download-file"
                        onClick={() => {
                          const url = URL.createObjectURL(completedFiles[idx].blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = completedFiles[idx].name;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        {COPY.completed.saveFile}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Action Controls Area (Sticky on mobile, clean buttons) */}
        <footer className="transfer-actions-bar">
          {isTransferring && (
            <button
              type="button"
              className="btn btn-destructive transfer-action-btn"
              onClick={onCancel}
            >
              {COPY.transfer.cancel}
            </button>
          )}

          {isCompleted && (
            <div className="completed-actions-group">
              <button
                type="button"
                className="btn btn-primary transfer-action-btn"
                onClick={onBackToHome}
              >
                {COPY.transfer.backToHome}
              </button>
              {role === 'sender' && onSendMore ? (
                <button
                  type="button"
                  className="btn btn-secondary transfer-action-btn"
                  onClick={onSendMore}
                >
                  {COPY.transfer.sendMore}
                </button>
              ) : role === 'receiver' && onReceiveMore ? (
                <button
                  type="button"
                  className="btn btn-secondary transfer-action-btn"
                  onClick={onReceiveMore}
                >
                  {COPY.transfer.receiveMore}
                </button>
              ) : null}
            </div>
          )}

          {isFailedOrCancelled && (
            <div className="failed-actions-group">
              {isResumable && onResumeTransfer && (
                <button
                  type="button"
                  className="btn btn-primary transfer-action-btn"
                  onClick={onResumeTransfer}
                >
                  {COPY.transfer.resumeTransfer}
                </button>
              )}
              {onTryAgain && (
                <button
                  type="button"
                  className={isResumable ? 'btn btn-secondary transfer-action-btn' : 'btn btn-primary transfer-action-btn'}
                  onClick={onTryAgain}
                >
                  {COPY.transfer.tryAgain}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary transfer-action-btn"
                onClick={onBackToHome}
              >
                {COPY.transfer.backToHome}
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
