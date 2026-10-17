/**
 * WebRTC Connection Manager for JustShare Mobile.
 * 
 * Works with react-native-webrtc in native builds and standard WebRTC
 * in browser / test environments.
 */
// Safe import helper: react-native-webrtc requires native C++ WebRTC binaries.
// In Expo Go, native WebRTC is not included, whereas in an Expo Dev Client / prebuild it is available.
let RTCPeerConnection: any;
let RTCIceCandidate: any;
let RTCSessionDescription: any;

try {
  const webrtc = require('react-native-webrtc');
  RTCPeerConnection = webrtc.RTCPeerConnection;
  RTCIceCandidate = webrtc.RTCIceCandidate;
  RTCSessionDescription = webrtc.RTCSessionDescription;
} catch {
  // Fallback for Expo Go or environments without compiled native WebRTC binaries
  if (typeof globalThis !== 'undefined' && (globalThis as any).RTCPeerConnection) {
    RTCPeerConnection = (globalThis as any).RTCPeerConnection;
    RTCIceCandidate = (globalThis as any).RTCIceCandidate;
    RTCSessionDescription = (globalThis as any).RTCSessionDescription;
  }
}

import { SignalingClient } from './signaling';

export class MobileWebRTCConnection {
  private pc: any;
  private dataChannel: any = null;
  private signaling: SignalingClient;
  private pendingCandidates: any[] = [];
  private _onDataChannel: ((dc: any) => void) | null = null;
  public onConnectionStateChange: ((state: string) => void) | null = null;
  private isSender: boolean;
  private signalListener: ((msg: any) => void) | null = null;
  private myDeviceId: string | null = null;

  constructor(signaling: SignalingClient, isSender: boolean, myDeviceId?: string) {
    this.signaling = signaling;
    this.isSender = isSender;
    this.myDeviceId = myDeviceId || null;

    if (!RTCPeerConnection) {
      throw new Error(
        'WebRTC native module is not present in Expo Go. WebRTC DataChannels require an Expo Development Build (npx expo run:android).'
      );
    }

    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' },
      ],
    });

    this.pc.onicecandidate = (event: any) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'signal',
          payload: {
            signal_type: 'ice-candidate',
            data: event.candidate,
          },
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.pc.connectionState);
      }
    };

    if (isSender) {
      this.dataChannel = this.pc.createDataChannel('file-transfer', {
        ordered: true,
      });
      this.dataChannel.binaryType = 'arraybuffer';
    } else {
      this.pc.ondatachannel = (event: any) => {
        this.dataChannel = event.channel;
        this.dataChannel.binaryType = 'arraybuffer';
        if (this._onDataChannel) {
          this._onDataChannel(this.dataChannel);
        }
      };
    }

    // Subscribe to signaling messages directly on this connection instance
    this.subscribeSignaling();
  }

  private subscribeSignaling(): void {
    this.signalListener = (msg: any) => {
      if (msg.payload) {
        if (this.myDeviceId && msg.from === this.myDeviceId) {
          return;
        }
        this.handleSignal(msg.payload);
      }
    };
    this.signaling.on('signal', this.signalListener);
  }

  set onDataChannel(cb: ((dc: any) => void) | null) {
    this._onDataChannel = cb;
    if (cb && this.dataChannel) {
      cb(this.dataChannel);
    }
  }

  get onDataChannel(): ((dc: any) => void) | null {
    return this._onDataChannel;
  }

  async createOffer(): Promise<void> {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signaling.send({
        type: 'signal',
        payload: {
          signal_type: 'offer',
          data: offer,
        },
      });
    } catch (err) {
      console.error('[WEBRTC] createOffer failed', err);
    }
  }

  async handleSignal(signal: { signal_type: string; data: any }): Promise<void> {
    if (signal.signal_type === 'offer') {
      if (this.isSender) {
        console.log('[WEBRTC] Ignoring offer because this connection is sender');
        return;
      }
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signaling.send({
          type: 'signal',
          payload: {
            signal_type: 'answer',
            data: answer,
          },
        });
        await this.flushPendingCandidates();
      } catch (err) {
        console.error('[WEBRTC] Processing OFFER failed', err);
      }
    } else if (signal.signal_type === 'answer') {
      if (!this.isSender) {
        console.log('[WEBRTC] Ignoring answer because this connection is receiver');
        return;
      }
      if (this.pc.signalingState !== 'have-local-offer') {
        console.log(`[WEBRTC] Ignoring answer because signalingState is ${this.pc.signalingState} (expected have-local-offer)`);
        return;
      }
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
        await this.flushPendingCandidates();
      } catch (err) {
        console.error('[WEBRTC] Processing ANSWER failed', err);
      }
    } else if (signal.signal_type === 'ice-candidate') {
      const candidate = signal.data;
      if (!candidate || (!candidate.candidate && candidate.sdpMid === undefined)) {
        return;
      }
      if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('[WEBRTC] Failed to add remote ICE candidate', err);
        }
      } else {
        this.pendingCandidates.push(candidate);
      }
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (candidate) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('[WEBRTC] Failed to add flushed ICE candidate', err);
        }
      }
    }
  }

  getDataChannel(): any | null {
    return this.dataChannel;
  }

  close(): void {
    if (this.signalListener) {
      this.signaling.off('signal', this.signalListener);
      this.signalListener = null;
    }
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {}
      this.dataChannel = null;
    }
    try {
      this.pc.close();
    } catch {}
  }
}
