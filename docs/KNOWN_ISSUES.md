# Known Issues

This document tracks known issues, architectural limitations, and investigative findings identified during development and testing.

### 1. Low Transfer Throughput (~0.8–1.0 MB/s Bottleneck)
- **Symptom**: WebRTC DataChannel transfers run at approximately 12 chunks/second (~0.8–1.0 MB/s) regardless of file size, transport path, or available bandwidth, even between two Chrome windows on the same laptop.
- **Evidence**: Timing breakdown logs show constant throughput limits independent of hardware; sender waits on backpressure drainage and sequential chunk dispatch, while the receiver processes individual chunk storage writes.
- **Suspected Cause**: Conservative backpressure thresholds (`BACKPRESSURE_HIGH_WATERMARK` / `BACKPRESSURE_LOW_WATERMARK`), lack of chunk pipelining / buffering in `FileSender`, and IndexedDB per-chunk transaction write latency on the receiver.

### 2. Mid-Transfer Network Drop & Auto-Recovery Failure
- **Symptom**: Mid-transfer Wi-Fi interruption (toggle off/on) does not automatically recover and resume the active transfer.
- **Evidence**: On network drop, the signaling WebSocket disconnects without an automatic reconnect loop, causing `peer_left` broadcasts or receiver stall timeouts (60s limit) to fire before WebRTC ICE renegotiation can complete.
- **Suspected Cause**: `SignalingClient` lacks automatic WebSocket reconnect and room rejoining logic; the receiver's stall timer is not paused while reconnection attempts are in progress.

### 3. Missing TURN Relay Fallback
- **Symptom**: Direct peer-to-peer WebRTC connections fail to establish when peers are behind symmetric NATs or restrictive enterprise firewalls.
- **Evidence**: `RTCPeerConnection` configuration in `webrtc.ts` only specifies public STUN servers and contains no TURN server configurations or credentials.
- **Suspected Cause**: No TURN relay infrastructure is integrated into the WebRTC connection configuration.
