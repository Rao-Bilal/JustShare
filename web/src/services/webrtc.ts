import { SignalingClient } from './signaling';

export class WebRTCConnection {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private signaling: SignalingClient;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private _onDataChannel: ((dc: RTCDataChannel) => void) | null = null;
  public onConnectionStateChange: ((state: string) => void) | null = null;

  constructor(signaling: SignalingClient, isSender: boolean) {
    this.signaling = signaling;
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' },
      ],
    });

    this.pc.onicecandidate = (event) => {
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
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.dataChannel.binaryType = 'arraybuffer';
        if (this._onDataChannel) {
          this._onDataChannel(this.dataChannel);
        }
      };
    }
  }

  set onDataChannel(cb: ((dc: RTCDataChannel) => void) | null) {
    this._onDataChannel = cb;
    if (cb && this.dataChannel) {
      cb(this.dataChannel);
    }
  }

  get onDataChannel(): ((dc: RTCDataChannel) => void) | null {
    return this._onDataChannel;
  }

  async createOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.send({
      type: 'signal',
      payload: {
        signal_type: 'offer',
        data: offer,
      },
    });
  }

  async handleSignal(signal: { signal_type: string; data: unknown }): Promise<void> {
    if (signal.signal_type === 'offer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(signal.data as RTCSessionDescriptionInit));
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
    } else if (signal.signal_type === 'answer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(signal.data as RTCSessionDescriptionInit));
      await this.flushPendingCandidates();
    } else if (signal.signal_type === 'ice-candidate') {
      const candidate = signal.data as RTCIceCandidateInit;
      if (!candidate || (!candidate.candidate && candidate.sdpMid === undefined)) {
        return;
      }
      if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
        try {
          await this.pc.addIceCandidate(candidate);
        } catch {
          // ignore candidate error
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
          await this.pc.addIceCandidate(candidate);
        } catch {
          // ignore candidate error
        }
      }
    }
  }

  getDataChannel(): RTCDataChannel | null {
    return this.dataChannel;
  }

  close(): void {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    this.pc.close();
  }
}
