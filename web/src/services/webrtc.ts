import { SignalingClient } from './signaling';

export class WebRTCConnection {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private signaling: SignalingClient;
  public onDataChannel: ((dc: RTCDataChannel) => void) | null = null;
  public onConnectionStateChange: ((state: string) => void) | null = null;

  constructor(signaling: SignalingClient, isSender: boolean) {
    this.signaling = signaling;
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
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
      if (this.onDataChannel) {
        this.onDataChannel(this.dataChannel);
      }
    } else {
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        if (this.onDataChannel) {
          this.onDataChannel(this.dataChannel);
        }
      };
    }
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
    } else if (signal.signal_type === 'answer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(signal.data as RTCSessionDescriptionInit));
    } else if (signal.signal_type === 'ice-candidate') {
      await this.pc.addIceCandidate(new RTCIceCandidate(signal.data as RTCIceCandidateInit));
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
