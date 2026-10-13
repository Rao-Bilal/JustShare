import React, { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { parsePairingCodeFromHash } from '../services/pairingUrl';

interface QrScannerProps {
  onScan: (code: string) => void;
  onClose: () => void;
}

export function QrScanner({ onScan, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasStarted, setHasStarted] = useState(false);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;

    async function startCamera() {
      try {
        if (!window.isSecureContext) {
          setError(
            'Camera access requires a secure connection (HTTPS or localhost). If opening over local IP (http://192.168.x.x), browsers disable camera APIs for security.'
          );
          return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setError('Camera access is not supported by your browser.');
          return;
        }

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
          });
        } catch {
          // Fallback if environment (back) camera is not present (e.g. desktop webcam)
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
          });
        }

        if (!activeRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setHasStarted(true);
        }

        // Start scanning frames if BarcodeDetector is supported
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const globalAny = window as any;
        if (globalAny.BarcodeDetector) {
          const detector = new globalAny.BarcodeDetector({ formats: ['qr_code'] });
          const detectInterval = setInterval(async () => {
            if (!activeRef.current || !videoRef.current) {
              clearInterval(detectInterval);
              return;
            }
            try {
              if (videoRef.current.readyState >= 2) {
                const barcodes = await detector.detect(videoRef.current);
                if (barcodes.length > 0) {
                  const rawValue = barcodes[0].rawValue || '';
                  // Check if rawValue is a 6-digit code or URL with #code=XXXXXX
                  const codeFromHash = parsePairingCodeFromHash(rawValue);
                  if (codeFromHash) {
                    clearInterval(detectInterval);
                    onScan(codeFromHash);
                  } else if (/^\d{6}$/.test(rawValue.trim())) {
                    clearInterval(detectInterval);
                    onScan(rawValue.trim());
                  } else {
                    // Try parsing as URL
                    try {
                      const url = new URL(rawValue);
                      const parsed = parsePairingCodeFromHash(url.hash);
                      if (parsed) {
                        clearInterval(detectInterval);
                        onScan(parsed);
                      }
                    } catch {
                      // Not a valid URL
                    }
                  }
                }
              }
            } catch {
              // Detection error on frame
            }
          }, 300);
        }
      } catch (err) {
        if (activeRef.current) {
          const msg = err instanceof Error ? err.message : 'Camera permission denied or camera unavailable.';
          setError(msg);
        }
      }
    }

    startCamera();

    return () => {
      activeRef.current = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, [onScan]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', width: '100%' }}>
      <div
        style={{
          width: '100%',
          maxWidth: '320px',
          height: '240px',
          backgroundColor: '#000',
          borderRadius: '8px',
          overflow: 'hidden',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {!hasStarted && !error && (
          <p style={{ position: 'absolute', color: '#fff', fontSize: '0.875rem' }}>
            Starting camera...
          </p>
        )}
      </div>

      {error ? (
        <p style={{ color: 'var(--status-danger)', fontSize: '0.875rem', textAlign: 'center' }}>
          {error}
        </p>
      ) : (
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textAlign: 'center' }}>
          Point camera at the sender’s QR code
        </p>
      )}

      <Button variant="secondary" onClick={onClose}>
        Close camera
      </Button>
    </div>
  );
}
