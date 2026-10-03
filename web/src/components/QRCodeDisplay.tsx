import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { buildPairingUrl, isLocalhostHostname } from '../services/pairingUrl';

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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '1.5rem 0' }}>
      <div
        style={{
          background: '#ffffff',
          padding: '12px',
          borderRadius: '12px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
          display: 'inline-block',
        }}
      >
        <img
          src={qrDataUrl}
          alt={`Scan QR code to join session ${pairingCode}`}
          style={{ width: '180px', height: '180px', display: 'block' }}
        />
      </div>
      <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.5rem', textAlign: 'center' }}>
        Scan with camera or QR reader to connect
      </p>
      {isLocalhost && (
        <div
          style={{
            maxWidth: '340px',
            marginTop: '0.75rem',
            padding: '8px 12px',
            borderRadius: '8px',
            backgroundColor: 'rgba(234, 179, 8, 0.1)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
            color: '#fde047',
            fontSize: '0.78rem',
            textAlign: 'center',
            lineHeight: '1.4',
          }}
        >
          <strong>Localhost Notice:</strong> Opened via localhost. To scan from a phone, open JustShare on your computer using your local network IP (e.g. <code>http://192.168.x.x:5173</code>), or enter the 6-digit code manually.
        </div>
      )}
    </div>
  );
}
