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
import { IconWifi, IconQrCode, IconKeypad, IconRefreshCw } from './Icons';

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
        <div className="nearby-prompt-card" role="alert">
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

      {/* Discovered Devices List */}
      {devices.length > 0 ? (
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
      ) : (
        /* Empty / Searching State */
        <div className="nearby-searching-box">
          <div className="nearby-pulse-radar" aria-hidden="true">
            <span className="pulse-ring ring-1" />
            <span className="pulse-ring ring-2" />
            <span className="pulse-icon">
              <IconWifi size={22} />
            </span>
          </div>

          <div className="nearby-searching-text">
            <p className="nearby-searching-title">
              {status === 'error' ? 'Discovery unavailable' : 'Looking for devices on your network…'}
            </p>
            <p className="nearby-searching-subtitle">
              {status === 'error'
                ? (statusMessage || 'Check local connection or use code/QR')
                : 'Open JustShare on another phone, tablet, or laptop to connect instantly.'}
            </p>
          </div>

          {status === 'error' && (
            <Button
              variant="secondary"
              size="sm"
              icon={<IconRefreshCw size={14} />}
              onClick={handleRetry}
            >
              Retry
            </Button>
          )}

          {(onSelectCode || onSelectQr) && (
            <div className="nearby-alt-links">
              {onSelectCode && (
                <button type="button" className="text-link" onClick={onSelectCode}>
                  <IconKeypad size={14} /> Enter 6-digit code
                </button>
              )}
              {onSelectCode && onSelectQr && <span className="text-link-sep">·</span>}
              {onSelectQr && (
                <button type="button" className="text-link" onClick={onSelectQr}>
                  <IconQrCode size={14} /> Scan QR
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {onClose && (
        <div className="nearby-close-bar">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Back
          </Button>
        </div>
      )}
    </div>
  );
}
