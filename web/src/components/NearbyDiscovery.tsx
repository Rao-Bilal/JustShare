import { useState, useEffect, useRef } from 'react';
import {
  NearbyDiscoveryManager,
  NearbyDiscoveryStatus,
  NearbyDiscoveredDevice,
  NearbyIncomingRequest,
} from '../services/nearby';
import { NearbyPairedPayload } from '../services/nearbySignaling';
import { DeviceTile } from './DeviceTile';
import { Button } from './Button';
import { IconQrCode, IconKeypad, IconRefreshCw, IconSmartphone, IconMonitor, IconLaptop, IconTablet } from './Icons';

interface NearbyDiscoveryProps {
  token: string;
  displayName: string;
  onPaired: (payload: NearbyPairedPayload) => void;
  onSelectQr?: () => void;
  onSelectCode?: () => void;
  onClose?: () => void;
  onTokenRefreshed?: (newToken: string) => void;
  variant?: 'embedded' | 'standalone';
}

function getBlipPosition(index: number, total: number) {
  // Deterministic distributed angles and radiuses around the radar screen
  const goldenAngle = 137.5 * (Math.PI / 180);
  const angle = (index + 1) * goldenAngle;
  // Radius between 30% and 82% from center
  const radiusPercent = 32 + ((index * 37) % 48);
  const x = 50 + (radiusPercent / 2) * Math.cos(angle);
  const y = 50 + (radiusPercent / 2) * Math.sin(angle);
  return { x: Math.max(12, Math.min(88, x)), y: Math.max(12, Math.min(88, y)) };
}

function getDeviceIcon(type: string, size = 16) {
  const t = (type || '').toLowerCase();
  if (t === 'phone' || t === 'mobile') return <IconSmartphone size={size} />;
  if (t === 'tablet') return <IconTablet size={size} />;
  if (t === 'desktop') return <IconMonitor size={size} />;
  return <IconLaptop size={size} />;
}

