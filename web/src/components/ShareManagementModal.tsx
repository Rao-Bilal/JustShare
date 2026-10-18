import React, { useState } from 'react';
import { QRCodeDisplay } from './QRCodeDisplay';
import { Button } from './Button';
import { IconCopy, IconCheck, IconLock, IconClock, IconQrCode, IconMail, IconShare, IconShield } from './Icons';

interface ShareManagementModalProps {
  pairingCode: string;
  expiresInSeconds?: number | null;
  onGenerateNewCode?: () => void;
  onClose?: () => void;
}

export function ShareManagementModal({
  pairingCode,
  expiresInSeconds,
  onGenerateNewCode,
  onClose,
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
            <h3>Share & Access Control</h3>
            <p className="share-header-desc">
              Direct peer-to-peer connection with end-to-end WebRTC security
            </p>
          </div>
        </div>
        {onClose && (
          <button type="button" className="share-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
      </div>

      {/* Trust Badges */}
      <div className="trust-badges-row">
        <div className="trust-badge">
          <IconShield size={14} />
          <span>Zero-Knowledge</span>
        </div>
        <div className="trust-badge">
          <IconLock size={14} />
          <span>DTLS-SRTP 256-bit</span>
        </div>
        <div className="trust-badge">
          <IconClock size={14} />
          <span>Ephemerally Cached</span>
        </div>
      </div>

      {/* Share Tab Switcher */}
      <div className="share-mode-toggle">
        <button
          type="button"
          className={`share-mode-btn ${activeTab === 'link' ? 'active' : ''}`}
          onClick={() => setActiveTab('link')}
        >
          Quick Link & Code
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
          {/* One-Click Direct Link */}
          <div className="share-input-group">
            <label className="share-input-label">Direct Shareable Link</label>
            <div className="share-copy-box">
              <input
                type="text"
                readOnly
                value={shareUrl}
                className="share-url-input"
                aria-label="Direct Share Link"
              />
              <Button
                variant="primary"
                className="btn-copy-link"
                onClick={handleCopyLink}
                icon={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              >
                {copied ? 'Copied!' : 'Copy Link'}
              </Button>
            </div>
          </div>

          {/* 6-Digit Pairing Code Display */}
          <div className="share-code-group">
            <label className="share-input-label">6-Digit Pairing Code</label>
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
