import { SignalingClient } from './signaling';

export const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.services.mozilla.com' },
];

export function sanitizeIceServers(turnServers: RTCIceServer[] = []): RTCIceServer[] {
  const filteredTurnServers: RTCIceServer[] = [];

  for (const server of turnServers) {
    if (!server.urls) continue;
    const urlList = Array.isArray(server.urls) ? server.urls : [server.urls];
    // Filter out port 53 TURN URLs
    const safeUrls = urlList.filter((url) => !url.includes(':53') || url.includes(':5349'));
    if (safeUrls.length > 0) {
      filteredTurnServers.push({
        ...server,
        urls: safeUrls.length === 1 ? safeUrls[0] : safeUrls,
      });
    }
  }

  return [...DEFAULT_STUN_SERVERS, ...filteredTurnServers];
}

export class WebRTCConnection {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private signaling: SignalingClient;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private _onDataChannel: ((dc: RTCDataChannel) => void) | null = null;
  public onConnectionStateChange: ((state: string) => void) | null = null;
  public onDataChannelClose: (() => void) | null = null;
  private roleTag: string;

  constructor(signaling: SignalingClient, isSender: boolean, customIceServers?: RTCIceServer[]) {
    this.signaling = signaling;
    this.roleTag = isSender ? 'SEND' : 'RECEIVE';
    console.log(`[WEBRTC][${this.roleTag}] RTCPeerConnection created (isSender=${isSender})`);

    const iceServers = customIceServers ? sanitizeIceServers(customIceServers) : DEFAULT_STUN_SERVERS;

    this.pc = new RTCPeerConnection({
      iceServers,
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[WEBRTC][${this.roleTag}] Local ICE candidate: type=${event.candidate.type} protocol=${event.candidate.protocol} address=${event.candidate.address}`);
        this.signaling.send({
          type: 'signal',
          payload: {
            signal_type: 'ice-candidate',
            data: event.candidate,
          },
        });
      }
    };

    this.pc.onconnectionstatechange = async () => {
      console.log(`[WEBRTC][${this.roleTag}] connectionState changed to: ${this.pc.connectionState}`);
      if (this.pc.connectionState === 'connected') {
        try {
          const stats = await this.pc.getStats();
          stats.forEach((report) => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              const localCand = stats.get(report.localCandidateId);
              const remoteCand = stats.get(report.remoteCandidateId);
              console.log(
                `[WEBRTC][${this.roleTag}][SELECTED_PAIR] local=${localCand?.candidateType || localCand?.type}@${localCand?.ip || localCand?.address}:${localCand?.port} <-> remote=${remoteCand?.candidateType || remoteCand?.type}@${remoteCand?.ip || remoteCand?.address}:${remoteCand?.port}`
              );
            }
          });
        } catch {
          // ignore stats errors
        }
      }
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.pc.connectionState);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log(`[WEBRTC][${this.roleTag}] iceConnectionState changed to: ${this.pc.iceConnectionState}`);
    };

    this.pc.onicegatheringstatechange = () => {
      console.log(`[WEBRTC][${this.roleTag}] iceGatheringState changed to: ${this.pc.iceGatheringState}`);
    };

    if (isSender) {
      this.dataChannel = this.pc.createDataChannel('file-transfer', {
        ordered: true,
      });
      this.dataChannel.binaryType = 'arraybuffer';
      console.log(`[WEBRTC][${this.roleTag}] DataChannel created: file-transfer`);
      this.attachDataChannelListeners(this.dataChannel);
    } else {
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.dataChannel.binaryType = 'arraybuffer';
        console.log(`[WEBRTC][${this.roleTag}] DataChannel received: ${event.channel.label}`);
        this.attachDataChannelListeners(this.dataChannel);
        if (this._onDataChannel) {
          this._onDataChannel(this.dataChannel);
        }
      };
    }
  }

  private attachDataChannelListeners(dc: RTCDataChannel) {
    dc.onopen = () => {
      console.log(`[WEBRTC][${this.roleTag}] DataChannel state=open`);
    };
    dc.onclose = () => {
      console.log(`[WEBRTC][${this.roleTag}] DataChannel state=closed`);
      if (this.onDataChannelClose) {
        this.onDataChannelClose();
      }
    };
    dc.onerror = (event) => {
      console.error(`[WEBRTC][${this.roleTag}] DataChannel error`, event);
      if (this.onDataChannelClose) {
        this.onDataChannelClose();
      }
    };
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
    try {
      console.log(`[WEBRTC][${this.roleTag}] createOffer() starting`);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      console.log(`[WEBRTC][${this.roleTag}] setLocalDescription(offer) succeeded`);
      this.signaling.send({
        type: 'signal',
        payload: {
          signal_type: 'offer',
          data: offer,
        },
      });
      console.log(`[SIGNAL][${this.roleTag}] OFFER sent over signaling`);
    } catch (err) {
      console.error(`[WEBRTC][${this.roleTag}] createOffer failed`, err);
    }
  }

  async handleSignal(signal: { signal_type: string; data: unknown }): Promise<void> {
    console.log(`[WEBRTC][${this.roleTag}] handleSignal received: ${signal.signal_type}`);
    if (signal.signal_type === 'offer') {
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(signal.data as RTCSessionDescriptionInit));
        console.log(`[WEBRTC][${this.roleTag}] setRemoteDescription(offer) succeeded`);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        console.log(`[WEBRTC][${this.roleTag}] setLocalDescription(answer) succeeded`);
        this.signaling.send({
          type: 'signal',
          payload: {
            signal_type: 'answer',
            data: answer,
          },
        });
        console.log(`[SIGNAL][${this.roleTag}] ANSWER sent over signaling`);
        await this.flushPendingCandidates();
      } catch (err) {
        console.error(`[WEBRTC][${this.roleTag}] Processing OFFER failed`, err);
      }
    } else if (signal.signal_type === 'answer') {
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(signal.data as RTCSessionDescriptionInit));
        console.log(`[WEBRTC][${this.roleTag}] setRemoteDescription(answer) succeeded`);
        await this.flushPendingCandidates();
      } catch (err) {
        console.error(`[WEBRTC][${this.roleTag}] Processing ANSWER failed`, err);
      }
    } else if (signal.signal_type === 'ice-candidate') {
      const candidate = signal.data as RTCIceCandidateInit;
      if (!candidate || (!candidate.candidate && candidate.sdpMid === undefined)) {
        return;
      }
      if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
          console.log(`[WEBRTC][${this.roleTag}] Remote ICE candidate added successfully`);
        } catch (err) {
          console.error(`[WEBRTC][${this.roleTag}] Failed to add remote ICE candidate`, err);
        }
      } else {
        console.log(`[WEBRTC][${this.roleTag}] Remote ICE candidate queued (remoteDescription not ready)`);
        this.pendingCandidates.push(candidate);
      }
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    console.log(`[WEBRTC][${this.roleTag}] Flushing ${this.pendingCandidates.length} pending ICE candidate(s)`);
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (candidate) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
          console.log(`[WEBRTC][${this.roleTag}] Flushed ICE candidate added successfully`);
        } catch (err) {
          console.error(`[WEBRTC][${this.roleTag}] Failed to add flushed ICE candidate`, err);
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
