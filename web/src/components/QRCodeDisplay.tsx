import qrcode from 'qrcode-generator';
import { useMemo, useState } from 'react';
import { buildPairingUrl, isLocalhostHostname } from '../services/pairingUrl';
import { Button } from './Button';
import { IconCheck, IconCopy } from './Icons';

interface QRCodeDisplayProps {
  pairingCode: string;
  showCopyLink?: boolean;
}

export function QRCodeDisplay({ pairingCode, showCopyLink = true }: QRCodeDisplayProps) {
  const envOrigin = import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined;
  const [copiedLink, setCopiedLink] = useState(false);

  const url = useMemo(() => {
    return buildPairingUrl(window.location.origin, pairingCode, envOrigin);
  }, [pairingCode, envOrigin]);

  const qrDataUrl = useMemo(() => {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      return qr.createDataURL(5, 4);
    } catch (err) {
      console.error('Failed to generate QR code:', err);
      return null;
    }
  }, [url]);

  const isLocalhost = useMemo(() => {
    return isLocalhostHostname(window.location.hostname) && !envOrigin;
  }, [envOrigin]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) {
      console.warn('Copy link failed:', err);
    }
  };

  if (!qrDataUrl) return null;

  return (
    <div className="qr-display-container">
      <div className="qr-frame">
        <img
          src={qrDataUrl}
          alt={`Scan QR code to join session ${pairingCode}`}
          className="qr-image"
        />
      </div>
      <p className="qr-caption">
        Point camera or QR scanner at the code
      </p>

      {showCopyLink && (
        <Button
          variant="secondary"
          size="sm"
          onClick={handleCopyLink}
          icon={copiedLink ? <IconCheck size={14} /> : <IconCopy size={14} />}
          className="qr-copy-btn"
        >
          {copiedLink ? 'Link Copied!' : 'Copy Pairing Link'}
        </Button>
      )}

      {isLocalhost && (
        <div className="localhost-banner">
          <strong>Localhost Notice:</strong> When testing across devices on Wi-Fi, open JustShare using your local network IP (e.g. <code>http://192.168.x.x:5173</code>), or enter the 6-digit code manually.
        </div>
      )}
    </div>
  );
}
