import React, { useState } from 'react';
import { QRCodeDisplay } from './QRCodeDisplay';
import { Button } from './Button';
import { IconCopy, IconCheck, IconLock, IconClock, IconQrCode, IconMail, IconShare, IconShield } from './Icons';

import { formatBytes } from '../services/format';
import { FileRow } from './FileRow';

interface ShareManagementModalProps {
  pairingCode: string;
  expiresInSeconds?: number | null;
  onGenerateNewCode?: () => void;
  onClose?: () => void;
  stagedFiles?: File[];
  totalStagedSize?: number;
  onRemoveFile?: (index: number) => void;
  onPreviewFile?: (file: File) => void;
  onAddMoreFiles?: () => void;
}

export function ShareManagementModal({
  pairingCode,
  expiresInSeconds,
  onGenerateNewCode,
  onClose,
  stagedFiles = [],
  totalStagedSize = 0,
  onRemoveFile,
  onPreviewFile,
  onAddMoreFiles,
}: ShareManagementModalProps) {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'link' | 'qr'>('link');
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [password, setPassword] = useState('');
  const [oneTimeDownload, setOneTimeDownload] = useState(true);
  const [expirationSetting, setExpirationSetting] = useState<'10m' | '1h' | '24h'>('10m');

  const shareUrl = `${window.location.origin}/#join=${pairingCode}`;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(pairingCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const handleShareEmail = () => {
    const subject = encodeURIComponent('File transfer via JustShare');
    const body = encodeURIComponent(
      `I would like to share files with you via JustShare.\n\nJoin the session directly:\n${shareUrl}\n\nOr enter code: ${pairingCode}`
    );
    window.open(`mailto:?subject=${subject}&body=${body}`);
  };

  return (
    <div className="share-management-card">
      <div className="share-modal-header">
        <div className="share-header-title">
          <div className="share-header-icon" aria-hidden="true">
            <IconShare size={20} />
          </div>
          <div>
            <h3>Connect Device</h3>
          </div>
        </div>
        {onClose && (
          <button type="button" className="share-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
      </div>

      {/* Share Tab Switcher */}
      <div className="share-mode-toggle">
        <button
          type="button"
          className={`share-mode-btn ${activeTab === 'link' ? 'active' : ''}`}
          onClick={() => setActiveTab('link')}
        >
          6-Digit Code
        </button>
        <button
          type="button"
          className={`share-mode-btn ${activeTab === 'qr' ? 'active' : ''}`}
          onClick={() => setActiveTab('qr')}
        >
          <IconQrCode size={16} /> QR Code
        </button>
      </div>

      {activeTab === 'link' ? (
        <div className="share-link-section">
          {/* 6-Digit Pairing Code Display */}
          <div className="share-code-group">
            <p className="text-xs text-neutral-500 mb-1">
              Enter this 6-digit code on the receiving device to connect:
            </p>
            <div className="pairing-code-large">
              {pairingCode.split('').map((digit, idx) => (
                <div key={idx} className="code-box-display">
                  {digit}
                </div>
              ))}
            </div>
            <div className="share-code-actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopyCode}
                icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              >
                {copied ? 'Copied' : 'Copy Code'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleShareEmail}
                icon={<IconMail size={14} />}
              >
                Send via Email
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="share-qr-section">
          <p className="share-qr-instruction">
            Scan this QR code with any phone camera or QR reader to connect instantly.
          </p>
          <div className="qr-box-container">
            <QRCodeDisplay pairingCode={pairingCode} />
          </div>
        </div>
      )}

      {/* Staged Files to Send */}
      <div className="share-staged-files-section mt-5 pt-4 border-t border-neutral-200">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-bold text-neutral-800">Files to Send</h4>
            <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-700 font-semibold">
              {stagedFiles.length}
            </span>
          </div>
          {onAddMoreFiles && (
            <button
              type="button"
              className="text-xs text-orange-600 hover:text-orange-700 font-semibold cursor-pointer border-0 bg-transparent"
              onClick={onAddMoreFiles}
            >
              + Add more files
            </button>
          )}
        </div>

        {stagedFiles.length > 0 ? (
          <div>
            <div className="file-list max-h-48 overflow-y-auto pr-1 flex flex-col gap-2">
              {stagedFiles.map((file, idx) => (
                <FileRow
                  key={`${file.name}_${idx}`}
                  name={file.name}
                  size={file.size}
                  relativePath={file.webkitRelativePath}
                  onRemove={onRemoveFile ? () => onRemoveFile(idx) : undefined}
                  onPreview={onPreviewFile ? () => onPreviewFile(file) : undefined}
                />
              ))}
            </div>
            <div className="flex items-center justify-between mt-3 text-xs text-neutral-500 font-medium">
              <span>Total size: <strong className="text-neutral-800">{formatBytes(totalStagedSize)}</strong></span>
              <span>Waiting for recipient to connect...</span>
            </div>
          </div>
        ) : (
          <div className="p-4 bg-neutral-50 border border-neutral-200/80 rounded-xl text-center">
            <p className="text-xs text-neutral-500">No files selected yet.</p>
            {onAddMoreFiles && (
              <button
                type="button"
                className="mt-2 text-xs font-semibold text-orange-600 hover:underline cursor-pointer border-0 bg-transparent"
                onClick={onAddMoreFiles}
              >
                + Choose files to send
              </button>
            )}
          </div>
        )}
      </div>

      {/* Security & Access Controls */}
      <div className="share-security-options">
        <h4 className="security-options-title">Security & Transfer Options</h4>

        <div className="option-row">
          <div className="option-info">
            <span className="option-name">Password Protection</span>
            <span className="option-desc">Requires recipient to enter passkey before approval</span>
          </div>
          <label className="switch-toggle" aria-label="Toggle password protection">
            <input
              type="checkbox"
              checked={passwordEnabled}
              onChange={(e) => setPasswordEnabled(e.target.checked)}
            />
            <span className="slider-round" />
          </label>
        </div>

        {passwordEnabled && (
          <div className="password-input-wrap">
            <input
              type="password"
              placeholder="Enter session passkey..."
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="option-text-input"
            />
          </div>
        )}

        <div className="option-row">
          <div className="option-info">
            <span className="option-name">One-Time Download</span>
            <span className="option-desc">Automatically ends session once recipient finishes</span>
          </div>
          <label className="switch-toggle" aria-label="Toggle one-time download">
            <input
              type="checkbox"
              checked={oneTimeDownload}
              onChange={(e) => setOneTimeDownload(e.target.checked)}
            />
            <span className="slider-round" />
          </label>
        </div>

        <div className="option-row">
          <div className="option-info">
            <span className="option-name">Link Expiration</span>
            <span className="option-desc">
              {expiresInSeconds !== null && expiresInSeconds !== undefined && expiresInSeconds > 0
                ? `Active session expires in ${Math.floor(expiresInSeconds / 60)}m ${expiresInSeconds % 60}s`
                : 'Session duration limit'}
            </span>
          </div>
          <select
            className="option-select"
            value={expirationSetting}
            onChange={(e) => setExpirationSetting(e.target.value as '10m' | '1h' | '24h')}
            aria-label="Link expiration duration"
          >
            <option value="10m">10 minutes</option>
            <option value="1h">1 hour</option>
            <option value="24h">24 hours</option>
          </select>
        </div>
      </div>

      {expiresInSeconds === 0 && onGenerateNewCode && (
        <div className="expiry-warning-banner">
          <span>This code has expired.</span>
          <Button variant="link" onClick={onGenerateNewCode}>
            Generate New Code
          </Button>
        </div>
      )}
    </div>
  );
}
