import {
  NearbySignalingClient,
  NearbyPeerInfo,
  NearbyIncomingRequestPayload,
  NearbyPairedPayload,
} from './nearbySignaling';
import { isJwtValid, resetDevice } from './device';

export interface NearbyDiscoveredDevice {
  id: string; // ephemeral_id
  name: string; // display_name
  type: string; // device_type (e.g. desktop, mobile)
}

export type NearbyDiscoveryStatus =
  | 'idle'
  | 'searching'
  | 'found'
  | 'no_devices'
  | 'requesting'
  | 'incoming_request'
  | 'paired'
  | 'rejected'
  | 'unsupported'
  | 'error';

export interface NearbyIncomingRequest {
  requestId: string;
  fromDevice: NearbyDiscoveredDevice;
}

export interface NearbyDiscoveryOptions {
  onStatusChange?: (status: NearbyDiscoveryStatus, message?: string) => void;
  onDeviceListUpdate?: (devices: NearbyDiscoveredDevice[]) => void;
  onIncomingRequest?: (request: NearbyIncomingRequest) => void;
  onPaired?: (payload: NearbyPairedPayload) => void;
  onTokenRefreshed?: (newToken: string) => void;
}

export function detectDeviceType(): string {
  if (typeof navigator === 'undefined') return 'computer';
  const ua = navigator.userAgent.toLowerCase();
  if (/android/.test(ua)) return 'phone';
  if (/iphone|ipod/.test(ua)) return 'phone';
  if (/ipad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'tablet';
  return 'computer';
}

export class NearbyDiscoveryManager {
  private signaling: NearbySignalingClient | null = null;
  private status: NearbyDiscoveryStatus = 'idle';
  private discoveredDevices: NearbyDiscoveredDevice[] = [];
  private pendingIncomingRequest: NearbyIncomingRequest | null = null;
  private options: NearbyDiscoveryOptions;
  private authRetryCount: number = 0;
  private currentToken: string = '';
  private currentDisplayName: string = '';

  constructor(options?: NearbyDiscoveryOptions) {
    this.options = options || {};
  }

  getStatus(): NearbyDiscoveryStatus {
    return this.status;
  }

  getDiscoveredDevices(): NearbyDiscoveredDevice[] {
    return [...this.discoveredDevices];
  }

  getIncomingRequest(): NearbyIncomingRequest | null {
    return this.pendingIncomingRequest;
  }

  private setStatus(status: NearbyDiscoveryStatus, message?: string): void {
    this.status = status;
    if (this.options.onStatusChange) {
      this.options.onStatusChange(status, message);
    }
  }

  /**
   * Starts Nearby discovery by connecting to WebSocket signaling and announcing presence.
   * Proactively verifies JWT validity and transparently refreshes if expired.
   */
  async startDiscovery(token: string, displayName: string): Promise<void> {
    this.stopDiscovery();
    this.currentDisplayName = displayName;

    let activeToken = token;
    // Pre-flight check: if token is invalid or expired, refresh first
    if (!isJwtValid(activeToken)) {
      try {
        const freshDev = await resetDevice(displayName);
        activeToken = freshDev.token;
        if (this.options.onTokenRefreshed) {
          this.options.onTokenRefreshed(activeToken);
        }
      } catch {
        this.setStatus('error', 'Authentication failed');
        return;
      }
    }

    this.currentToken = activeToken;
    this.setStatus('searching');
    this.discoveredDevices = [];

    this.signaling = new NearbySignalingClient();

    this.signaling.on('open', () => {
      this.authRetryCount = 0;
      const devType = detectDeviceType();
      this.signaling?.announce(this.currentDisplayName, devType);
    });

    this.signaling.on('nearby_peer_list', (payload: unknown) => {
      const data = payload as { peers?: NearbyPeerInfo[] };
      const peers = data.peers || [];
      this.discoveredDevices = peers.map((p) => ({
        id: p.ephemeral_id,
        name: p.display_name,
        type: p.device_type,
      }));

      if (this.options.onDeviceListUpdate) {
        this.options.onDeviceListUpdate(this.discoveredDevices);
      }

      if (this.status === 'searching' || this.status === 'found' || this.status === 'no_devices') {
        if (this.discoveredDevices.length > 0) {
          this.setStatus('found');
        } else {
          this.setStatus('no_devices');
        }
      }
    });

    this.signaling.on('nearby_incoming_request', (payload: unknown) => {
      const data = payload as NearbyIncomingRequestPayload;
      if (data && data.request_id && data.from_device) {
        this.pendingIncomingRequest = {
          requestId: data.request_id,
          fromDevice: {
            id: data.from_device.ephemeral_id,
            name: data.from_device.display_name,
            type: data.from_device.device_type,
          },
        };
        this.setStatus('incoming_request');
        if (this.options.onIncomingRequest) {
          this.options.onIncomingRequest(this.pendingIncomingRequest);
        }
      }
    });

    this.signaling.on('nearby_rejected', () => {
      this.setStatus('rejected', 'Connection request was declined');
      setTimeout(() => {
        if (this.signaling) {
          this.setStatus(this.discoveredDevices.length > 0 ? 'found' : 'no_devices');
        }
      }, 3000);
    });

    this.signaling.on('nearby_paired', (payload: unknown) => {
      const data = payload as NearbyPairedPayload;
      this.setStatus('paired');
      if (this.options.onPaired) {
        this.options.onPaired(data);
      }
      this.stopDiscovery();
    });

    this.signaling.on('error', (payload: unknown) => {
      const data = payload as { code?: string; message?: string } | undefined;
      const errorCode = data?.code;

      if (errorCode === 'UNAUTHORIZED' && this.authRetryCount < 2) {
        this.authRetryCount++;
        // Refresh token preserving display name and reconnect
        resetDevice(this.currentDisplayName)
          .then((fresh) => {
            if (this.options.onTokenRefreshed) {
              this.options.onTokenRefreshed(fresh.token);
            }
            this.startDiscovery(fresh.token, this.currentDisplayName);
          })
          .catch(() => {
            this.setStatus('error', 'Authentication failed');
          });
        return;
      }

      this.setStatus('error', data?.message || 'Unable to connect to discovery service');
    });

    this.signaling.on('close', () => {
      if (this.status !== 'paired' && this.status !== 'idle' && this.status !== 'error') {
        this.setStatus('idle');
      }
    });

    this.signaling.connect(activeToken);
  }

  /**
   * Request connection to a discovered peer.
   */
  connectToPeer(targetEphemeralId: string): void {
    if (!this.signaling) return;
    this.setStatus('requesting');
    this.signaling.requestPair(targetEphemeralId);
  }

  /**
   * Accept an incoming connection request.
   */
  acceptIncomingRequest(): void {
    if (!this.signaling || !this.pendingIncomingRequest) return;
    this.signaling.respondToRequest(this.pendingIncomingRequest.requestId, true);
  }

  /**
   * Decline an incoming connection request.
   */
  declineIncomingRequest(): void {
    if (!this.signaling || !this.pendingIncomingRequest) return;
    this.signaling.respondToRequest(this.pendingIncomingRequest.requestId, false);
    this.pendingIncomingRequest = null;
    this.setStatus(this.discoveredDevices.length > 0 ? 'found' : 'no_devices');
  }

  /**
   * Stops discovery and closes WebSocket connection.
   */
  stopDiscovery(): void {
    if (this.signaling) {
      this.signaling.disconnect();
      this.signaling = null;
    }
    this.pendingIncomingRequest = null;
  }

  reset(): void {
    this.stopDiscovery();
    this.status = 'idle';
    this.discoveredDevices = [];
    this.authRetryCount = 0;
  }
}
