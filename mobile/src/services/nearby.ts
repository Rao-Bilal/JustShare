/**
 * Nearby Discovery Manager for JustShare Mobile.
 * Manages device announcements, scanning, incoming requests, and pairing states.
 */
import {
  NearbySignalingClient,
  NearbyPeerInfo,
  NearbyIncomingRequestPayload,
  NearbyPairedPayload,
} from './nearbySignaling';
import { isJwtValid, getOrCreateDevice } from './device';

export interface NearbyDiscoveredDevice {
  id: string; // ephemeral_id
  name: string; // display_name
  type: string; // device_type (phone, computer, etc.)
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

export class NearbyDiscoveryManager {
  private signaling: NearbySignalingClient | null = null;
  private status: NearbyDiscoveryStatus = 'idle';
  private discoveredDevices: NearbyDiscoveredDevice[] = [];
  private pendingIncomingRequest: NearbyIncomingRequest | null = null;
  private options: NearbyDiscoveryOptions;
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

  async startDiscovery(token: string, displayName: string): Promise<void> {
    this.stopDiscovery();
    this.currentDisplayName = displayName;

    let activeToken = token;
    if (!isJwtValid(activeToken)) {
      try {
        const freshDev = await getOrCreateDevice(true);
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
    this.discoveredDevices = [];
    this.setStatus('searching');

    this.signaling = new NearbySignalingClient();

    this.signaling.on('open', () => {
      this.signaling?.announce(this.currentDisplayName, 'phone');
    });

    this.signaling.on('nearby_peer_list', (payload: { peers?: NearbyPeerInfo[] }) => {
      const peers = payload.peers || [];
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

    this.signaling.on('nearby_incoming_request', (payload: NearbyIncomingRequestPayload) => {
      const incoming: NearbyIncomingRequest = {
        requestId: payload.request_id,
        fromDevice: {
          id: payload.from_device.ephemeral_id,
          name: payload.from_device.display_name,
          type: payload.from_device.device_type,
        },
      };

      this.pendingIncomingRequest = incoming;
      this.setStatus('incoming_request');

      if (this.options.onIncomingRequest) {
        this.options.onIncomingRequest(incoming);
      }
    });

    this.signaling.on('nearby_rejected', () => {
      this.setStatus('rejected', 'Connection request was declined');
      setTimeout(() => {
        if (this.status === 'rejected') {
          this.setStatus(this.discoveredDevices.length > 0 ? 'found' : 'no_devices');
        }
      }, 3000);
    });

    this.signaling.on('nearby_paired', (payload: NearbyPairedPayload) => {
      this.setStatus('paired');
      if (this.options.onPaired) {
        this.options.onPaired(payload);
      }
    });

    this.signaling.on('error', () => {
      this.setStatus('error', 'Signaling connection error');
    });

    this.signaling.on('close', () => {
      if (this.status !== 'idle' && this.status !== 'paired') {
        this.setStatus('idle');
      }
    });

    try {
      this.signaling.connect(this.currentToken);
    } catch {
      this.setStatus('error', 'Could not establish connection');
    }
  }

  requestPair(targetEphemeralId: string): void {
    if (!this.signaling) return;
    this.setStatus('requesting');
    this.signaling.requestPair(targetEphemeralId);
  }

  respondToIncomingRequest(accepted: boolean): void {
    if (!this.signaling || !this.pendingIncomingRequest) return;
    this.signaling.respondToRequest(this.pendingIncomingRequest.requestId, accepted);

    if (!accepted) {
      this.pendingIncomingRequest = null;
      this.setStatus(this.discoveredDevices.length > 0 ? 'found' : 'no_devices');
    }
  }

  stopDiscovery(): void {
    if (this.signaling) {
      this.signaling.disconnect();
      this.signaling = null;
    }
    this.discoveredDevices = [];
    this.pendingIncomingRequest = null;
    this.setStatus('idle');
  }
}
