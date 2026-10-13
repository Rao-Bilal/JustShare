import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { buildPairingUrl, isLocalhostHostname } from '../services/pairingUrl';
import { COPY } from '../copy';

interface QRCodeDisplayProps {
  pairingCode: string;
}

export function QRCodeDisplay({ pairingCode }: QRCodeDisplayProps) {
  const envOrigin = import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined;

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

  if (!qrDataUrl) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div className="qr-box">
        <img
          src={qrDataUrl}
          alt={`QR code for pairing session ${pairingCode}`}
        />
      </div>
      {isLocalhost && (
        <div className="notice-box" style={{ marginTop: '12px' }}>
          {COPY.send.localhostNotice}
        </div>
      )}
    </div>
  );
}
