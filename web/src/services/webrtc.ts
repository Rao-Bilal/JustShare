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
        console.log('[WEBRTC] Local ICE candidate gathered');
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
      console.log(`[WEBRTC] connectionState changed to: ${this.pc.connectionState}`);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.pc.connectionState);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log(`[WEBRTC] iceConnectionState changed to: ${this.pc.iceConnectionState}`);
    };

    if (isSender) {
      this.dataChannel = this.pc.createDataChannel('file-transfer', {
        ordered: true,
      });
      this.dataChannel.binaryType = 'arraybuffer';
      console.log('[WEBRTC] Sender DataChannel created');
    } else {
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.dataChannel.binaryType = 'arraybuffer';
        console.log('[WEBRTC] Receiver DataChannel received');
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
    console.log('[WEBRTC] Creating SDP offer');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    console.log('[WEBRTC] Local description set (offer)');
    this.signaling.send({
      type: 'signal',
      payload: {
        signal_type: 'offer',
        data: offer,
      },
    });
  }

  async handleSignal(signal: { signal_type: string; data: unknown }): Promise<void> {
    console.log(`[WEBRTC] Handling signal: ${signal.signal_type}`);
    if (signal.signal_type === 'offer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(signal.data as RTCSessionDescriptionInit));
      console.log('[WEBRTC] Remote description set (offer)');
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      console.log('[WEBRTC] Local description set (answer)');
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
      console.log('[WEBRTC] Remote description set (answer)');
      await this.flushPendingCandidates();
    } else if (signal.signal_type === 'ice-candidate') {
      const candidate = signal.data as RTCIceCandidateInit;
      if (!candidate || (!candidate.candidate && candidate.sdpMid === undefined)) {
        return;
      }
      if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
        try {
          await this.pc.addIceCandidate(candidate);
          console.log('[WEBRTC] Remote ICE candidate added');
        } catch {
          // ignore candidate error
        }
      } else {
        console.log('[WEBRTC] Remote ICE candidate queued');
        this.pendingCandidates.push(candidate);
      }
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    console.log(`[WEBRTC] Flushing ${this.pendingCandidates.length} pending ICE candidate(s)`);
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