export function NearbyDiscovery({
  token,
  displayName,
  onPaired,
  onSelectQr,
  onSelectCode,
  onClose,
  onTokenRefreshed,
  variant = 'standalone',
}: NearbyDiscoveryProps) {
  const [status, setStatus] = useState<NearbyDiscoveryStatus>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [devices, setDevices] = useState<NearbyDiscoveredDevice[]>([]);
  const [incomingRequest, setIncomingRequest] = useState<NearbyIncomingRequest | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const managerRef = useRef<NearbyDiscoveryManager | null>(null);

  useEffect(() => {
    const manager = new NearbyDiscoveryManager({
      onStatusChange: (newStatus, msg) => {
        setStatus(newStatus);
        if (msg) setStatusMessage(msg);
        if (newStatus !== 'requesting') {
          setConnectingId(null);
        }
      },
      onDeviceListUpdate: (updatedDevices) => {
        setDevices(updatedDevices);
      },
      onIncomingRequest: (request) => {
        setIncomingRequest(request);
      },
      onPaired: (pairedPayload) => {
        onPaired(pairedPayload);
      },
      onTokenRefreshed: (newToken) => {
        if (onTokenRefreshed) onTokenRefreshed(newToken);
      },
    });

    managerRef.current = manager;

    if (token) {
      manager.startDiscovery(token, displayName);
    }

    return () => {
      manager.stopDiscovery();
    };
  }, [token, displayName, onPaired, onTokenRefreshed]);

  const handleConnect = (device: NearbyDiscoveredDevice) => {
    if (managerRef.current) {
      setConnectingId(device.id);
      managerRef.current.connectToPeer(device.id);
    }
  };

  const handleAccept = () => {
    if (managerRef.current) {
      managerRef.current.acceptIncomingRequest();
      setIncomingRequest(null);
    }
  };

  const handleDecline = () => {
    if (managerRef.current) {
      managerRef.current.declineIncomingRequest();
      setIncomingRequest(null);
    }
  };

  const handleRetry = () => {
    if (managerRef.current && token) {
      managerRef.current.startDiscovery(token, displayName);
    }
  };

  return (
    <div className={`nearby-section-container ${variant === 'embedded' ? 'is-embedded' : 'is-standalone'}`}>
      {/* State: Incoming Connection Request */}
      {status === 'incoming_request' && incomingRequest && (
        <div className="nearby-prompt-card mb-6" role="alert">
          <div className="nearby-prompt-header">
            <span className="nearby-prompt-badge">Connection Request</span>
            <h4 className="nearby-prompt-title">{incomingRequest.fromDevice.name} wants to connect</h4>
            <p className="nearby-prompt-desc">
              Accept to establish a direct, encrypted peer-to-peer file transfer.
            </p>
          </div>
          <div className="nearby-prompt-actions">
            <Button variant="secondary" onClick={handleDecline}>
              Decline
            </Button>
            <Button variant="primary" onClick={handleAccept}>
              Accept Connection
            </Button>
          </div>
        </div>
      )}

      {/* TACTICAL RADAR SCANNER CONTAINER */}
      <div className="radar-tactical-viewport">
        {/* Radar Scope Header */}
        <div className="radar-top-hud">
          <div className="radar-hud-left">
            <span className="radar-status-dot" />
            <span className="radar-hud-label">TACTICAL RADAR · LOCAL NET</span>
          </div>
          <div className="radar-hud-right">
            <span>RANGE: LOCAL</span>
            <span className="radar-hud-sep">/</span>
            <span className="radar-status-text">
              {status === 'error' ? 'OFFLINE' : connectingId ? 'LOCKING TARGET' : 'SCANNING'}
            </span>
          </div>
        </div>

        {/* Circular Radar Screen */}
        <div className="radar-scope-container">
          <div className="radar-circular-screen">
            {/* Concentric distance rings */}
            <div className="radar-range-ring ring-level-1" />
            <div className="radar-range-ring ring-level-2" />
            <div className="radar-range-ring ring-level-3" />
            <div className="radar-range-ring ring-level-4" />

            {/* Radar Crosshairs */}
            <div className="radar-axis axis-horizontal" />
            <div className="radar-axis axis-vertical" />
            <div className="radar-axis axis-diagonal-1" />
            <div className="radar-axis axis-diagonal-2" />

            {/* Azimuth / Compass indicators */}
            <span className="radar-heading heading-n">0° N</span>
            <span className="radar-heading heading-e">90° E</span>
            <span className="radar-heading heading-s">180° S</span>
            <span className="radar-heading heading-w">270° W</span>

            {/* Rotating radar sweep beam */}
            <div className="radar-sweep-beam" />

            {/* Center: Own Device Blip */}
            <div className="radar-center-host" title={`You: ${displayName}`}>
              <div className="radar-center-pulse" />
              <div className="radar-center-core">
                <span className="radar-center-label">YOU</span>
              </div>
            </div>

            {/* Discovered Peer Radar Targets */}
            {devices.map((dev, idx) => {
              const pos = getBlipPosition(idx, devices.length);
              const isConnecting = connectingId === dev.id || (status === 'requesting' && connectingId === dev.id);

              return (
                <button
                  key={dev.id}
                  type="button"
                  className={`radar-blip-target ${isConnecting ? 'is-connecting' : ''}`}
                  style={{
                    left: `${pos.x}%`,
                    top: `${pos.y}%`,
                  }}
                  onClick={() => handleConnect(dev)}
                  title={`Connect to ${dev.name}`}
                  aria-label={`Connect to ${dev.name}`}
                >
                  <span className="radar-blip-glow" />
                  <span className="radar-blip-dot" />
                  <span className="radar-blip-tag">
                    {getDeviceIcon(dev.type, 11)}
                    <span className="radar-blip-name">{dev.name}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Radar Bottom HUD Bar */}
        <div className="radar-bottom-hud">
          <div className="radar-hud-devices-count">
            TARGETS DETECTED: <strong className="text-emerald-400 font-mono">{devices.length}</strong>
          </div>
          <div className="radar-hud-status-line">
            {status === 'error' ? (
              <span className="text-red-400">DISCOVERY RESTRICTED: {statusMessage || 'CHECK NETWORK'}</span>
            ) : devices.length === 0 ? (
              <span className="radar-searching-flicker">SEARCHING AIRWAVES FOR NEARBY CLIENTS...</span>
            ) : (
              <span className="text-emerald-400">SELECT TARGET ON RADAR TO INITIATE TRANSFER</span>
            )}
          </div>
        </div>
      </div>

      {/* Discovered Devices Quick-List / Direct Fallback */}
      {devices.length > 0 && (
        <div className="mt-5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
            Discovered Devices ({devices.length})
          </h4>
          <div className="nearby-devices-grid" role="region" aria-label="Discovered Devices">
            {devices.map((dev) => (
              <DeviceTile
                key={dev.id}
                id={dev.id}
                name={dev.name}
                type={dev.type}
                isConnecting={connectingId === dev.id || (status === 'requesting' && connectingId === dev.id)}
                onClick={() => handleConnect(dev)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Error Retry Option */}
      {status === 'error' && (
        <div className="flex justify-center mt-4">
          <Button
            variant="secondary"
            size="sm"
            icon={<IconRefreshCw size={14} />}
            onClick={handleRetry}
          >
            Retry Radar Scan
          </Button>
        </div>
      )}

      {/* Alternate Methods (Code, QR, Back) */}
      <div className="flex items-center justify-between mt-6 pt-4 border-t border-neutral-200">
        <div className="flex items-center gap-3">
          {onSelectCode && (
            <button type="button" className="text-link text-xs flex items-center gap-1.5" onClick={onSelectCode}>
              <IconKeypad size={14} /> Enter 6-digit code
            </button>
          )}
          {onSelectCode && onSelectQr && <span className="text-neutral-300">·</span>}
          {onSelectQr && (
            <button type="button" className="text-link text-xs flex items-center gap-1.5" onClick={onSelectQr}>
              <IconQrCode size={14} /> Scan QR
            </button>
          )}
        </div>

        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose}>
            Back
          </Button>
        )}
      </div>
    </div>
  );
}

